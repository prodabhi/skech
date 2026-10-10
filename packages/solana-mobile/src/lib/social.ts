import { useSyncExternalStore } from "react";
import {
  applyFeed,
  type DrawingAudience,
  EMPTY_FEED,
  type FeedState,
  feedProfile,
  PEN_EXPIRE_MS,
  type PenIn,
  type PenOut,
  type PenStart,
  penPack,
  penUnpack,
  type PlayerProfile,
  remoteDrawings as remoteOf,
  type SocialAction,
  type SocialActivity,
  type SocialChallenge,
  type SocialMessage,
  socialSocketUrl,
  socialUrl,
  type StrokeBody,
  visibleDrawings,
} from "@skech/core/social";
import { RELAYER_URL } from "./config";
import { readJson, storage, writeJson } from "./storage";

export { socialMoney, type DrawingAudience } from "@skech/core/social";

/**
 * The community, from the social service: the web's lib/social.ts, the same protocol and the same reading of the
 * feed (applyFeed in @skech/core/social), so a line drawn here shows on the web and the other way round. The feed
 * lives outside React: the stage reads it each frame, and only the screens that show it subscribe.
 *
 * The service is beside the relayer (https://api.skech.trade/social); EXPO_PUBLIC_SOCIAL_URL says otherwise, for a
 * service on a laptop reached through a tunnel. A phone sends no Origin: it may read, and changes only what its
 * wallet signs.
 */
export const SOCIAL_URL = socialUrl(RELAYER_URL, process.env.EXPO_PUBLIC_SOCIAL_URL);

/** A placed piece's stroke, the exact bytes the relayer took, for everyone else's chart. Nothing waits on it. */
export function publishStroke(betId: string, stroke: string) {
  const body: StrokeBody = { betId, stroke };
  void fetch(`${SOCIAL_URL}/stroke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

export async function socialRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${SOCIAL_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not load this right now");
  return result as T;
}

/** A change only the wallet may make: asked for, signed, and sent with the same payload. */
export async function socialAction<T>(player: string, action: SocialAction, payload: unknown, sign: (message: string) => Promise<string>) {
  const challenge = await socialRequest<SocialChallenge>("/challenge", { player, action, payload });
  const signature = await sign(challenge.message);
  return socialRequest<T>(`/${action}`, { token: challenge.token, payload, signature });
}

let current: FeedState = EMPTY_FEED;
const listeners = new Set<() => void>();
const activityListeners = new Set<(activity: SocialActivity) => void>();
/** The stage reads `current` at once; React hears of it at most once a frame, however many messages came. */
let told = 0;
function publish(next: FeedState) {
  current = next;
  if (told) return;
  told = requestAnimationFrame(() => {
    told = 0;
    for (const listener of listeners) listener();
  });
}
/** A profile as it now is, everywhere it shows: after "Edit profile" saves, with no reload. */
export function cacheProfile(profile: PlayerProfile) {
  publish(feedProfile(current, profile));
}
export const socialSnapshot = () => current;
export const onSocialActivity = (listener: (activity: SocialActivity) => void) => {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** For screens that show the feed. The game screen does not use it: the stage reads `remoteDrawings()` per frame. */
export const useSocial = () => useSyncExternalStore(subscribe, socialSnapshot, () => EMPTY_FEED);
/** One thing from the feed (a count, a profile): the component renders again only when that changes. */
export function useSocialPick<T>(pick: (s: FeedState) => T): T {
  return useSyncExternalStore(subscribe, () => pick(current), () => pick(EMPTY_FEED));
}

/** The app's one stream: reconnects with a growing, jittered wait, as the relayer's socket does. */
export function connectSocial() {
  let stopped = false, socket: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | null = null, backoff = 500, openedAt = 0;
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(socialSocketUrl(SOCIAL_URL));
    socket = ws;
    ws.onopen = () => {
      openedAt = Date.now();
      publish({ ...current, connected: true });
      if (penPlayer) bindAgain(ws);
    };
    ws.onmessage = (event) => {
      let message: SocialMessage | PenIn;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "pen" || message.type === "pen-end" || message.type === "bound" || message.type === "unbound") return heardPen(message);
      publish(applyFeed(current, message));
      if (message.type === "drawing") confirmed(message.drawing.player, message.drawing.pieces);
      if (message.type === "drawing" && message.activity) for (const listener of activityListeners) listener(message.activity);
    };
    ws.onclose = () => {
      if (socket !== ws || stopped) return;
      publish({ ...current, connected: false });
      if (openedAt && Date.now() - openedAt > 10_000) backoff = 500;
      retry = setTimeout(connect, backoff / 2 + (Math.random() * backoff) / 2);
      backoff = Math.min(15_000, backoff * 2);
    };
    ws.onerror = () => ws.close();
  };
  connect();
  liveSocket = () => (socket?.readyState === WebSocket.OPEN ? socket : null);
  return () => {
    stopped = true;
    liveSocket = () => null;
    if (retry) clearTimeout(retry);
    socket?.close();
    publish({ ...current, connected: false });
  };
}

let audience: DrawingAudience = "everyone";
let viewer: string | null = null;
let following = new Set<string>();
export function setSocialViewer(player: string | null, targets: string[]) {
  viewer = player;
  following = new Set(targets);
}
export function setDrawingAudience(value: DrawingAudience) {
  audience = value;
}
/** Other players' drawings on the chart now. */
export const remoteDrawings = () => remoteOf(current, viewer, audience, following);
/** Every drawing the chart may label, the viewer's own included. */
export const visibleSocialDrawings = () => visibleDrawings(current, viewer, audience, following);

/* ---- the spotlight: one player's ink brought forward, everyone else's pushed back ---- */

/** Who is in the spotlight. Out here, not in React: the canvas reads it every frame. */
let focus: string | null = null;
const watchers = new Set<() => void>();
export const focusedPlayer = () => focus;
/** Light one player's ink, or let the chart go back to everyone. The same player again releases it. */
export function focusPlayer(player: string | null) {
  const next = player === focus ? null : player;
  if (next === focus) return;
  focus = next;
  for (const w of watchers) w();
}
const watchFocus = (fn: () => void) => {
  watchers.add(fn);
  return () => void watchers.delete(fn);
};
/** The spotlight, for the parts of the app that are not the canvas. */
export const useFocusedPlayer = () => useSyncExternalStore(watchFocus, focusedPlayer, () => null);

/* ---- the live pen: strokes as they are drawn, everyone's, display only (never money) ---- */

let liveSocket: () => WebSocket | null = () => null;
const sendOut = (m: PenOut) => liveSocket()?.send(JSON.stringify(m));

/** Who this socket draws for, once their wallet has signed for it (a ticket keeps it for a day). */
let penPlayer: string | null = null;
let penReady = false;
/** Whether others see this player's pen now. */
export const penBound = () => penReady;
const TICKET = "skech:social:pen-ticket";
const readTicket = (player: string) => {
  const t = readJson<{ player: string; ticket: string }>(TICKET);
  return t?.player === player ? t.ticket : null;
};
let signer: ((message: string) => Promise<string>) | null = null;
/**
 * Let this player's live pen be seen: signed once (no prompt with Privy; a wallet on the phone asks once), then a
 * ticket for a day. Null signs out.
 */
export function bindPen(player: string | null, sign: ((message: string) => Promise<string>) | null) {
  penPlayer = player;
  signer = sign;
  penReady = false;
  const ws = liveSocket();
  if (ws && player) bindAgain(ws);
}
function bindAgain(ws: WebSocket) {
  const player = penPlayer;
  if (!player) return;
  const ticket = readTicket(player);
  if (ticket) return ws.send(JSON.stringify({ type: "bind", ticket } satisfies PenOut));
  void signed(ws, player);
}
async function signed(ws: WebSocket, player: string) {
  if (!signer) return;
  try {
    const challenge = await socialRequest<SocialChallenge>("/challenge", { player, action: "pen", payload: {} });
    const signature = await signer(challenge.message);
    if (penPlayer === player && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "bind", token: challenge.token, payload: {}, signature } satisfies PenOut));
  } catch {
    /* Watching still works; this player's pen just is not seen live. */
  }
}

/** Another player's stroke as it is drawn. `shown`: how many of its points are drawn yet, catching up smoothly. */
export type LivePen = PenStart & { key: string; player: string; profile: PlayerProfile | null; pts: { t: number; p: number }[]; at: number; ended: boolean; shown: number };
const pens = new Map<string, LivePen>();
function heardPen(m: PenIn) {
  if (m.type === "bound") {
    penReady = m.player === penPlayer;
    if (m.ticket) writeJson(TICKET, { player: m.player, ticket: m.ticket });
    return;
  }
  if (m.type === "unbound") {
    // A ticket from before the service restarted: sign again.
    storage.delete(TICKET);
    const ws = liveSocket();
    if (ws && penPlayer) void signed(ws, penPlayer);
    return;
  }
  const key = `${m.player}:${m.id}`;
  const now = performance.now();
  if (m.type === "pen-end") {
    const p = pens.get(key);
    if (p) Object.assign(p, { ended: true, at: now });
    return;
  }
  let p = pens.get(key);
  if (m.seq === 0 && m.t0 !== undefined && m.p0 !== undefined && m.rt !== undefined && m.rp !== undefined) {
    if (pens.size >= 50) pens.delete(pens.keys().next().value!);
    pens.set(key, (p = { key, player: m.player, profile: m.profile ?? null, t0: m.t0, p0: m.p0, rt: m.rt, rp: m.rp, pts: [], at: now, ended: false, shown: 0 }));
  }
  if (!p) return;
  p.pts.push(...penUnpack(m.pts));
  p.at = now;
}
/** A drawing's placed pieces came: the faint line of a pen that has lifted gives way to them. */
function confirmed(player: string, pieces: { stroke: { t0: number } | null }[]) {
  for (const [key, p] of pens) if (p.player === player && p.ended && pieces.some((q) => q.stroke && Math.abs(q.stroke.t0 - p.t0) <= 2)) pens.delete(key);
}
/** Others' strokes being drawn now, for the canvas; those quiet for PEN_EXPIRE_MS are let go. */
export function livePens(): LivePen[] {
  const now = performance.now();
  for (const [key, p] of pens) if (now - p.at > PEN_EXPIRE_MS) pens.delete(key);
  return pens.size ? [...pens.values()] : [];
}

/**
 * This player's pen, sent as it draws: the canvas calls `penFlush` about ten times a second while the pen is down
 * (never on a pointer move) with the stroke so far, and `penLift` when it is up. Only the new points go.
 */
const outgoing = { id: "", seq: 0, sent: 0 };
export function penFlush(id: string, stroke: PenStart & { pts: readonly { t: number; p: number }[] }) {
  if (!penReady || !liveSocket()) return;
  if (outgoing.id !== id) Object.assign(outgoing, { id, seq: 0, sent: 0 });
  const fresh = stroke.pts.slice(outgoing.sent, outgoing.sent + 200);
  if (!fresh.length) return;
  const m: PenOut = outgoing.seq === 0 ? { type: "pen", id, seq: 0, pts: penPack(fresh), t0: Math.round(stroke.t0), p0: stroke.p0, rt: stroke.rt, rp: stroke.rp } : { type: "pen", id, seq: outgoing.seq, pts: penPack(fresh) };
  sendOut(m);
  outgoing.seq++;
  outgoing.sent += fresh.length;
}
export function penLift(id: string) {
  if (outgoing.id === id && outgoing.seq > 0) sendOut({ type: "pen-end", id });
  if (outgoing.id === id) outgoing.id = "";
}

/**
 * The social service, in a worker of its own so nothing it does holds up a drawing: HTTP and a WebSocket on
 * 127.0.0.1:SOCIAL_PORT (3105), behind Caddy's /social/*. The relayer tells it what it placed and settled
 * (bridge.ts); the chain tells it the rest (solana-indexer.ts).
 *
 *   GET  /health, /leaderboard, /identity, /profile, /following, /drawing, /avatar
 *   POST /challenge, then /profile or /follow with the wallet's signature (auth.ts)
 *   POST /stroke  a placed piece's stroke, from the player's app: kept if it hashes to the chain's stroke hash
 *   WS   /ws   a snapshot of the live feed, then each drawing as it changes
 *
 * Without SOCIAL_DATABASE_URL it does nothing; with a database that is down it answers 503 and tries again, and the
 * game never waits for it.
 */
import type { Server, ServerWebSocket } from "bun";
import { decodeStroke } from "@skech/core/chain";
import { avatarSeedProblem, cleanBio, PEN_POINTS_PER_STROKE, PEN_STROKES_OPEN, type PenIn, type PenOut, penProblem, socialWindows, STROKE_BYTES, usernameProblem, type PlayerProfile, type PublicDrawing, type SocialActivity, type SocialMessage, type SocialWindow } from "@skech/core/social";
import { Bucket, clientIp, Door, remember } from "../limits";
import { AVATAR_BYTES, avatarHeaders, parseAvatar } from "./avatar";
import { Challenges, isPlayer, Unauthorized } from "./auth";
import { LiveBook } from "./live";
import { Presence } from "./presence";
import { SolanaIndexer, type IndexerConfig } from "./solana-indexer";
import { SocialStore, type Placement, type Settlement } from "./store";

declare const self: Worker;
const log = (message: string) => self.postMessage({ log: message });

/** The largest request: an avatar's data URL and the rest of a profile. */
const BODY_BYTES = Math.ceil(AVATAR_BYTES / 3) * 4 + 8 * 1024;
/** Updates from the relayer waiting on the database: past this, they are dropped and the indexer recovers them. */
const MOST_WAITING = 5_000;
const SNAPSHOT_BUFFER = 500;
/** Strokes sent before their placement is read from the chain: kept this long, at most this many. */
const STROKE_WAIT_MS = 30_000;
const STROKES_WAITING = 2_000;

let store: SocialStore | null = null;
let challenges: Challenges | null = null;
let indexer: SolanaIndexer | null = null;
let counting = true, progress = 0;
let activity: SocialActivity[] = [];
const presence = new Presence();
const strokes = new Map<string, { stroke: string; at: number }>();
const clients = new Set<ServerWebSocket<Socket>>();
const door = new Door(2_000, 8);
/** `player`: whose live pen this socket may send, once bound; `pens`: its strokes in the air, points sent and when. */
type Socket = { ip: string; local: boolean; buffer: string[] | null; player: string | null; pens: Map<string, { n: number; at: number }>; rate: Bucket };

/* ---- how much one address, and one wallet, may ask ---- */
const byIp = new Map<string, { read: Bucket; write: Bucket }>();
const byPlayer = new Map<string, Bucket>();
function allowed(ip: string, write: boolean) {
  let b = byIp.get(ip);
  if (!b) remember(byIp, ip, (b = { read: new Bucket(120, 10), write: new Bucket(20, 0.5) }), 20_000);
  return write ? b.write.take() : b.read.take();
}
/** Strokes come as fast as pieces do while someone draws: a bucket of their own, as the relayer's for pieces. */
const strokeRates = new Map<string, Bucket>();
function allowedStroke(ip: string) {
  let b = strokeRates.get(ip);
  if (!b) remember(strokeRates, ip, (b = new Bucket(60, 20)), 20_000);
  return b.take();
}
function allowedPlayer(player: string) {
  let b = byPlayer.get(player);
  if (!b) remember(byPlayer, player, (b = new Bucket(10, 1 / 6)), 20_000);
  return b.take();
}

const origins = new Set((process.env.SOCIAL_ALLOWED_ORIGINS ?? "http://localhost:3101,http://127.0.0.1:3101").split(",").map((s) => s.trim()).filter(Boolean));

/* ---- the live feed ---- */
function send(ws: ServerWebSocket<Socket>, text: string) {
  if (ws.data.buffer) {
    if (ws.data.buffer.length >= SNAPSHOT_BUFFER) ws.close(1013, "Reconnect for a fresh snapshot");
    else ws.data.buffer.push(text);
  } else if (ws.send(text) === -1) ws.close(1013, "Reconnect for a fresh snapshot");
}
const broadcast = (message: SocialMessage) => {
  const text = JSON.stringify(message);
  for (const ws of clients) send(ws, text);
};
function changed(drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) {
  if (!drawing || !store) return;
  const item = store.activity(drawing, kind, event);
  activity = [item, ...activity.filter((a) => a.id !== item.id)].slice(0, 60);
  broadcast({ type: "drawing", drawing, activity: item });
  presence.saw(drawing, kind);
  tellPresence();
  // A stroke that came in while this placement was being read: kept now.
  if (kind === "placed") for (const piece of drawing.pieces) if (!piece.stroke && strokes.has(piece.betId)) void fill(piece.betId);
}
async function fill(bet: string) {
  const stroke = strokeFor(bet);
  if (!stroke || !store) return;
  const now = book.stroke(bet, stroke);
  if (now) broadcast({ type: "drawing", drawing: now });
  const { drawing } = await store.stroke(bet, stroke).catch(() => ({ drawing: null }));
  if (drawing && !now) broadcast({ type: "drawing", drawing });
}

/* ---- news from memory: the drawings in play (live.ts), and the profiles of who is drawing ---- */
const book = new LiveBook();
const profiles = new Map<string, PlayerProfile>();
const loading = new Set<string>();
const blank = (player: string): PlayerProfile => ({ player, username: null, bio: "", avatar: false, avatarSeed: null, joinedAt: 0, followers: 0, following: 0 });
/** A player's profile as known now; read from the database once, and told to the apps if it says more. */
function profileOf(player: string): PlayerProfile {
  const known = profiles.get(player);
  if (known) return known;
  const now = blank(player);
  remember(profiles, player, now, 5_000);
  if (store && !loading.has(player) && loading.size < 500) {
    loading.add(player);
    void store
      .profile(player)
      .then((p) => {
        remember(profiles, player, p, 5_000);
        if (p.username || p.avatar || p.avatarSeed) learned(p);
      }, () => profiles.delete(player))
      .finally(() => loading.delete(player));
  }
  return now;
}
/** A profile, new or changed, everywhere it shows. */
function learned(profile: PlayerProfile) {
  remember(profiles, profile.player, profile, 5_000);
  book.profile(profile);
  presence.profile(profile);
  broadcast({ type: "profile", profile });
  tellPresence();
}
/** A placement or settlement heard: told at once if the drawing is in memory. */
function live(e: { placement: Placement } | { settlement: Settlement }, event: string): boolean {
  if (!store) return false;
  if ("placement" in e) {
    const d = book.placed(e.placement, profileOf(e.placement.player));
    if (d) changed(d, "placed", event);
    return d !== null || book.has(e.placement.betId);
  }
  if (!book.has(e.settlement.betId)) return false;
  const d = book.settled(e.settlement);
  if (d) changed(d, "settled", event);
  return true;
}
/** Who is playing, to every app, when it changes. */
function tellPresence() {
  const playing = presence.changed();
  if (playing) broadcast({ type: "presence", playing });
}
/** A stroke waiting for its placement, given to the indexer as it reads it. */
function strokeFor(bet: string) {
  const w = strokes.get(bet);
  if (!w) return undefined;
  strokes.delete(bet);
  return Date.now() - w.at <= STROKE_WAIT_MS ? w.stroke : undefined;
}
function status(next: boolean, fraction: number) {
  if (counting === next && Math.abs(progress - fraction) < 0.01) return;
  counting = next;
  progress = fraction;
  broadcast({ type: "status", counting, progress });
}
/** What `p` gives within `ms`, or `fallback` (also if it fails). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), Bun.sleep(ms).then(() => fallback)]);
}
/** The feed's first look, made at most once a second however many connect at once. */
let snapshot: { at: number; text: Promise<string> } | null = null;
function snapshotText() {
  if (!snapshot || Date.now() - snapshot.at > 1000) {
    // What happened since this service started, then the newest from the database: the history read from the
    // chain is never news as it arrives, but a feed opened after it should still show it.
    // A slow or failing database never keeps the feed from opening: memory is enough to start.
    const text = Promise.all([within(store!.live(), 3000, [] as PublicDrawing[]), within(store!.recent(30), 3000, [] as SocialActivity[])]).then(([stored, recent]) => {
      // Memory is ahead of the database: its drawings win.
      const fresh = book.recent();
      const ids = new Set(fresh.map((d) => d.id));
      const drawings = [...fresh, ...stored.filter((d) => !ids.has(d.id))].slice(0, 80);
      const told = new Set(activity.map((a) => a.drawing));
      const merged = [...activity, ...recent.filter((a) => !told.has(a.drawing))].sort((a, b) => b.at - a.at).slice(0, 60);
      return JSON.stringify({ type: "snapshot", drawings, activity: merged, playing: presence.list(), counting, progress } satisfies SocialMessage);
    });
    snapshot = { at: Date.now(), text };
    text.catch(() => {
      snapshot = null;
    });
  }
  return snapshot.text;
}

/* ---- the live pen: strokes as they are drawn, passed on to everyone else, kept nowhere ---- */
const PEN_STALE_MS = 30_000;
function pen(ws: ServerWebSocket<Socket>, raw: string | Buffer) {
  if (!ws.data.rate.take()) return;
  let m: PenOut;
  try {
    m = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return;
  }
  if (!m || typeof m !== "object") return;
  const d = ws.data;
  if (m.type === "bind") {
    let player: string | null = null;
    // The standalone service's test players (SOCIAL_TEST_PLAYS), from this machine only: no wallet to sign with.
    if (testPlays && m.test && d.local && isPlayer(m.test)) {
      d.player = m.test;
      ws.send(JSON.stringify({ type: "bound", player: m.test, ticket: "" } satisfies PenIn));
      return;
    }
    try {
      player = challenges ? (m.ticket ? challenges.ticketPlayer(m.ticket) : (() => {
        const signed = challenges!.take(m.token, m.payload ?? null, m.signature);
        return signed.action === "pen" ? signed.player : null;
      })()) : null;
    } catch (e) {
      ws.send(JSON.stringify({ type: "unbound", error: String((e as Error).message ?? e).slice(0, 120) } satisfies PenIn));
      return;
    }
    if (!player) {
      ws.send(JSON.stringify({ type: "unbound", error: "Please sign again" } satisfies PenIn));
      return;
    }
    d.player = player;
    ws.send(JSON.stringify({ type: "bound", player, ticket: challenges!.ticket(player) } satisfies PenIn));
    return;
  }
  // Watching needs nothing; drawing for everyone needs a player.
  if (!d.player || penProblem(m)) return;
  const now = Date.now();
  for (const [id, s] of d.pens) if (now - s.at > PEN_STALE_MS) d.pens.delete(id);
  const player = d.player;
  let out: PenIn;
  if (m.type === "pen-end") {
    if (!d.pens.delete(m.id)) return;
    out = { type: "pen-end", player, id: m.id };
  } else if (m.type === "pen") {
    let s = d.pens.get(m.id);
    if (!s) {
      if (m.seq !== 0) return;
      // At most a few strokes in the air: the oldest is let go.
      while (d.pens.size >= PEN_STROKES_OPEN) d.pens.delete(d.pens.keys().next().value!);
      d.pens.set(m.id, (s = { n: 0, at: now }));
      presence.placed(player, profileOf(player));
      tellPresence();
    }
    s.n += m.pts.length / 2;
    s.at = now;
    if (s.n > PEN_POINTS_PER_STROKE) return;
    out = m.seq === 0 ? { type: "pen", player, id: m.id, seq: 0, pts: m.pts, t0: m.t0, p0: m.p0, rt: m.rt, rp: m.rp, profile: profileOf(player) } : { type: "pen", player, id: m.id, seq: m.seq, pts: m.pts };
  } else return;
  const text = JSON.stringify(out);
  for (const other of clients) if (other !== ws) send(other, text);
}

/* ---- requests ---- */
class Refusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
const windowOf = (url: URL): SocialWindow => {
  const v = url.searchParams.get("window");
  return socialWindows.includes(v as SocialWindow) ? (v as SocialWindow) : "all";
};
function playerParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (!v) return null;
  if (!isPlayer(v)) throw new Refusal("Invalid player");
  return v;
}
/** A profile change as asked: checked the same before the challenge and after the signature. */
function profileChange(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Refusal("Choose a username");
  const p = payload as Record<string, unknown>;
  const problem = usernameProblem(p.username);
  if (problem) throw new Refusal(problem);
  let bio: string;
  try {
    bio = cleanBio(p.bio ?? "");
  } catch (e) {
    throw new Refusal((e as Error).message);
  }
  let image: ReturnType<typeof parseAvatar> | null | undefined;
  try {
    image = p.image === undefined ? undefined : p.image === null ? null : parseAvatar(p.image);
  } catch (e) {
    throw new Refusal((e as Error).message);
  }
  if (p.avatarSeed !== undefined) {
    const seedProblem = avatarSeedProblem(p.avatarSeed);
    if (seedProblem) throw new Refusal(seedProblem);
  }
  return { username: p.username as string, bio, image, avatarSeed: p.avatarSeed as string | null | undefined };
}
function followChange(player: string, payload: unknown) {
  const p = payload as { target?: unknown; enabled?: unknown } | null;
  if (!p || !isPlayer(p.target) || typeof p.enabled !== "boolean" || p.target === player) throw new Refusal("Invalid follow");
  return { target: p.target, enabled: p.enabled };
}

async function get(url: URL): Promise<Response> {
  const s = store!;
  switch (url.pathname) {
    case "/leaderboard": {
      const viewer = playerParam(url, "viewer");
      const rows = await s.board(windowOf(url), viewer, url.searchParams.get("friends") === "1" && viewer !== null);
      return Response.json({ rows: rows.slice(0, 100), me: rows.find((r) => r.profile.player === viewer) ?? null, counting, progress });
    }
    case "/identity": {
      const player = playerParam(url, "player");
      if (!player) break;
      return Response.json({ profile: await s.profile(player) });
    }
    case "/profile": {
      const player = playerParam(url, "player");
      if (!player) break;
      const cursor = url.searchParams.get("cursor");
      if (cursor && cursor.length > 200) throw new Refusal("Invalid history cursor");
      try {
        return Response.json(await s.details(player, windowOf(url), playerParam(url, "viewer"), cursor));
      } catch (e) {
        if ((e as Error).message === "Invalid history cursor") throw new Refusal("Invalid history cursor");
        throw e;
      }
    }
    case "/following": {
      const player = playerParam(url, "player");
      if (!player) break;
      return Response.json({ players: await s.following(player) });
    }
    case "/drawing": {
      const id = url.searchParams.get("id") ?? "";
      const [player, n, extra] = id.split(":");
      if (!isPlayer(player) || !/^\d{1,20}$/.test(n ?? "") || extra !== undefined) throw new Refusal("Invalid drawing");
      return Response.json({ drawing: await s.drawing(id) });
    }
    case "/avatar": {
      const player = playerParam(url, "player");
      if (!player) break;
      const a = await s.avatar(player);
      if (!a) return new Response(null, { status: 404, headers: { "x-content-type-options": "nosniff" } });
      return new Response(Buffer.from(a.bytes), { headers: avatarHeaders(a.mime) });
    }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function post(req: Request, url: URL, ip: string, local: boolean): Promise<Response> {
  const s = store!, c = challenges!;
  if (Number(req.headers.get("content-length") ?? 0) > BODY_BYTES) throw new Refusal("Request too large", 413);
  const raw = await req.text();
  if (raw.length > BODY_BYTES) throw new Refusal("Request too large", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Refusal("Invalid request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refusal("Invalid request");
  if (url.pathname === "/challenge") {
    const { player, action, payload } = body;
    if (!isPlayer(player) || (action !== "profile" && action !== "follow" && action !== "pen")) throw new Refusal("Invalid action");
    if (action === "profile") profileChange(payload);
    else if (action === "follow") followChange(player, payload);
    // A live pen's binding says nothing but who: its payload is empty.
    else if (payload !== null && (typeof payload !== "object" || Object.keys(payload as object).length)) throw new Refusal("Invalid action");
    return Response.json(c.issue(player, action, payload));
  }
  if (url.pathname === "/test/placed" && testPlays && !req.headers.get("origin") && local) {
    // A play made up for testing (standalone, SOCIAL_TEST_PLAYS=1): told as a placement read from the chain would
    // be, in memory only. Its stroke then comes over /stroke like any other, checked against strokeHash.
    const b = body as { player?: unknown; drawing?: unknown; betId?: unknown; openAt?: unknown; strokeHash?: unknown; unit?: unknown; sections?: unknown };
    if (!isPlayer(b.player) || !isPlayer(b.betId) || typeof b.strokeHash !== "string" || !Array.isArray(b.sections)) throw new Refusal("Invalid test play");
    const sections = (b.sections as { second: number; lo: string; hi: string; stake: string; rung: number }[]).map((x) => ({ second: Number(x.second), lo: String(x.lo), hi: String(x.hi), stake: String(x.stake), rung: Number(x.rung) }));
    const placement: Placement = { betId: b.betId, player: b.player, drawing: String(b.drawing ?? Date.now()), openAt: BigInt(Number(b.openAt ?? Date.now())), staked: sections.reduce((n, x) => n + BigInt(x.stake), 0n), unit: BigInt(String(b.unit ?? "1000000")), strokeHash: b.strokeHash, stroke: strokeFor(b.betId), sections, tx: `test:${b.betId}` };
    live({ placement }, `test:${b.betId}`);
    return Response.json({ ok: true, at: Date.now() });
  }
  if (url.pathname === "/stroke") {
    const { betId, stroke } = body;
    if (!isPlayer(betId) || typeof stroke !== "string" || stroke.length > 2 + STROKE_BYTES * 2 || !/^0x([0-9a-f]{2})+$/i.test(stroke)) throw new Refusal("Invalid stroke");
    try {
      const d = decodeStroke(stroke as `0x${string}`);
      if (!d.pts.length || !(d.rt > 0) || !(d.rp > 0) || d.pts.some((q) => !Number.isFinite(q.t) || !Number.isFinite(q.p))) throw new Error();
    } catch {
      throw new Refusal("Invalid stroke");
    }
    // In play: drawn on everyone's chart now, written after.
    const now = book.stroke(betId, stroke);
    if (now) {
      broadcast({ type: "drawing", drawing: now });
      void s.stroke(betId, stroke).catch(() => undefined);
      return Response.json({ ok: true });
    }
    // Not in memory: an older piece, or one the chain has not told yet. The database decides, if it answers soon;
    // else the stroke waits for its placement like any other.
    const { result, drawing } = await within(s.stroke(betId, stroke), 3000, { result: "unknown" as const, drawing: null });
    if (result === "unknown") {
      // Its placement is not read yet: it waits for it, a short while.
      if (strokes.size >= STROKES_WAITING) for (const [k, w] of strokes) if (Date.now() - w.at > STROKE_WAIT_MS) strokes.delete(k);
      if (strokes.size >= STROKES_WAITING) throw new Refusal("Please slow down", 429);
      if (!strokes.has(betId)) strokes.set(betId, { stroke, at: Date.now() });
      return Response.json({ ok: true, waiting: true }, { status: 202 });
    }
    if (result === "mismatch") throw new Refusal("Not this bet's stroke");
    if (drawing) broadcast({ type: "drawing", drawing });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/profile" || url.pathname === "/follow") {
    const action = url.pathname.slice(1);
    const signed = c.take(body.token, body.payload, body.signature);
    if (signed.action !== action) throw new Unauthorized("Please sign again");
    if (!allowedPlayer(signed.player)) throw new Refusal("Please slow down", 429);
    if (action === "profile") {
      const p = profileChange(body.payload);
      const profile = await s.edit(signed.player, p.username, p.bio, p.image, p.avatarSeed);
      learned(profile);
      log(`profile ${signed.player.slice(0, 6)}… from ${ip.slice(0, 64)}`);
      return Response.json({ profile } satisfies { profile: PlayerProfile });
    }
    const f = followChange(signed.player, body.payload);
    await s.follow(signed.player, f.target, f.enabled);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

function serve(port: number) {
  return Bun.serve<Socket, never>({
    port,
    // This machine only, behind Caddy; SOCIAL_HOST=0.0.0.0 to reach it from a phone on the same network.
    hostname: process.env.SOCIAL_HOST || "127.0.0.1",
    maxRequestBodySize: BODY_BYTES,
    async fetch(req, server: Server<Socket>) {
      const sent = req.headers.get("origin");
      // React Native on Android names the socket's own server as its Origin. No page is served from this host, so
      // that Origin is the app's, and counts as none.
      const host = req.headers.get("host");
      const origin = sent && host && (sent === `https://${host}` || sent === `http://${host}`) ? null : sent;
      // A page from anywhere else is refused outright. No Origin at all is a request no browser page made: it may
      // read, and may change something only with a wallet's signature, which every change needs.
      if (origin && !origins.has(origin)) return new Response("Origin not allowed", { status: 403 });
      const headers = new Headers({ vary: "Origin", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (origin) headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set("access-control-allow-headers", "Content-Type");
      headers.set("access-control-max-age", "600");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const peer = server.requestIP(req)?.address;
      const ip = clientIp(req, peer);
      // This machine itself, not something a proxy or tunnel on it passed on (they say whom for).
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") && !req.headers.has("x-forwarded-for") && !req.headers.has("cf-connecting-ip") && !req.headers.has("forwarded");
      const write = req.method === "POST";
      const url = new URL(req.url);
      if (!(write && url.pathname === "/stroke" ? allowedStroke(ip) : allowed(ip, write))) return Response.json({ error: "Please slow down" }, { status: 429, headers });
      if (url.pathname === "/health") return Response.json({ ok: true, db: store !== null, counting, progress, playing: presence.size, live: indexer ? { ...indexer.stats, last: indexer.last } : null }, { headers });
      if (url.pathname === "/ws") {
        if (!store) return new Response("Starting", { status: 503, headers });
        if (!door.enter(ip)) return new Response("Too many connections", { status: 503, headers });
        if (server.upgrade(req, { data: { ip, local, buffer: [], player: null, pens: new Map(), rate: new Bucket(40, 20) } })) return;
        door.leave(ip);
        return new Response("Expected a websocket", { status: 426, headers });
      }
      if (!store) return Response.json({ error: "Community features are starting" }, { status: 503, headers });
      try {
        const response = req.method === "GET" ? await get(url) : write ? await post(req, url, ip, local) : Response.json({ error: "Method not allowed" }, { status: 405 });
        for (const [k, v] of headers) if (!(k === "cache-control" && response.headers.has("cache-control"))) response.headers.set(k, v);
        return response;
      } catch (e) {
        const message = String((e as Error).message ?? e);
        if (e instanceof Unauthorized) return Response.json({ error: message }, { status: 401, headers });
        if (e instanceof Refusal) return Response.json({ error: message }, { status: e.status, headers });
        if (/duplicate key|unique/i.test(message)) return Response.json({ error: "That username is already taken" }, { status: 409, headers });
        if (/^You can follow up to/.test(message) || message === "Try again in a moment") return Response.json({ error: message }, { status: 429, headers });
        log(`a request failed: ${message.split("\n")[0].slice(0, 160)}`);
        return Response.json({ error: "Could not load this right now. Try again." }, { status: 503, headers });
      }
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // What changes while the snapshot is read waits for it, then follows it.
        snapshotText().then(
          (text) => {
            if (!clients.has(ws)) return;
            const waiting = ws.data.buffer ?? [];
            ws.data.buffer = null;
            ws.send(text);
            for (const t of waiting) ws.send(t);
          },
          () => ws.close(1011, "Please reconnect"),
        );
      },
      close(ws) {
        clients.delete(ws);
        door.leave(ws.data.ip);
      },
      message(ws, raw) {
        pen(ws, raw);
      },
      // A pen message's points, at most 200 of them, and a binding's signature.
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      sendPings: true,
    },
  });
}

/* ---- starting, and what the relayer says ---- */
async function connect(cfg: IndexerConfig, url: string) {
  for (let wait = 5_000; ; wait = Math.min(60_000, wait * 2)) {
    const s = new SocialStore(url, `solana-${cfg.cluster}:${cfg.game}`);
    try {
      await s.start();
      return s;
    } catch (e) {
      const message = String((e as Error).message ?? e).split("\n")[0];
      void s.close().catch(() => undefined);
      // A database for another deployment is not tried again: it never will be this one's.
      if (/^this database is for/.test(message)) throw e;
      log(`no database yet (${message.replace(/postgres(ql)?:\/\/\S+/g, "<db>").slice(0, 120)}); trying again in ${wait / 1000} s`);
      await Bun.sleep(wait);
    }
  }
}

let testPlays = false;
async function start(cfg: IndexerConfig) {
  testPlays = cfg.testPlays === true;
  const url = process.env.SOCIAL_DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    log("SOCIAL_DATABASE_URL is not set: profiles, follows and the leaderboard are off; the game is not affected");
    return;
  }
  const port = Number(process.env.SOCIAL_PORT ?? 3105);
  const server = serve(port);
  log(`listening on http://${server.hostname}:${server.port}; origins ${[...origins].join(", ")}`);
  const s = await connect(cfg, url);
  challenges = new Challenges(s.scope);
  store = s;
  log("Postgres connected");
  const timer = setInterval(() => {
    challenges?.prune();
    for (const [k, w] of strokes) if (Date.now() - w.at > STROKE_WAIT_MS) strokes.delete(k);
  }, 30_000);
  // Who stopped playing drops out of the list without anything happening to say so.
  const pulse = setInterval(tellPresence, 5_000);
  pulse.unref?.();
  timer.unref?.();
  indexer = new SolanaIndexer(cfg, s, changed, status, log, strokeFor, live);
  await indexer.start();
}

/** Updates in from the relayer, a few at a time; a database that has stopped answering never piles them up. */
let waiting = 0;
let chain: Promise<unknown> = Promise.resolve();
function later(run: (s: SocialStore) => Promise<void>) {
  if (!store) return;
  if (waiting >= MOST_WAITING) return;
  waiting++;
  chain = chain
    .then(() => run(store!))
    .catch(() => undefined)
    .finally(() => waiting--);
}

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type: string; cfg?: IndexerConfig; placement?: Placement; settlement?: Settlement };
  if (data.type === "start" && data.cfg) {
    void start(data.cfg).catch((e) => log(`stopped: ${String((e as Error).message ?? e).split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<db>")}; the game is not affected`));
  } else if (data.type === "placed" && data.placement) {
    const p = data.placement;
    // Playing now, from the relayer's word, before the database has it.
    presence.placed(p.player, profileOf(p.player));
    tellPresence();
    // Told from memory at once (with its stroke); written after. The chain's copy of it, when it comes, is the same.
    const told = live({ placement: p }, `${p.tx}:${p.betId}`);
    later(async (s) => {
      const d = await s.place(p, told);
      if (!told) changed(d, "placed", `${p.tx}:${p.betId}`);
    });
  } else if (data.type === "settled" && data.settlement) {
    const st = data.settlement;
    const event = `${st.tx}:${st.betId}:${st.hitMask}:${st.missMask}`;
    const told = live({ settlement: st }, event);
    later(async (s) => {
      const d = await s.settle(st, told);
      if (!told) changed(d, "settled", event);
    });
  }
});

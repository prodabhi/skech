import type { Stroke } from "./ink";

/**
 * The community's public data: profiles, follows, drawings and what they made, as the social service serves them
 * (packages/relayer/src/social). Players are Solana addresses, base58 and case sensitive. Money is integer USDC
 * millionths, as decimal strings.
 */
export type SocialWindow = "24h" | "7d" | "30d" | "all";
/**
 * `avatar`: a picture they uploaded. `avatarSeed`: the Dylan avatar they chose (avatar.ts); without one, their
 * address is its seed, so everyone has a face.
 */
export type PlayerProfile = { player: string; username: string | null; bio: string; avatar: boolean; avatarSeed: string | null; joinedAt: number; followers: number; following: number };
export type PlayerStats = { staked: string; settledStake: string; paid: string; owed: string; pnl: string; drawings: number; completed: number; wins: number; biggest: string };
export type DrawingPiece = { betId: string; stroke: Stroke | null; from?: number; sections: { second: number; lo: string; hi: string; stake: string; rung: number }[]; openAt: number; unit: string; hitMask: number; missMask: number; expiredMask?: number };
export type PublicDrawing = { id: string; player: string; profile: PlayerProfile; at: number; updatedAt: number; stake: string; settledStake: string; paid: string; owed: string; pnl: string; complete: boolean; pieces: DrawingPiece[]; tx: string };
export type LeaderboardRow = { rank: number; profile: PlayerProfile; stats: PlayerStats };
export type SocialActivity = { id: string; kind: "placed" | "settled"; drawing: string; player: string; profile: PlayerProfile; at: number; amount: string; complete: boolean };

/** Latest event per drawing, grouped into consecutive runs by the same player. */
export function activityRuns(activity: readonly SocialActivity[], limit = 20): SocialActivity[][] {
  const newest = new Map<string, SocialActivity>();
  for (const item of activity) if (!newest.has(item.drawing)) newest.set(item.drawing, item);
  const runs: SocialActivity[][] = [];
  for (const item of newest.values()) {
    const last = runs.at(-1);
    if (last && last[0].player === item.player) last.push(item);
    else runs.push([item]);
  }
  return runs.slice(0, limit);
}
export type ProfileResponse = { profile: PlayerProfile; stats: PlayerStats; drawings: PublicDrawing[]; next: string | null; curve: { at: number; pnl: string }[]; badges: string[]; following: boolean };
/** `playing`: who is playing now, most recent first (a piece in the last 30 s, or a drawing still in play). */
export type SocialSnapshot = { type: "snapshot"; drawings: PublicDrawing[]; activity: SocialActivity[]; playing: PlayerProfile[]; counting: boolean; progress: number };
export type SocialMessage =
  | SocialSnapshot
  | { type: "drawing"; drawing: PublicDrawing; activity?: SocialActivity }
  | { type: "profile"; profile: PlayerProfile }
  | { type: "presence"; playing: PlayerProfile[] }
  | { type: "status"; counting: boolean; progress: number };
/** What a signed action asks: the service answers it with a challenge for the wallet to sign. */
export type SocialAction = "profile" | "follow" | "pen";
export type SocialChallenge = { token: string; message: string };

export const socialWindows: SocialWindow[] = ["24h", "7d", "30d", "all"];
export const windowStart = (window: SocialWindow, now = Date.now()) => (window === "all" ? 0 : now - { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[window]);
export const playerName = (profile: Pick<PlayerProfile, "player" | "username">) => profile.username ?? `${profile.player.slice(0, 4)}…${profile.player.slice(-4)}`;
export function playerHue(player: string) {
  let hash = 0;
  for (const ch of player) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return ((hash % 360) + 360) % 360;
}

/** A Solana address as text: 32 to 44 base58 characters. The service decodes it to 32 bytes before trusting it. */
export const looksLikePlayer = (value: unknown): value is string => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/* ---- what a profile may say: the service checks it, and the app says the same before asking ---- */

export const USERNAME = /^[a-z][a-z0-9_]{2,23}$/;
/**
 * A chosen Dylan avatar's seed: the player's address and a number (`<address>:<n>`, what the app offers), or any
 * short seed of safe characters.
 */
export const AVATAR_SEED = /^[1-9A-HJ-NP-Za-km-z]{32,44}:\d{1,6}$|^[A-Za-z0-9_-]{1,32}$/;
export const avatarSeedOf = (profile: Pick<PlayerProfile, "player" | "avatarSeed">) => profile.avatarSeed ?? profile.player;
export function avatarSeedProblem(seed: unknown): string | null {
  return seed === null || (typeof seed === "string" && AVATAR_SEED.test(seed)) ? null : "Choose one of the avatars offered";
}
/** The longest stroke a piece may carry, as the relayer takes it: a header and 2,048 points. */
export const STROKE_BYTES = 33 + 2048 * 12;
export const BIO_MAX = 160;
/** Names that would read as the game speaking. */
const RESERVED = new Set(["admin", "administrator", "skech", "skech_trade", "support", "help", "official", "moderator", "mod", "staff", "team", "system", "root", "oracle", "relayer", "house", "null", "undefined"]);
/** Control characters, zero-width and direction overrides: text that hides or reorders what it says. */
const HIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁩﻿]/;

/** Why a username is refused, or null. */
export function usernameProblem(username: unknown): string | null {
  if (typeof username !== "string" || !USERNAME.test(username)) return "Use 3–24 lowercase letters, numbers or underscores; start with a letter";
  if (RESERVED.has(username) || username.startsWith("skech")) return "That username is reserved";
  return null;
}

/** The bio as kept: trimmed and normalised. Throws with why it cannot be. */
export function cleanBio(bio: unknown): string {
  if (typeof bio !== "string") throw new Error("Invalid bio");
  const text = bio.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if ([...text].length > BIO_MAX) throw new Error(`Keep your bio under ${BIO_MAX} characters`);
  if (HIDDEN.test(text)) throw new Error("Your bio has characters that cannot be shown");
  if ((text.match(/\n/g)?.length ?? 0) > 4) throw new Error("Keep your bio to five lines");
  return text;
}

/* ---- shared by the web app and the phone: one protocol, one reading of it ---- */

/**
 * The social service's address: an override (NEXT_PUBLIC_SOCIAL_URL, EXPO_PUBLIC_SOCIAL_URL), else beside the
 * relayer, at /social on its host, or port 3105 of a relayer on this machine (or the Android emulator's host).
 */
export function socialUrl(relayerUrl: string, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  try {
    const u = new URL(relayerUrl);
    const local = ["localhost", "127.0.0.1", "10.0.2.2"].includes(u.hostname);
    return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.hostname}${local ? ":3105" : u.port ? `:${u.port}` : ""}${local ? "" : "/social"}`;
  } catch {
    return "https://api.skech.trade/social";
  }
}
/** The live feed's socket, from the service's address. */
export const socialSocketUrl = (base: string) => `${base.replace(/^http/, "ws")}/ws`;
/** A picture a player uploaded, served by the service. */
export const uploadedAvatarUrl = (base: string, player: string) => `${base}/avatar?player=${encodeURIComponent(player)}`;
/** What an app sends for a placed piece's stroke: POST /stroke, the exact bytes it sent the relayer (0x hex). */
export type StrokeBody = { betId: string; stroke: string };

/** The Dylan avatars offered when choosing one: the address's own first, then `<address>:<n>` from `from`. */
export const avatarChoices = (player: string, from: number, count = 8) => [player, ...Array.from({ length: count }, (_, i) => `${player}:${from + i}`)];

/** USDC millionths as dollars, rounded to the cent, never through a float. */
export function socialMoney(value: string, signed = false): string {
  const amount = BigInt(value), abs = amount < 0n ? -amount : amount;
  const rounded = (abs + 5000n) / 10_000n;
  const dollars = rounded / 100n, cents = (rounded % 100n).toString().padStart(2, "0");
  return `${rounded === 0n ? "" : amount < 0n ? "−" : signed ? "+" : ""}$${dollars.toLocaleString("en-US")}${cents === "00" ? "" : `.${cents}`}`;
}

/** The live feed as an app holds it. */
export type FeedState = { connected: boolean; counting: boolean; progress: number; drawings: PublicDrawing[]; activity: SocialActivity[]; playing: PlayerProfile[]; profiles: Record<string, PlayerProfile> };
export const EMPTY_FEED: FeedState = { connected: false, counting: false, progress: 0, drawings: [], activity: [], playing: [], profiles: {} };
/** Drawings that moved in the last two minutes; no older ones are kept. */
export const LIVE_MS = 120_000;
const MOST_DRAWINGS = 80;
const MOST_ACTIVITY = 60;
const MOST_PROFILES = 500;

/** A profile, as it now is, everywhere the feed shows it. */
export function feedProfile(state: FeedState, p: PlayerProfile): FeedState {
  const swap = <T extends { player: string; profile: PlayerProfile }>(x: T) => (x.player === p.player ? { ...x, profile: p } : x);
  return { ...state, profiles: { ...state.profiles, [p.player]: p }, drawings: state.drawings.map(swap), activity: state.activity.map(swap), playing: state.playing.map((x) => (x.player === p.player ? p : x)) };
}

/** The feed after one message from the service: the same on the web and the phone. */
export function applyFeed(state: FeedState, message: SocialMessage, now = Date.now()): FeedState {
  switch (message.type) {
    case "snapshot": {
      const profiles = { ...state.profiles };
      for (const d of message.drawings) profiles[d.player] = d.profile;
      for (const a of message.activity) profiles[a.player] ??= a.profile;
      for (const p of message.playing ?? []) profiles[p.player] ??= p;
      return keepProfiles({ ...state, drawings: message.drawings.slice(0, MOST_DRAWINGS), activity: message.activity.slice(0, MOST_ACTIVITY), playing: message.playing ?? [], profiles, counting: message.counting, progress: message.progress });
    }
    case "drawing": {
      const d = message.drawing;
      const drawings = [d, ...state.drawings.filter((x) => x.id !== d.id && x.updatedAt > now - LIVE_MS)].slice(0, MOST_DRAWINGS);
      const a = message.activity;
      const activity = a ? [a, ...state.activity.filter((x) => x.id !== a.id)].slice(0, MOST_ACTIVITY) : state.activity;
      return keepProfiles({ ...state, drawings, activity, profiles: { ...state.profiles, [d.player]: d.profile } });
    }
    case "profile":
      return feedProfile(state, message.profile);
    case "presence": {
      const profiles = { ...state.profiles };
      // A bare profile (the relayer's word, before the database's) never hides a fuller one already here.
      for (const p of message.playing) if (p.username || p.avatar || p.avatarSeed || !profiles[p.player]) profiles[p.player] = p;
      return keepProfiles({ ...state, playing: message.playing, profiles });
    }
    case "status":
      return { ...state, counting: message.counting, progress: message.progress };
  }
}
function keepProfiles(state: FeedState): FeedState {
  const keys = Object.keys(state.profiles);
  if (keys.length <= MOST_PROFILES) return state;
  const keep = new Set([...keys.slice(-400), ...state.drawings.map((d) => d.player), ...state.playing.map((p) => p.player)]);
  return { ...state, profiles: Object.fromEntries(Object.entries(state.profiles).filter(([k]) => keep.has(k))) };
}

/* ---- the live pen: a stroke as it is drawn, before any of it is placed (display only, never money) ---- */

/**
 * What an app sends over the feed's socket while its pen is down, about ten times a second: only the points since
 * the last message, as whole numbers from the stroke's origin (ms, and the price in hundredths of PEN_PRICE).
 * The first message of a stroke (`seq` 0) carries its origin and pen. Then `pen-end` when the pen lifts.
 *
 * A socket sends only once bound to a player: `bind` with a signed challenge (action "pen"), answered with a ticket
 * that binds again, unsigned, for a day.
 */
export const PEN_PRICE = 100;
export const PEN_POINTS_PER_MESSAGE = 200;
export const PEN_POINTS_PER_STROKE = 2048;
export const PEN_STROKES_OPEN = 4;
/** A faint stroke with no word for this long is let go: its placement did not come, or the pen went away. */
export const PEN_EXPIRE_MS = 3000;
export type PenStart = { t0: number; p0: number; rt: number; rp: number };
export type PenOut =
  | ({ type: "pen"; id: string; seq: number; pts: number[] } & Partial<PenStart>)
  | { type: "pen-end"; id: string }
  | { type: "bind"; token?: string; payload?: unknown; signature?: string; ticket?: string; test?: string };
export type PenIn =
  | ({ type: "pen"; player: string; id: string; seq: number; pts: number[]; profile?: PlayerProfile } & Partial<PenStart>)
  | { type: "pen-end"; player: string; id: string }
  | { type: "bound"; player: string; ticket: string }
  | { type: "unbound"; error: string };

/** Points as a pen message carries them, and back. */
export const penPack = (pts: readonly { t: number; p: number }[]) => pts.flatMap((q) => [Math.round(q.t), Math.round(q.p * PEN_PRICE)]);
export function penUnpack(flat: readonly number[]): { t: number; p: number }[] {
  const out: { t: number; p: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ t: flat[i], p: flat[i + 1] / PEN_PRICE });
  return out;
}
/** Whether a pen message from an app is one the service passes on. */
export function penProblem(m: unknown): string | null {
  if (!m || typeof m !== "object") return "not a message";
  const x = m as Record<string, unknown>;
  if (typeof x.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(x.id)) return "bad id";
  if (x.type === "pen-end") return null;
  if (x.type !== "pen" || !Number.isSafeInteger(x.seq) || (x.seq as number) < 0) return "bad seq";
  if (!Array.isArray(x.pts) || x.pts.length % 2 || x.pts.length > PEN_POINTS_PER_MESSAGE * 2 || !x.pts.every((n) => Number.isSafeInteger(n) && Math.abs(n as number) < 1e9)) return "bad points";
  if (x.seq === 0) {
    for (const k of ["t0", "p0", "rt", "rp"]) if (typeof x[k] !== "number" || !Number.isFinite(x[k]) || (x[k] as number) < 0) return `bad ${k}`;
    if ((x.rt as number) > 1e6 || (x.rp as number) > 1e7 || (x.p0 as number) > 1e9 || (x.t0 as number) > 1e14) return "out of range";
  }
  return null;
}

/** Whose ink is drawn on the chart: everyone's, only those followed, or none but one's own. */
export type DrawingAudience = "everyone" | "following" | "me";
/** Other players' drawings to draw now. */
export function remoteDrawings(state: FeedState, viewer: string | null, audience: DrawingAudience, following: ReadonlySet<string>, now = Date.now()) {
  if (audience === "me" || !state.connected) return [];
  return state.drawings.filter((d) => d.player !== viewer && d.updatedAt > now - LIVE_MS && (audience === "everyone" || following.has(d.player)));
}
/** Every drawing the chart may label, the viewer's own included. */
export function visibleDrawings(state: FeedState, viewer: string | null, audience: DrawingAudience, following: ReadonlySet<string>, now = Date.now()) {
  if (!state.connected) return [];
  return state.drawings.filter((d) => d.updatedAt > now - LIVE_MS && (d.player === viewer || (audience !== "me" && (audience === "everyone" || following.has(d.player)))));
}

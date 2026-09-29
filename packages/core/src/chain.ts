/**
 * skech on chain: the shapes `packages/contracts/evm/src/SkechGame.sol` hashes and
 * the arithmetic it settles by, mirrored here so the app signs exactly what the
 * contract checks and shows exactly what it will pay.
 *
 * Units, as on chain: prices with 8 decimals, USDC with 6, time in ms on the
 * exchange's clock, chances in billionths, rungs x100, momentum x1e6.
 */

import { encodePacked, keccak256, type Address, type Hex, type TypedDataDomain } from "viem";
import { INK_CELL, MAX_SECTION_WIDTH } from "./ink-area";
import { difficulty as difficultyOf, MIN_DIFFICULTY } from "./dots";
import type { Cell } from "./ink";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** The rungs, x100: 1.1x, 1.5x, 2x, 3x, 4x, 6x, 8x, 12x, 16x, 24x, 32x, 48x, 64x, 96x, 128x. */
export const LADDER_E2 = [110, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 4800, 6400, 9600, 12800] as const;
/** The most one section pays, in dots. */
export const MAX_DOTS = 256;
/** The momentum margin, x1000, per unit of momentum, over at most two units. */
export const MARGIN_E3 = 110;
export const CHANCE_ONE = 1_000_000_000;
/** Seconds ahead a band may be, and sections in one piece at most. */
export const HORIZON = 30;
export const MAX_SECTIONS = 32;
/**
 * The price grid: one unit is the market step over this. Bands sit on it and
 * are judged one unit wider each way, so every screen and pen prices and
 * settles the same. The engine's `areaCells` works in cells of `step * INK_CELL`,
 * so the step it is given is the market step over GRID * INK_CELL.
 */
export const GRID = 50;
/** How tall a band may be, in grid units (`ink-area.ts`). */
export { MAX_SECTION_WIDTH };
/** How late a piece may reach the engine after its opening second, ms; the chain's default too. */
export const LATE_MS = 200;
export const E8 = 100_000_000n;
export const E6 = 1_000_000n;
/**
 * The least one piece may stake, USDC e6: 1¢, so a single dot at the cheapest price, or a tap, can be placed.
 * The relayer's own figure (SOLANA_MIN_PIECE_STAKE) comes in its hello's terms; this is its default.
 */
export const MIN_PIECE_STAKE_E6 = 10_000n;
/** The same, in dollars. */
export const MIN_PIECE_STAKE = Number(MIN_PIECE_STAKE_E6) / 1e6;
/**
 * The stake the apps gather ink into while the pen is down, USDC e6: 10¢. Each piece is a Solana transaction
 * the relayer pays for (about 7,100 lamports with its share of settling, under a tenth of a cent), and only
 * the stake fee pays it back: 1% of 10¢ does, 1% of 1¢ does not. So a line goes in 10¢ pieces and only its end,
 * or a line too short for one, goes smaller; the relayer limits each player's pieces under this.
 */
export const BATCH_PIECE_STAKE_E6 = 100_000n;

/* ------------------------------------------------------------------ */
/* The ladder, in integers, as the chain computes it                   */
/* ------------------------------------------------------------------ */

export { MIN_DIFFICULTY };
/** What ink exactly on a rung returns per dollar at difficulty `d`, x1000: 1200 - 4d, a difficulty under the least priced as the least. */
export const bestE3 = (d: number) => 1200 - 4 * Math.max(d, MIN_DIFFICULTY);
/** The least a rung pays at difficulty `d`, x100: 110 up to 70, easing to 100 at 100. Likelier ink pays its fair multiple. */
export const floorE2 = (d: number) => (d <= 70 ? 110 : 110 - Math.floor(((d - 70) * 10 + 15) / 30));

/**
 * The rung, x100, a section of chance `chanceE9` earns at difficulty `d`; 0 when
 * it is not offered. `withIt`: on the side the price just moved toward.
 */
export function rungE2(chanceE9: number, d: number, withIt: boolean, momentumE6: number): number {
  if (!Number.isInteger(chanceE9) || chanceE9 <= 0 || chanceE9 > CHANCE_ONE || d < 0 || d > 100) return 0;
  // The margin x1e9: 0.11 per unit of momentum (x1e6), over at most two units.
  const marginE9 = withIt ? BigInt(MARGIN_E3) * BigInt(Math.min(2_000_000, Math.abs(Math.trunc(momentumE6)))) : 0n;
  // Fair x1000, rounded down, exactly as the chain: past 2^53, so in bigints.
  const fairE3 = Number(((BigInt(bestE3(d)) * 1_000_000n - marginE9) * BigInt(CHANCE_ONE)) / (BigInt(chanceE9) * 1_000_000n));
  // Too likely for the floor: its fair multiple, rounded down to the hundredth, and never under 1x.
  if (fairE3 < floorE2(d) * 10) return Math.max(100, Math.floor(fairE3 / 10));
  let best = floorE2(d);
  for (const r of LADDER_E2) {
    if (r * 10 > fairE3) break;
    if (r > best) best = r;
  }
  return best;
}

/**
 * Whether a band leaves the house its stake fee in expectation: chance × rung, what it returns per dollar before fees,
 * at most 1 − the fee. The program does not offer one that returns more (certain ink at 1x, or ink exactly on a rung
 * at a low difficulty), as `ladder::within_fee` does.
 */
export const withinFee = (chanceE9: number, rungE2: number, feeBps: number) => BigInt(chanceE9) * BigInt(rungE2) * 10_000n <= BigInt(10_000 - Math.min(10_000, feeBps)) * 100n * BigInt(CHANCE_ONE);

/** The most a section paying `rungE2` may stake at `perDot` (USDC e6), so it never pays past MAX_DOTS dots. */
export const maxStakeE6 = (perDotE6: bigint, rung: number) => (perDotE6 * BigInt(MAX_DOTS) * 100n) / BigInt(rung);
/** What a hit on `stake` at `rung` pays, before fees. */
export const grossE6 = (stakeE6: bigint, rung: number) => (stakeE6 * BigInt(rung)) / 100n;

/** Whether a band is on the side the price has just moved toward, as the chain decides it. */
export const withMomentum = (loE8: bigint, hiE8: bigint, priceE8: bigint, momentumE6: number) => {
  const mid = (loE8 + hiE8) / 2n;
  return (mid > priceE8 && momentumE6 > 0) || (mid < priceE8 && momentumE6 < 0);
};

/**
 * The chain's rung as the app's `ladderSection` sees it: what per dollar, and
 * how much of `area` is staked. Null when not offered. The app quotes off its
 * own float ladder while drawing; this is what the contract settles on.
 */
export function chainSection(chanceE9: number, d: number, withIt: boolean, momentumE6: number, area: number): { area: number; multiple: number } | null {
  const rung = rungE2(chanceE9, d, withIt, momentumE6);
  if (!rung) return null;
  const multiple = rung / 100;
  return { area: Math.min(area, MAX_DOTS / multiple), multiple };
}

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

export const toE8 = (price: number) => BigInt(Math.round(price * 1e8));
export const fromE8 = (e8: bigint) => Number(e8) / 1e8;
export const toE6 = (usd: number) => BigInt(Math.round(usd * 1e6));
export const fromE6 = (e6: bigint) => Number(e6) / 1e6;
export const chanceE9 = (p: number) => Math.max(0, Math.min(CHANCE_ONE, Math.round(p * CHANCE_ONE)));
export const momentumE6 = (m: number) => Math.round(Math.max(-100, Math.min(100, m)) * 1e6);
/** The difficulty's parameters, from the same table the app uses, to check the chain against. */
export const ladderOf = (d: number) => ({ best: difficultyOf(d).ladderBest, floor: difficultyOf(d).ladderFloor });

/** The grid unit for a market step, in price. */
export const unitFor = (marketStep: number) => marketStep / GRID;
/** The step to hand `areaCells` and `field`, so their cells are one grid unit tall. */
export const gridStep = (marketStep: number) => marketStep / (GRID * INK_CELL);

/** A chain price, snapped to the grid it must sit on. */
export const onGrid = (price: number, unit: number) => BigInt(Math.round(price / unit)) * toE8(unit);

/* ------------------------------------------------------------------ */
/* Typed data                                                          */
/* ------------------------------------------------------------------ */

export const TYPES = {
  Section: [
    { name: "second", type: "uint8" },
    { name: "lo", type: "uint64" },
    { name: "hi", type: "uint64" },
    { name: "stake", type: "uint64" },
  ],
  Piece: [
    { name: "player", type: "address" },
    { name: "drawing", type: "uint64" },
    { name: "index", type: "uint32" },
    { name: "market", type: "uint8" },
    { name: "difficulty", type: "uint8" },
    { name: "openAt", type: "uint64" },
    { name: "perDot", type: "uint64" },
    { name: "unit", type: "uint64" },
    { name: "priceSeen", type: "uint64" },
    { name: "priceTime", type: "uint64" },
    { name: "sections", type: "Section[]" },
    { name: "strokeHash", type: "bytes32" },
  ],
  Quote: [
    { name: "market", type: "uint8" },
    { name: "openAt", type: "uint64" },
    { name: "unit", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "momentum", type: "int64" },
    { name: "pieces", type: "bytes32[]" },
    { name: "receivedAt", type: "uint64[]" },
    { name: "chances", type: "uint32[]" },
  ],
  Bar: [
    { name: "market", type: "uint8" },
    { name: "second", type: "uint64" },
    { name: "prevClose", type: "uint64" },
    { name: "high", type: "uint64" },
    { name: "low", type: "uint64" },
    { name: "close", type: "uint64" },
  ],
  Price: [
    { name: "market", type: "string" },
    { name: "price", type: "uint256" },
    { name: "time", type: "uint64" },
  ],
  Session: [
    { name: "player", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "key", type: "address" },
    { name: "x", type: "bytes32" },
    { name: "y", type: "bytes32" },
    { name: "validUntil", type: "uint64" },
    { name: "allowance", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  RevokeSession: [
    { name: "player", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdraw: [
    { name: "player", type: "address" },
    { name: "amount", type: "uint64" },
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The game's EIP-712 domain: the same name and version the engine signs prices under. */
/**
 * EIP-3009 on USDC: what a player signs to move USDC into the game with no allowance, the way x402 pays. Signed under
 * USDC's own domain (its name, its version, the chain, USDC's address), not the game's. Only the payee, the game, can
 * carry it out; the nonce is 32 random bytes, so any number can be in flight.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const domain = (chainId: number, game: Address): TypedDataDomain => ({ name: "skech", version: "1", chainId, verifyingContract: game });

export type Section = { second: number; lo: bigint; hi: bigint; stake: bigint };
export type Piece = {
  player: Address;
  drawing: bigint;
  index: number;
  market: number;
  difficulty: number;
  openAt: bigint;
  perDot: bigint;
  unit: bigint;
  priceSeen: bigint;
  priceTime: bigint;
  sections: Section[];
  strokeHash: Hex;
};
export type Quote = { market: number; openAt: bigint; unit: bigint; price: bigint; momentum: bigint; receivedAt: bigint[]; chances: number[] };
export type Bar = { market: number; second: bigint; prevClose: bigint; high: bigint; low: bigint; close: bigint };

/** The name of a piece's bet on chain. */
export const betIdOf = (player: Address, drawing: bigint, index: number) => keccak256(encodePacked(["address", "uint64", "uint32"], [player, drawing, index]));

/* ------------------------------------------------------------------ */
/* From the app's sections to the chain's                              */
/* ------------------------------------------------------------------ */

/**
 * The app's sections (`newInk`: each a band `lo` to `hi` in second `t`, `area`
 * in dots), as the chain takes them: seconds after `openAt`, prices on the
 * grid, and a stake of `perDot` times the area. Sections off the grid or out
 * of reach are dropped; the caller keeps the app's view of them.
 */
export function toSections(cells: Cell[], openAt: number, perDotE6: bigint, unit: number): Section[] {
  const unitE8 = toE8(unit);
  const out: Section[] = [];
  for (const c of cells) {
    const second = Math.round((c.t - openAt) / 1000);
    if (second < 1 || second > HORIZON) continue;
    const lo = BigInt(Math.round(c.lo / unit)) * unitE8;
    const hi = BigInt(Math.round(c.hi / unit)) * unitE8;
    const stake = (perDotE6 * BigInt(Math.floor(c.area * 1e9))) / 1_000_000_000n;
    if (lo >= hi || stake <= 0n) continue;
    out.push({ second, lo, hi, stake });
  }
  return out;
}

/** The stake a set of sections puts up, USDC e6. */
export const stakeOf = (sections: Section[]) => sections.reduce((n, s) => n + s.stake, 0n);

/**
 * Where to cut ink held back from the chain so that no piece stakes under `least`, and the end of a line
 * always has at least `after` held to go as a piece of its own. `marks` are the line as it stood at earlier
 * reads since the last piece went (`prev`, null before the first), oldest first; `areaOf` the dots a line
 * covers on the opening a piece placed now gets (null: none). The cut is at the latest mark with at least
 * `after` drawn since it, if the ink up to it stakes `least`; -1 holds it all for now.
 */
export function cutAt<S>(prev: S | null, marks: readonly S[], now: S, areaOf: (s: S | null) => number, perDotE6: bigint, least: bigint, after = least): number {
  const stake = (from: number, to: number) => (perDotE6 * BigInt(Math.floor(Math.max(0, to - from) * 1e9))) / 1_000_000_000n;
  const end = areaOf(now);
  for (let j = marks.length - 1; j >= 0; j--) {
    const at = areaOf(marks[j]);
    if (stake(at, end) < after) continue;
    return stake(areaOf(prev), at) >= least ? j : -1;
  }
  return -1;
}

/** A stake in USDC e6 as the apps and the relayer say it: "$0.10". */
export const usdE6 = (e6: bigint) => `$${(Number(e6) / 1e6).toFixed(2)}`;

/* ------------------------------------------------------------------ */
/* Strokes, as bytes                                                   */
/* ------------------------------------------------------------------ */

/** A piece's new points: the stroke's origin and pen, and each point as ms and price from the origin. */
export type StrokeBytes = { t0: number; p0: number; rt: number; rp: number; from: number; pts: { t: number; p: number }[] };

/**
 * A piece of a stroke as the chain keeps it (in an event): version, t0 ms,
 * p0 e8, the pen's radii, which point these start at, then int32 ms and int64
 * price e8 per point, big-endian. Points are from the stroke's origin.
 */
export function encodeStroke(s: StrokeBytes): Hex {
  const buf = new Uint8Array(1 + 8 + 8 + 4 + 8 + 4 + s.pts.length * 12);
  const v = new DataView(buf.buffer);
  buf[0] = 1;
  v.setBigUint64(1, BigInt(Math.round(s.t0)));
  v.setBigInt64(9, toE8(s.p0));
  v.setUint32(17, Math.round(s.rt));
  v.setBigUint64(21, toE8(s.rp));
  v.setUint32(29, s.from);
  let o = 33;
  for (const q of s.pts) {
    v.setInt32(o, Math.round(q.t));
    v.setBigInt64(o + 4, toE8(q.p));
    o += 12;
  }
  return `0x${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function decodeStroke(hex: Hex): StrokeBytes {
  const bytes = Uint8Array.from(hex.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  const v = new DataView(bytes.buffer);
  if (bytes[0] !== 1 || (bytes.length - 33) % 12 !== 0) throw new Error("Not a stroke");
  const pts: { t: number; p: number }[] = [];
  for (let o = 33; o < bytes.length; o += 12) pts.push({ t: v.getInt32(o), p: fromE8(v.getBigInt64(o + 4)) });
  return { t0: Number(v.getBigUint64(1)), p0: fromE8(v.getBigInt64(9)), rt: v.getUint32(17), rp: fromE8(v.getBigUint64(21)), from: v.getUint32(29), pts };
}

export const strokeHash = (encoded: Hex) => keccak256(encoded);

/* ------------------------------------------------------------------ */
/* Judging, as the chain judges                                        */
/* ------------------------------------------------------------------ */

/** Whether a bar crosses a band on the grid: from the second before's close to this one's high and low, one unit wider each way, inclusive. */
export function crosses(bar: Pick<Bar, "prevClose" | "high" | "low">, lo: bigint, hi: bigint, unit: bigint): boolean {
  const high = bar.prevClose > bar.high ? bar.prevClose : bar.high;
  const low = bar.prevClose < bar.low ? bar.prevClose : bar.low;
  return high + unit >= lo && low <= hi + unit;
}

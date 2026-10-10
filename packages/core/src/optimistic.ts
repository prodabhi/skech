import { type BetCell, type InkBet, won } from "./ink";

/**
 * Ink played for real, shown as placed the moment it is drawn: the web (ui/app) and the phone (solana-mobile) both
 * open each piece here as the chain will open it, judge it on the local price, and pay its hits into the balance
 * at once, while the piece is still on its way to the relayer and the chain. What the chain says later is the
 * truth, and these are the pieces that make the screen agree with it:
 *
 * - `Holds`: what the balance shows ahead of the chain's word on it. A stake goes out the moment a piece is sent,
 *   a hit pays the moment it is judged; each is held under its own name until the chain has done it too (`land`)
 *   and its next word on the balance includes it, or until it never will (`drop`: a refusal gives the stake back
 *   and takes the hits back).
 * - `confirmPiece`: the chain placed a piece; its bands, as priced there, replace the local ones, keeping what the
 *   price has already done to them.
 * - `expireCells`: bands the chain gave back because their second's bar was never posted.
 * - `refusals`: one short notice for a burst of pieces that did not go through.
 */

/** Names for what is held: a piece's stake, and its hits by second. `key` is the piece's `drawing:index`. */
export const holdIds = {
  stake: (key: string) => `stake:${key}`,
  /** Every win of one piece: a prefix, so `dropAll` and `landAll` find them all. */
  wins: (key: string) => `win:${key}:`,
  win: (key: string, second: number | string) => `win:${key}:${second}`,
  /** Stakes the chain handed back on a settlement (expired bands). */
  back: (key: string) => `back:${key}`,
};

type Held = { usd: number; landed: boolean; at: number };

/**
 * The balance the screen shows is the chain's last word plus `total()`. An entry is held from the moment the screen
 * counts it; `land` says the chain has done it, and the chain's next word on the balance (`heard`) then includes it,
 * so it is let go in the same breath, and the figure does not move. `drop` lets go of one the chain will never do.
 * Anything held far longer than the chain ever takes is let go when it next speaks, so nothing drifts for good.
 */
export class Holds {
  private entries = new Map<string, Held>();
  constructor(private readonly maxAgeMs = 120_000) {}

  /** Count `usd` under `id` (a stake is negative, a win positive), added to whatever is held there already. */
  hold(id: string, usd: number, now = Date.now()) {
    if (!Number.isFinite(usd) || usd === 0) return;
    const e = this.entries.get(id);
    if (e) e.usd += usd;
    else this.entries.set(id, { usd, landed: false, at: now });
  }

  /** The chain has done what `id` holds (as `usd`, if it did it for a different amount): its next word includes it. */
  land(id: string, usd?: number, now = Date.now()) {
    const e = this.entries.get(id);
    if (e) {
      if (usd !== undefined) e.usd = usd;
      e.landed = true;
    } else if (usd) this.entries.set(id, { usd, landed: true, at: now });
  }

  /** Land every entry whose name starts with `prefix`. */
  landAll(prefix: string) {
    for (const [id, e] of this.entries) if (id.startsWith(prefix)) e.landed = true;
  }

  /** Let go of `id`, which the chain will never do: what it held, so the caller can say what came back. */
  drop(id: string): number {
    const e = this.entries.get(id);
    this.entries.delete(id);
    return e?.usd ?? 0;
  }

  /** Let go of every entry whose name starts with `prefix`; what they held, together. */
  dropAll(prefix: string): number {
    let usd = 0;
    for (const [id, e] of this.entries) {
      if (!id.startsWith(prefix)) continue;
      usd += e.usd;
      this.entries.delete(id);
    }
    return usd;
  }

  /** The chain's word on the balance arrived: what it has done is in it now. Whether anything was let go. */
  heard(now = Date.now()): boolean {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (!e.landed && now - e.at < this.maxAgeMs) continue;
      this.entries.delete(id);
      changed = true;
    }
    return changed;
  }

  /** What is held, in dollars, to the micro-dollar. */
  total(): number {
    let usd = 0;
    for (const e of this.entries.values()) usd += e.usd;
    return Math.round(usd * 1e6) / 1e6;
  }

  /** What is held under `id`, or under every name starting with it when it ends in ":". */
  of(id: string): number {
    if (!id.endsWith(":")) return this.entries.get(id)?.usd ?? 0;
    let usd = 0;
    for (const [k, e] of this.entries) if (k.startsWith(id)) usd += e.usd;
    return usd;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/** What a drawing's hits came to, unrounded, and what of it has been paid into the balance, in whole cents. */
export type Payout = { raw: number; credited: number };
const toCents = (n: number) => Math.round(n * 100) / 100;

/**
 * `raw` more (or less) of a drawing's winnings: what to pay into the balance now, in whole cents of the running
 * total, the fraction waiting for the next. A hit only ever pays (`back` false); the chain's word, or a refusal, may
 * take some back.
 */
export function pay(acc: Payout, raw: number, back = false): number {
  acc.raw += raw;
  const owed = Math.floor(acc.raw * 100 + 1e-8) / 100 - acc.credited;
  const due = back ? owed : Math.max(0, owed);
  acc.credited = toCents(acc.credited + due);
  return toCents(due);
}

/** A piece refused after its hits were paid: the drawing's winnings without it (`won`, what it had won; `credited`, what was paid for it). */
export function unpay(acc: Payout, won: number, credited: number) {
  acc.raw = Math.max(0, acc.raw - won);
  acc.credited = Math.max(0, toCents(acc.credited - credited));
}

/** A band the chain placed, in dollars and prices: `second` after the piece's opening, `rung` the multiple times 100. */
export type PlacedBand = { second: number; lo: number; hi: number; stake: number; rung: number };

/** What a hit pays on chain: its gross less the profit fee on what it made over its stake. */
export const paidOnChain = (stake: number, multiple: number, profitFeeBps: number) => {
  const gross = stake * multiple;
  return gross - Math.max(0, gross - stake) * (profitFeeBps / 10_000);
};

/**
 * The chain placed a piece, as `bands`, staking `staked` dollars: its cells become the chain's (one a band, in the
 * chain's order, which is what its settlements count by), each keeping what the local judge has already found in it
 * (the cell of the same second it overlaps most). A hit is paid as the chain prices it. `paidDelta` is what that
 * changes the piece's winnings by; `bySecond` the same, by the second each change is in.
 */
export function confirmPiece(bet: InkBet, bands: PlacedBand[], staked: number, profitFeeBps: number): { bet: InkBet; paidDelta: number; bySecond: Map<number, number> } {
  const local = bet.status === "opening" || bet.status === "void" ? [] : bet.cells;
  const used = new Set<number>();
  const bySecond = new Map<number, number>();
  const add = (t: number, usd: number) => {
    if (Math.abs(usd) > 1e-12) bySecond.set(t, (bySecond.get(t) ?? 0) + usd);
  };
  const cells: BetCell[] = bands.map((b) => {
    const t = bet.openAt + b.second * 1000;
    const area = b.stake / bet.perUnit;
    const multiple = b.rung / 100;
    const cell: BetCell = { t, lo: b.lo, hi: b.hi, area, multiple, status: "live" };
    let best = -1;
    let overlap = -Infinity;
    for (let k = 0; k < local.length; k++) {
      const c = local[k];
      if (used.has(k) || c.t !== t || c.expired) continue;
      const o = Math.min(c.hi, b.hi) - Math.max(c.lo, b.lo);
      if (o > overlap) [best, overlap] = [k, o];
    }
    // The same ink: overlapping, or touching within a band's height (the chain's band is the local one on its grid).
    if (best < 0 || overlap < -(b.hi - b.lo)) return cell;
    used.add(best);
    const c = local[best];
    if (c.chance !== undefined) cell.chance = c.chance;
    if (c.status === "hit") {
      const paid = paidOnChain(bet.perUnit * area, multiple, profitFeeBps);
      add(t, paid - (c.paid ?? 0));
      return { ...cell, status: "hit", paid, ...(c.range ? { range: c.range } : {}) };
    }
    if (c.status === "miss") return { ...cell, status: "miss" };
    return cell;
  });
  // Hits on local ink the chain did not take are taken back.
  local.forEach((c, k) => {
    if (!used.has(k) && c.status === "hit" && c.paid) add(c.t, -c.paid);
  });
  const status = !cells.length ? "void" : cells.every((c) => c.status !== "live") ? "done" : "live";
  const next: InkBet = { ...bet, cells, charged: staked, status, why: cells.length ? undefined : "The price moved, and none of it is in play now." };
  return { bet: next, paidDelta: won(next) - won(bet), bySecond };
}

/**
 * Bands the chain gave back (`mask`, by band): their second's bar was never posted. Out of play, their stake back
 * (`back`), and what the screen had paid on them taken back (`takeBack`).
 */
export function expireCells(bet: InkBet, mask: number): { bet: InkBet; back: number; takeBack: number; gone: BetCell[] } {
  if (!mask) return { bet, back: 0, takeBack: 0, gone: [] };
  let back = 0;
  let takeBack = 0;
  const gone: BetCell[] = [];
  const cells = bet.cells.map((c, k) => {
    if (!((mask >>> k) & 1) || c.expired) return c;
    back += bet.perUnit * c.area;
    if (c.status === "hit") takeBack += c.paid ?? 0;
    gone.push(c);
    return { ...c, status: "miss" as const, paid: undefined, range: undefined, expired: true as const };
  });
  if (!gone.length) return { bet, back: 0, takeBack: 0, gone };
  const charged = Math.max(0, (bet.charged ?? 0) - back);
  return { bet: { ...bet, cells, charged, status: cells.every((c) => c.status !== "live") ? "done" : "live" }, back, takeBack, gone };
}

/**
 * Pieces that did not go through, said once: refusals that come close together are one notice that counts them and
 * adds up what came back. `why` is the relayer's (or the chain's) reason, said in a few words where one helps.
 */
export type Refusals = { id: number; count: number; back: number; why: string; at: number };
/** Refusals this close to the last are the same burst. */
export const REFUSALS_MERGE_MS = 1500;
let refusalIds = 0;

export function refusals(prev: Refusals | null, back: number, why: string, now: number): Refusals {
  if (prev && now - prev.at < REFUSALS_MERGE_MS) return { id: prev.id, count: prev.count + 1, back: prev.back + back, why: reasonOf(prev.why) === reasonOf(why) ? why : "", at: now };
  return { id: ++refusalIds, count: 1, back, why, at: now };
}

/** A refusal's reason in a few words, where the player can do something about it; otherwise null. */
export function reasonOf(why: string): string | null {
  if (/not enough|balance/i.test(why)) return "Not enough in your balance";
  if (/allowance/i.test(why)) return "Session allowance used up";
  if (/too many small/i.test(why)) return "Too many small pieces";
  if (/too late|^late$/i.test(why)) return "Too late for that second";
  if (/no answer|could not reach/i.test(why)) return "No answer from the game";
  return null;
}

/** The notice's words, before the money: "That piece didn't go through", "3 pieces didn't go through". */
export function refusalLine(r: Pick<Refusals, "count" | "why">): string {
  const reason = reasonOf(r.why);
  const many = r.count > 1 ? `${r.count} pieces` : "";
  if (reason) return many ? `${reason} · ${many}` : reason;
  return many ? `${many} didn't go through` : "That piece didn't go through";
}

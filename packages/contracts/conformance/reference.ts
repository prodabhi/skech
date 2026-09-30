/**
 * The game's rules as both contracts state them, written a third time, plainly, on `@skech/core`'s ladder (the
 * integers the app prices with): what each step of a case must do. `SkechGame.sol` and `programs/skech` are held
 * to what this says, number for number.
 */
import { crosses, grossE6, MAX_SECTION_WIDTH, maxStakeE6, MIN_DIFFICULTY, rungE2, withinFee, withMomentum } from "@skech/core/chain";
import type { Case, Step } from "./cases";

export const HORIZON = 30;
export const MAX_SECTIONS = 32;
export const LATE_MS = 200;
export const MAX_PRICE_AGE_MS = 15_000;
export const MIN_PER_DOT = 10_000;
export const MAX_PER_DOT = 10_000_000;
export const MAX_PIECE_STAKE = 1_000_000_000;
export const DEFAULT_PER_DOT = 100_000;
const BPS = 10_000n;
/** The house's share, rounded up: a stake or profit split small never slips under the fee. */
const feeOf = (amount: bigint, bps: number) => (amount * BigInt(bps) + BPS - 1n) / BPS;

/* ---- SKT (Solana only): the holders' share of the fees, and what a new net loss mints (programs/skech/src/skt.rs) ---- */

const SKT_PER_USDC = 100n;
const ACC_SCALE = 10n ** 24n;
/** Fewer shares than this and the holders' share goes to the treasury. */
const MIN_TOTAL_SHARES = 1_000_000n;
/** SKT's half-life, the wallet cap and its floor: the program's defaults. */
const HALF_LIFE = 26n * 7n * 86_400n;

/** 2^(2^-i) for i = 1 to 32, times 2^62, rounded down: skt.rs `EXP2_TABLE`. */
const EXP2_TABLE = [
  6521908912666391106n, 5484249825272419511n, 5029079263719320435n, 4815862801830788490n, 4712668792719003883n, 4661903986662671289n, 4636727017470743990n, 4624189567668517720n,
  4617933561212708776n, 4614808732577250068n, 4613247111281068008n, 4612466498810092974n, 4612076242109103707n, 4611881126141011236n, 4611783571252412753n, 4611734794581956353n,
  4611710406440186475n, 4611698212417665819n, 4611692115418496524n, 4611689066921934630n, 4611687542674409371n, 4611686780550835663n, 4611686399489096040n, 4611686208958238036n,
  4611686113692811986n, 4611686066060099699n, 4611686042243743740n, 4611686030335565806n, 4611686024381476851n, 4611686021404432376n, 4611686019915910140n, 4611686019171649022n,
];
/** `2^(l / 2^32)` times 2^32, rounded down, as skt.rs `exp2_q32` works it. */
export function exp2Q32(l: bigint): bigint {
  const whole = l >> 32n;
  const frac = l & 0xffffffffn;
  let x = 1n << 62n;
  EXP2_TABLE.forEach((root, i) => {
    if (frac & (1n << BigInt(31 - i))) x = (x * root) >> 62n;
  });
  return (x >> 30n) << whole;
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** The holders' part of a fee taken at `feeBps` on `amount`: their bps of it, rounded down. */
export const holderPart = (amount: bigint, holderBps: number, feeBps: number) => (amount * BigInt(Math.min(holderBps, feeBps))) / BPS;
/**
 * SKT e6 a basis mints from tracked gain `from`: the integral of `100 · S² / (S + g)²` from `from` to `from + basis`,
 * `100 · S² · (1/(S+from) − 1/(S+from+basis))`, the first term rounded down and the second up.
 */
export function mintAmount(scale: bigint, from: bigint, basis: bigint): bigint {
  if (basis <= 0n || scale <= 0n) return 0n;
  const k = SKT_PER_USDC * scale * scale;
  const d = k / (scale + from) - ceilDiv(k, scale + from + basis);
  return d > 0n ? d : 0n;
}
const CHANCE_ONE = 1_000_000_000n;
/** What a band that missed counts toward SKT: `stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p)`, rounded down, at least 0
 * and at most the stake, with `f` the profit fee: in units of 1e-15, as the program works it. */
export function missBasis(stake: bigint, chanceE9: number, rungE2: number, profitFeeBps: number): bigint {
  const p = BigInt(chanceE9);
  if (p >= CHANCE_ONE) return 0n;
  const r = BigInt(rungE2);
  const edge = BPS * 100n * CHANCE_ONE + BigInt(profitFeeBps) * p * (r > 100n ? r - 100n : 0n) - BPS * p * r;
  if (edge <= 0n) return 0n;
  const b = (stake * edge) / (BPS * 100n * (CHANCE_ONE - p));
  return b < stake ? b : stake;
}
/** What each SKT holder has, in a case's state. */
export type HolderState = { shares: string; basis: number; claimable: number };
export type SktState = { supply: string; totalShares: string; acc: string; holderFunds: number; gain: number; holders: Record<string, HolderState> };

export type Band = { second: number; lo: number; hi: number; stake: number; rung: number };
export type PlaceOut = { ok: true; sections: Band[]; staked: number; fee: number; refunded: number } | { ok: false; refused: string };
export type Settled = { id: string; hitMask: number; missMask: number; paid: number; owed: number };
export type State = { balance: Record<string, number>; allowance: Record<string, number>; pool: number; fees: number; owed: Record<string, number>; houseOwed: number; skt?: SktState };
export type StepOut = { place?: PlaceOut; settled?: Settled[]; difficulty?: { ok: true } | { ok: false; refused: string }; claimed?: number; state: State };

type Bet = { player: string; unit: number; sections: Band[]; chances: number[]; live: number; hit: number };

/** Which chain's rules: Solana does not offer ink that returns more than the stake fee leaves (`withinFee`), nor a
 * band taller than the widest pen (`MAX_SECTION_WIDTH`); the EVM game, retired, does. */
export type Chain = "evm" | "solana";

export function run(c: Case, chain: Chain = "evm"): StepOut[] {
  const players = Object.keys(c.players);
  const balance: Record<string, bigint> = {};
  const allowance: Record<string, bigint> = {};
  const owed: Record<string, bigint> = {};
  for (const p of players) {
    const cfg = c.players[p as "a" | "b"]!;
    balance[p] = BigInt(cfg.deposit);
    allowance[p] = BigInt(cfg.allowance);
    owed[p] = 0n;
  }
  let pool = 0n;
  let fees = 0n;
  let houseOwed = 0n;
  let marketDifficulty = c.difficulty;
  const posted = new Map<number, { prevClose: bigint; high: bigint; low: bigint; close: bigint }>();
  const bets = new Map<string, Bet>();
  // SKT, in a case that has it.
  const skt = c.skt;
  let supply = 0n;
  let totalShares = 0n;
  let acc = 0n;
  let holderFunds = 0n;
  let gain = 0n;
  // Seconds since SKT started, as the Solana runner's clock moves: each bar is posted once its second is over.
  let t = 0n;
  const holders: Record<string, { shares: bigint; accAt: bigint; unclaimed: bigint; basis: bigint }> = {};
  for (const p of players) holders[p] = { shares: 0n, accAt: 0n, unclaimed: 0n, basis: 0n };
  const earned = (h: (typeof holders)[string]) => (acc > h.accAt && h.shares > 0n ? (h.shares * (acc - h.accAt)) / ACC_SCALE : 0n);
  const settleRewards = (h: (typeof holders)[string]) => {
    h.unclaimed += earned(h);
    h.accAt = acc;
  };
  const owing = () => Object.values(owed).some((x) => x > 0n) || houseOwed > 0n;
  // The wallet cap and its floor: the case's, or none.
  const capBps = BigInt(skt?.walletCapBps ?? 10_000);
  const capFloor = BigInt(skt?.capFloor ?? 0);
  const weight = () => exp2Q32((t << 32n) / HALF_LIFE);
  /** The shares a part is counted against: all of them, or the floor's (`capFloor` SKT as if minted at the start, held by
   * nobody: era 0 here) while there are fewer, with a cap. */
  const counted = () => {
    if (capBps >= BPS) return totalShares;
    return totalShares > capFloor ? totalShares : capFloor;
  };
  /** Share `amount` over `counted()`: what is set aside is rounded up; what is not shared is returned. */
  const accrue = (amount: bigint) => {
    const d = counted();
    acc += (amount * ACC_SCALE) / d;
    const shared = ceilDiv(amount * totalShares, d);
    holderFunds += shared;
    return amount - shared;
  };
  /** The holders' share of a stake's fee: to the pool while anything is owed, the treasury while there is no SKT. */
  const shareStakeFee = (amount: bigint) => {
    if (!amount) return;
    if (owing()) pool += amount;
    else if (totalShares < MIN_TOTAL_SHARES) fees += amount;
    else fees += accrue(amount);
  };
  /** The holders' share of a profit's fee: out of what the pool has left, or left in it while anything is owed. */
  const shareProfitFee = (amount: bigint) => {
    const taken = amount < pool ? amount : pool;
    if (!taken || owing()) return;
    pool -= taken;
    if (totalShares < MIN_TOTAL_SHARES) fees += taken;
    else fees += accrue(taken);
  };
  /**
   * A settlement's basis mints, from the tracked gain on, whatever is owed, and moves the gain on: as shares at today's
   * weight, 2^(t / half-life), and no more than the wallet's cap, 10% of all shares or of the floor, whichever is more.
   */
  const mint = (who: string, basis: bigint) => {
    if (!basis) return;
    const h = holders[who];
    const curve = mintAmount(BigInt(skt!.mintScale), gain, basis);
    gain += basis;
    settleRewards(h);
    const w = weight();
    const full = (curve * w) >> 32n;
    let shares = full;
    if (capBps < BPS) {
      const floor = capFloor;
      const sat = (x: bigint) => (x > 0n ? x : 0n);
      const underFloor = sat((capBps * floor) / BPS - h.shares);
      const ofTotal = sat(capBps * totalShares - BPS * h.shares) / (BPS - capBps);
      const room = underFloor > ofTotal ? underFloor : ofTotal;
      if (room < shares) shares = room;
    }
    const minted = shares === full ? curve : (shares << 32n) / w;
    h.shares += shares;
    h.basis += basis;
    totalShares += shares;
    supply += minted;
  };
  const state = (): State => ({
    balance: Object.fromEntries(players.map((p) => [p, Number(balance[p])])),
    allowance: Object.fromEntries(players.map((p) => [p, Number(allowance[p])])),
    pool: Number(pool),
    fees: Number(fees),
    owed: Object.fromEntries(players.map((p) => [p, Number(owed[p])])),
    houseOwed: Number(houseOwed),
    ...(skt
      ? {
          skt: {
            supply: String(supply),
            totalShares: String(totalShares),
            acc: String(acc),
            holderFunds: Number(holderFunds),
            gain: Number(gain),
            holders: Object.fromEntries(players.map((p) => [p, { shares: String(holders[p].shares), basis: Number(holders[p].basis), claimable: Number(holders[p].unclaimed + earned(holders[p])) }])),
          },
        }
      : {}),
  });
  /** In USDC as far as the pool goes, the rest owed. */
  const pay = (who: string, due: bigint) => {
    const paid = due < pool ? due : pool;
    pool -= paid;
    const left = due - paid;
    balance[who] += paid;
    owed[who] += left;
    return { paid, owed: left };
  };
  /** The house's cut, after the player, from what the pool has left: never owed. */
  const cut = (fee: bigint) => {
    const taken = fee < pool ? fee : pool;
    pool -= taken;
    fees += taken;
  };

  const out: StepOut[] = [];
  for (const step of c.steps as Step[]) {
    if ("claim" in step) {
      // What the player's SKT earned, into their balance.
      const h = holders[step.claim];
      settleRewards(h);
      const amount = h.unclaimed;
      h.unclaimed = 0n;
      holderFunds -= amount;
      balance[step.claim] += amount;
      out.push({ claimed: Number(amount), state: state() });
    } else if ("difficulty" in step) {
      // The least is 50: under it, ink exactly on a rung returns more than a dollar.
      const ok = step.difficulty >= MIN_DIFFICULTY && step.difficulty <= 100;
      if (ok) marketDifficulty = step.difficulty;
      out.push({ difficulty: ok ? { ok } : { ok, refused: "BadDifficulty" }, state: state() });
    } else if ("place" in step) {
      const s = step.place;
      const who = s.player ?? "a";
      const refuse = (why: string): StepOut => ({ place: { ok: false, refused: why }, state: state() });
      const difficulty = s.difficulty ?? c.difficulty;
      const perDot = s.perDot ?? DEFAULT_PER_DOT;
      const received = s.received ?? -400;
      const priceAge = s.priceAge ?? 100;
      // In the contracts' order of checks.
      if (bets.has(s.id)) {
        out.push(refuse("Replay"));
        continue;
      }
      if (difficulty !== marketDifficulty) {
        out.push(refuse("Difficulty"));
        continue;
      }
      if (received > LATE_MS) {
        out.push(refuse("Late"));
        continue;
      }
      if (priceAge > MAX_PRICE_AGE_MS) {
        out.push(refuse("StalePrice"));
        continue;
      }
      if (perDot < MIN_PER_DOT || perDot > MAX_PER_DOT) {
        out.push(refuse("PerDot"));
        continue;
      }
      const total = s.sections.reduce((n, x) => n + x.stake, 0);
      if (!s.sections.length || s.sections.length > MAX_SECTIONS || s.sections.some((x) => x.second < 1 || x.second > HORIZON || x.width < 1 || (chain === "solana" && x.width > MAX_SECTION_WIDTH) || x.stake < 1) || total > MAX_PIECE_STAKE) {
        out.push(refuse("Sections"));
        continue;
      }
      const momentum = s.momentum ?? 0;
      const bands: Band[] = [];
      const chances: number[] = [];
      for (const x of s.sections) {
        const lo = x.lo * c.unit;
        const hi = (x.lo + x.width) * c.unit;
        if (posted.has(x.second)) continue;
        const rung = rungE2(x.chance, difficulty, withMomentum(BigInt(lo), BigInt(hi), BigInt(c.price), momentum), momentum);
        if (!rung || (chain === "solana" && !withinFee(x.chance, rung, c.feeBps))) continue;
        const most = Number(maxStakeE6(BigInt(perDot), rung));
        bands.push({ second: x.second, lo, hi, stake: Math.min(x.stake, most), rung });
        chances.push(x.chance);
      }
      const kept = BigInt(bands.reduce((n, b) => n + b.stake, 0));
      if (kept === 0n) {
        out.push(refuse("NotOffered"));
        continue;
      }
      if (allowance[who] < kept) {
        out.push(refuse("Allowance"));
        continue;
      }
      if (balance[who] < kept) {
        out.push(refuse("Balance"));
        continue;
      }
      const fee = feeOf(kept, c.feeBps);
      const toHolders = skt ? holderPart(kept, skt.holderFeeBps, c.feeBps) : 0n;
      balance[who] -= kept;
      allowance[who] -= kept;
      pool += kept - fee;
      fees += fee - toHolders;
      shareStakeFee(toHolders);
      bets.set(s.id, { player: who, unit: c.unit, sections: bands, chances, live: (1 << bands.length) - 1, hit: 0 });
      out.push({ place: { ok: true, sections: bands, staked: Number(kept), fee: Number(fee), refunded: total - Number(kept) }, state: state() });
    } else {
      const b = step.bar;
      // The runner moves its clock on to post a bar once its second is over (less the grace): second − 1 from the start.
      if (BigInt(b.second - 1) > t) t = BigInt(b.second - 1);
      posted.set(b.second, { prevClose: BigInt(b.prevClose), high: BigInt(b.high), low: BigInt(b.low), close: BigInt(b.close) });
      const settled: Settled[] = [];
      for (const id of b.settle) {
        const bet = bets.get(id);
        if (!bet) continue;
        let hits = 0;
        let decided = 0;
        let gross = 0n;
        let stakeHit = 0n;
        let basis = 0n;
        bet.sections.forEach((x, i) => {
          const bit = 1 << i;
          if (!(bet.live & bit)) return;
          const bar = posted.get(x.second);
          if (!bar) return;
          decided |= bit;
          if (crosses(bar, BigInt(x.lo), BigInt(x.hi), BigInt(bet.unit))) {
            hits |= bit;
            stakeHit += BigInt(x.stake);
            gross += grossE6(BigInt(x.stake), x.rung);
          } else basis += missBasis(BigInt(x.stake), bet.chances[i], x.rung, c.profitFeeBps);
        });
        if (!decided) continue;
        bet.live &= ~decided;
        bet.hit |= hits;
        let paid = 0n;
        let left = 0n;
        if (gross > 0n) {
          const profitFee = feeOf(gross - stakeHit, c.profitFeeBps);
          ({ paid, owed: left } = pay(bet.player, gross - profitFee));
          const toHolders = skt ? holderPart(gross - stakeHit, skt.holderProfitFeeBps, c.profitFeeBps) : 0n;
          cut(profitFee - toHolders);
          shareProfitFee(toHolders);
        }
        if (skt) mint(bet.player, basis);
        settled.push({ id, hitMask: hits, missMask: decided & ~hits, paid: Number(paid), owed: Number(left) });
      }
      out.push({ settled, state: state() });
    }
  }
  return out;
}

/**
 * The conformance cases: one game, played the same way on the EVM contracts (evm/) and Solana (solana/), step by step.
 * `generate.ts` runs each through the reference model (`reference.ts`, on `@skech/core`'s ladder) and writes what
 * must come out of every step to `vectors.json`; `evm/test/Conformance.t.sol` and `solana/tests/src/conformance.rs`
 * replay the same file against the real contracts and check every number.
 *
 * Chain-neutral on purpose: a band is `lo` and `width` in grid units (Solana's own encoding; the EVM runner
 * multiplies by `unit`), stakes in USDC e6, prices in e8, seconds after the piece opens. Timing offsets are ms
 * from the opening second.
 */

export type SectionIn = { second: number; lo: number; width: number; stake: number; chance: number };
export type PlaceStep = {
  place: {
    id: string;
    player?: "a" | "b";
    perDot?: number;
    difficulty?: number;
    momentum?: number;
    sections: SectionIn[];
    /** When the oracle received it, ms from the opening second (default -400). */
    received?: number;
    /** How old the price the player saw was when received, ms (default 100). */
    priceAge?: number;
  };
};
export type BarStep = { bar: { second: number; prevClose: number; high: number; low: number; close: number; settle: string[] } };
/** The admin sets the market's difficulty: pieces from then on must be signed at it. */
export type DifficultyStep = { difficulty: number };
/** The player claims what their SKT earned (Solana only). */
export type ClaimStep = { claim: "a" | "b" };
export type Step = PlaceStep | BarStep | DifficultyStep | ClaimStep;
export type Case = {
  name: string;
  /** What each player has in the game, and what their session may stake. */
  players: { a: { deposit: number; allowance: number }; b?: { deposit: number; allowance: number } };
  difficulty: number;
  feeBps: number;
  profitFeeBps: number;
  /** The market: its price (e8) on the opening second, the grid (e8). */
  price: number;
  unit: number;
  /**
   * SKT's terms. A case with them is the Solana program's alone (the EVM game, retired, has no SKT and keeps its old
   * fees): its state also checks the supply, the holders' accumulator and funds, the tracked gain and every holder.
   * Without them the Solana runner sets SKT's split to nothing, so the fees are the EVM game's to the unit.
   */
  skt?: { holderFeeBps: number; holderProfitFeeBps: number; mintScale: number; walletCapBps?: number; capFloor?: number };
  steps: Step[];
};

/** $83,000.00 on a $0.20 grid: the band at the price starts at 415,000 units. */
const PRICE = 8_300_000_000_000;
const UNIT = 20_000_000;
const AT = 415_000;
const e8 = (usd: number) => Math.round(usd * 1e8);
const at = (units: number) => (AT + units) * UNIT;
const flat = (second: number, price: number, high = price, low = price) => ({ second, prevClose: price, high, low, close: price });

/** SKT's default terms, at the fees they are a part of; no wallet cap but in the case that tries it. */
const SKT = { holderFeeBps: 300, holderProfitFeeBps: 800, mintScale: 1_000_000_000_000, walletCapBps: 10_000, capFloor: 0 };

const std = { players: { a: { deposit: 10_000_000, allowance: 5_000_000 } }, difficulty: 51, feeBps: 200, profitFeeBps: 1000, price: PRICE, unit: UNIT };

const skt = {
  players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
  difficulty: 51,
  feeBps: 400,
  profitFeeBps: 1000,
  price: PRICE,
  unit: UNIT,
  skt: SKT,
};

export const CASES: Case[] = [
  {
    ...std,
    name: "a hit, then a miss, and the bet is done",
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }, { second: 2, lo: AT + 1000, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE - e8(0.2), close: PRICE + e8(0.1), settle: ["p"] } },
      { bar: { second: 2, prevClose: PRICE + e8(0.1), high: PRICE + e8(0.2), low: PRICE - e8(1), close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "the ladder across chances, at the least difficulty",
    difficulty: 50,
    steps: [
      {
        place: {
          id: "p",
          difficulty: 50,
          perDot: 1_000_000,
          sections: [
            { second: 1, lo: AT, width: 5, stake: 10_000, chance: 1_000_000_000 },
            { second: 2, lo: AT, width: 5, stake: 10_000, chance: 900_000_000 },
            { second: 3, lo: AT, width: 5, stake: 10_000, chance: 333_333_333 },
            { second: 4, lo: AT, width: 5, stake: 10_000, chance: 50_000_000 },
            { second: 5, lo: AT, width: 5, stake: 10_000, chance: 7_812_500 },
            { second: 6, lo: AT, width: 5, stake: 10_000, chance: 1_000_000 },
          ],
        },
      },
    ],
  },
  {
    ...std,
    feeBps: 400,
    name: "certain ink: Solana offers no band returning more than the stake fee leaves, nor one taller than the widest pen",
    steps: [
      // 65 units tall, over the widest pen (64): Solana refuses the piece.
      { place: { id: "tall", sections: [{ second: 1, lo: AT - 40, width: 65, stake: 50_000, chance: 999_000_000 }] } },
      // At d = 51 and 4%: all but certain ink at 1x is not offered, 48% at 2x (p·m 0.96) is, 48.1% at 2x (0.962) is not.
      {
        place: {
          id: "p",
          sections: [
            { second: 1, lo: AT - 30, width: 64, stake: 50_000, chance: 999_900_000 },
            { second: 2, lo: AT, width: 5, stake: 50_000, chance: 480_000_000 },
            { second: 3, lo: AT, width: 5, stake: 50_000, chance: 481_000_000 },
          ],
        },
      },
    ],
  },
  {
    ...std,
    name: "near-certain ink pays its fair multiple, to the hundredth, never under 1x",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    steps: [
      // Someone else's miss first, so the pool can pay every hit in full.
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 5_000_000, chance: 500_000_000 }] } },
      {
        place: {
          id: "p",
          perDot: 1_000_000,
          sections: [
            { second: 1, lo: AT, width: 5, stake: 1_000_000, chance: 1_000_000_000 },
            { second: 1, lo: AT + 5, width: 5, stake: 1_000_000, chance: 990_000_000 },
            { second: 1, lo: AT - 5, width: 5, stake: 1_000_000, chance: 950_000_000 },
            { second: 1, lo: AT + 10, width: 5, stake: 1_000_000, chance: 906_000_000 },
            { second: 1, lo: AT - 10, width: 5, stake: 1_000_000, chance: 900_000_000 },
          ],
        },
      },
      // The price runs from nine units up to six down: every band is reached, so all five are hit.
      { bar: { ...flat(1, PRICE, at(9), at(-6)), settle: ["loser", "p"] } },
    ],
  },
  {
    ...std,
    name: "difficulty 100: the floor eases to 1x",
    difficulty: 100,
    steps: [{ place: { id: "p", difficulty: 100, sections: [{ second: 1, lo: AT, width: 5, stake: 20_000, chance: 950_000_000 }, { second: 2, lo: AT, width: 5, stake: 20_000, chance: 20_000_000 }] } }],
  },
  {
    ...std,
    name: "momentum takes its margin off the side the price moved toward only",
    steps: [
      {
        place: {
          id: "p",
          momentum: 1_500_000,
          sections: [
            { second: 3, lo: AT + 40, width: 5, stake: 20_000, chance: 123_700_000 },
            { second: 3, lo: AT - 45, width: 5, stake: 20_000, chance: 123_700_000 },
          ],
        },
      },
      { place: { id: "q", momentum: -3_000_000, sections: [{ second: 3, lo: AT - 45, width: 5, stake: 20_000, chance: 123_700_000 }, { second: 3, lo: AT + 40, width: 5, stake: 20_000, chance: 123_700_000 }] } },
    ],
  },
  {
    ...std,
    name: "a big band stakes only what 256 dots pay for; the rest is refunded",
    steps: [{ place: { id: "p", perDot: 10_000, sections: [{ second: 1, lo: AT, width: 5, stake: 4_000_000, chance: 10_000_000 }] } }],
  },
  {
    ...std,
    name: "a band with no chance is not offered; the rest goes in",
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 0 }, { second: 2, lo: AT, width: 5, stake: 50_000, chance: 400_000_000 }] } },
      { place: { id: "q", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 0 }] } },
    ],
  },
  {
    ...std,
    name: "a band whose second is already posted is not offered",
    steps: [
      { bar: { ...flat(1, PRICE), settle: [] } },
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }, { second: 2, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    ...std,
    name: "bands are judged one unit wider each way, inclusive",
    steps: [
      {
        place: {
          id: "p",
          sections: [
            { second: 1, lo: AT + 10, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT + 12, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT - 15, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT - 17, width: 5, stake: 30_000, chance: 200_000_000 },
          ],
        },
      },
      // The second runs from $83,000 up to exactly one unit under AT+10, and down to one unit over AT-15+5.
      { bar: { second: 1, prevClose: PRICE, high: at(9), low: at(-9), close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "the previous close counts: a jump across the ink crosses it",
    steps: [
      { place: { id: "p", sections: [{ second: 2, lo: AT + 20, width: 5, stake: 40_000, chance: 150_000_000 }] } },
      { bar: { ...flat(1, at(30)), settle: [] } },
      { bar: { second: 2, prevClose: at(30), high: at(-5), low: at(-10), close: at(-10), settle: ["p"] } },
    ],
  },
  {
    name: "a win the pool cannot pay is owed; the house's cut is not",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 10_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE, close: PRICE, settle: ["p"] } },
    ],
  },
  {
    name: "another player's losses are what pays a winner",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 20_000_000, chance: 900_000_000 }] } },
      { place: { id: "winner", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 10_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE, close: PRICE, settle: ["loser", "winner"] } },
    ],
  },
  {
    ...std,
    name: "fees round up, so dust stakes and small profits still pay them",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    steps: [
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 500_000_000 }] } },
      // A stake of 49 at 2%: 0.98 of a fee, taken as 1. Hit at 1.5x, 73 back: a profit of 24 at 10%, 2.4, taken as 3.
      { place: { id: "dust", sections: [{ second: 1, lo: AT, width: 5, stake: 49, chance: 500_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.3), low: PRICE, close: PRICE, settle: ["loser", "dust"] } },
    ],
  },
  {
    ...std,
    name: "fees at their bounds",
    feeBps: 2000,
    profitFeeBps: 5000,
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 99_999, chance: 250_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.3), low: PRICE, close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "refusals, and nothing moves for them",
    steps: [
      { place: { id: "difficulty", difficulty: 60, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "late", received: 201, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "stale", priceAge: 15_001, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "horizon", sections: [{ second: 31, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "perdot", perDot: 5_000, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "allowance", perDot: 1_000_000, sections: [{ second: 1, lo: AT, width: 5, stake: 5_000_001, chance: 500_000_000 }] } },
      { place: { id: "ok", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "ok", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    ...std,
    name: "a difficulty under 50 is refused, and pieces keep to the one set",
    steps: [
      { difficulty: 49 },
      { difficulty: 0 },
      { difficulty: 101 },
      { place: { id: "at49", difficulty: 49, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 1_000_000_000 }] } },
      { difficulty: 50 },
      { place: { id: "at50", difficulty: 50, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 1_000_000_000 }] } },
      { place: { id: "at51", difficulty: 51, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    name: "more than the balance is refused",
    players: { a: { deposit: 40_000, allowance: 5_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [{ place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } }],
  },

  /* ---- SKT: the Solana program's alone ---- */
  {
    ...skt,
    name: "SKT: a loss mints; then 3 of the 4 stake points and 8 of the 10 profit points accrue; a claim pays them, a second is refused",
    steps: [
      // B's dollar misses: no SKT yet, so the holders' 3 points of the fee go to the treasury.
      { place: { id: "lose", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 500_000_000 }] } },
      { bar: { ...flat(1, PRICE), settle: ["lose"] } },
      // A's nickel: 0.15 of its 0.2 fee to B's SKT, and 2 of its 2.5 profit fee when it hits.
      { place: { id: "win", sections: [{ second: 2, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { bar: { ...flat(2, PRICE), settle: ["win"] } },
      { claim: "b" },
      { claim: "b" },
      { claim: "a" },
    ],
  },
  {
    ...skt,
    name: "SKT: while a win is owed, the holders' share goes to the pool, and a loss mints on the curve all the same",
    steps: [
      { place: { id: "first", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 100_000, chance: 500_000_000 }] } },
      { bar: { ...flat(1, PRICE), settle: ["first"] } },
      // A 1% chance at 96x: far more than the pool holds, so most of it is owed.
      { place: { id: "long", sections: [{ second: 2, lo: AT, width: 5, stake: 50_000, chance: 10_000_000 }] } },
      { bar: { ...flat(2, PRICE), settle: ["long"] } },
      // Owed: B's stake fee's holder share goes to the pool, to pay A, not to B's SKT.
      { place: { id: "refill", player: "b", perDot: 1_000_000, sections: [{ second: 3, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 500_000_000 }] } },
      { bar: { ...flat(3, PRICE), settle: ["refill"] } },
      { claim: "b" },
    ],
  },
  {
    ...skt,
    name: "SKT: each miss mints on its odds-weighted loss, a hit on nothing, at the curve's falling rate",
    steps: [
      // A 1% long shot at 96x misses: 1.1¢ · (1 − 0.96 + 0.1 · 0.01 · 95) / 0.99, the profit fee a hit pays counted.
      { place: { id: "long", sections: [{ second: 1, lo: AT, width: 5, stake: 11_000, chance: 10_000_000 }] } },
      { bar: { ...flat(1, PRICE - e8(5)), settle: ["long"] } },
      // Ink at 50% paying 1.5x misses: 10¢ · 0.25 / 0.5. And a hit beside it, in the same piece: nothing for it.
      { place: { id: "near", sections: [{ second: 2, lo: AT + 5000, width: 5, stake: 100_000, chance: 500_000_000 }, { second: 2, lo: AT, width: 5, stake: 100_000, chance: 500_000_000 }] } },
      { bar: { second: 2, prevClose: PRICE - e8(5), high: PRICE, low: PRICE - e8(5), close: PRICE, settle: ["near"] } },
      // Two bands that miss in one settlement: their bases together, minted from where the tracked gain is.
      { place: { id: "two", player: "b", perDot: 1_000_000, sections: [{ second: 3, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 200_000_000 }, { second: 3, lo: AT - 5000, width: 5, stake: 2_000_000, chance: 900_000_000 }] } },
      { bar: { ...flat(3, PRICE), settle: ["two"] } },
    ],
  },
  {
    ...skt,
    skt: { ...SKT, walletCapBps: 1_000, capFloor: 20_000_000 },
    name: "SKT: no wallet past 10% of all SKT or of the floor (20 SKT), and every share counted against the larger",
    steps: [
      // B's dollar misses: 55 SKT by the curve, 2 by the cap (10% of the 20-SKT floor).
      { place: { id: "b1", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 500_000_000 }] } },
      { bar: { ...flat(1, PRICE), settle: ["b1"] } },
      // A's nickel: of the holders' 0.15¢, B's 2 SKT of the 20-SKT floor take a tenth; the rest is the treasury's.
      { place: { id: "a1", sections: [{ second: 2, lo: AT + 5000, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { bar: { ...flat(2, PRICE), settle: ["a1"] } },
      { claim: "b" },
      { claim: "a" },
    ],
  },
];

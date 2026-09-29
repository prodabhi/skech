import { describe, expect, test } from "bun:test";
import { hashTypedData, hashStruct, keccak256 } from "viem";
import { LADDER, ladderSection } from "./ink-area";
import { RULES, setDifficulty } from "./dots";
import { judge, type InkBet } from "./ink";
import {
  bestE3,
  betIdOf,
  CHANCE_ONE,
  chainSection,
  crosses,
  decodeStroke,
  domain,
  encodeStroke,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  floorE2,
  gridStep,
  grossE6,
  LADDER_E2,
  ladderOf,
  maxStakeE6,
  cutAt,
  MIN_DIFFICULTY,
  MIN_PIECE_STAKE,
  MIN_PIECE_STAKE_E6,
  BATCH_PIECE_STAKE_E6,
  onGrid,
  usdE6,
  rungE2,
  strokeHash,
  toSections,
  TYPES,
  unitFor,
} from "./chain";

/* The game deployed at 0x5Ec4…C0De on chain 31337, as `packages/contracts/evm/test/Vectors.t.sol` prints. */
const AT = "0x5Ec400000000000000000000000000000000C0De" as const;
const PLAYER = "0x0376AAc07Ad725E01357B1725B5ceC61aE10473c" as const;
const DOMAIN = domain(31337, AT);
const PIECE = {
  player: PLAYER,
  drawing: 7n,
  index: 3,
  market: 0,
  difficulty: 51,
  openAt: 1_790_000_000_000n,
  perDot: 100_000n,
  unit: 20_000_000n,
  priceSeen: 8_359_144_000_000n,
  priceTime: 1_789_999_999_500n,
  sections: [
    { second: 1, lo: 8_359_140_000_000n, hi: 8_359_200_000_000n, stake: 50_000n },
    { second: 2, lo: 8_359_240_000_000n, hi: 8_359_300_000_000n, stake: 50_000n },
  ],
  strokeHash: keccak256("0x0000000100000002"),
};

describe("typed data hashes as the contract computes them", () => {
  test("a piece", () => {
    expect(hashStruct({ types: TYPES, primaryType: "Piece", data: PIECE })).toBe("0x450274ecca0b06a26e4e47be5eee91db0685c1cc85c757fd6693fe250447b56f");
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Piece", message: PIECE })).toBe("0xe0850fe9057d6087f5758f62889b746db7e34fafe5b3cef382f55e3213150c13");
    expect(betIdOf(PLAYER, 7n, 3)).toBe("0x05c410b9373d69e7784340c4ab40860b261b9549acc1c507f092be715ad647ff");
  });
  test("a quote over it", () => {
    const message = {
      market: 0,
      openAt: 1_790_000_000_000n,
      unit: 20_000_000n,
      price: 8_359_144_000_000n,
      momentum: -1_500_000n,
      pieces: [hashStruct({ types: TYPES, primaryType: "Piece", data: PIECE })],
      receivedAt: [1_789_999_999_600n],
      chances: [500_000_000, 100_000_000],
    };
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Quote", message })).toBe("0x86dc0a949cd79d8e346df1b1656c4c90e7399d7e6a5b983c9a8ae1ffbdbc632f");
  });
  test("a bar", () => {
    const message = { market: 0, second: 1_790_000_001_000n, prevClose: 8_359_144_000_000n, high: 8_359_200_000_000n, low: 8_359_100_000_000n, close: 8_359_150_000_000n };
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Bar", message })).toBe("0xf25d1582e7313a1d2eca3761ef2d02da5b1a176ccc67daab4703f564783919f2");
  });
  test("a price, as the engine already signs it", () => {
    const message = { market: "BTC-USD", price: 8_359_144_000_000n, time: 1_790_629_278_967n };
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Price", message })).toBe("0xb7d6cae2163ad492576301aaed0f778cdfabba1d957910cd063c1418f8aff03c");
  });
  test("a session and a withdrawal", () => {
    const session = { player: PLAYER, kind: 0, key: "0x87110f79f69670eE8dEd56E2231882D06b2873F2", x: `0x${"0".repeat(64)}`, y: `0x${"0".repeat(64)}`, validUntil: 1_790_086_400n, allowance: 100_000_000n, nonce: 0n, deadline: 1_790_000_060n } as const;
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Session", message: session })).toBe("0x466838b86c7f14c51241cc5de67c8e6775309df2ad4ba86de26cc7dc12c659dd");
    const withdraw = { player: PLAYER, amount: 10_000_000n, to: "0x1111111111111111111111111111111111111111", nonce: 0n, deadline: 1_790_000_060n } as const;
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Withdraw", message: withdraw })).toBe("0x2c09669362820713082279fe5dfb11106539fd607e0f100b212ae02dc0480852");
  });
});

describe("EIP-3009, as USDC checks it", () => {
  test("the authorization's type hash is Circle's, read off USDC on Monad testnet", () => {
    const fields = RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization.map((f) => `${f.type} ${f.name}`).join(",");
    expect(keccak256(new TextEncoder().encode(`ReceiveWithAuthorization(${fields})`))).toBe("0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8");
  });
});

describe("the ladder, in integers", () => {
  test("difficulty sets the best and the floor as dots.ts does", () => {
    expect(MIN_DIFFICULTY).toBe(50);
    expect(bestE3(50)).toBe(1000);
    expect(bestE3(51)).toBe(996);
    expect(bestE3(100)).toBe(800);
    // Under the least, priced as the least: ink on a rung never returns more than a dollar.
    expect([0, 20, 49].map(bestE3)).toEqual([1000, 1000, 1000]);
    expect([0, 70, 71, 72, 75, 80, 85, 90, 95, 100].map(floorE2)).toEqual([110, 110, 110, 109, 108, 107, 105, 103, 102, 100]);
    for (let d = 0; d <= 100; d++) expect(bestE3(d) / 1000).toBe(ladderOf(d).best);
  });
  test("rungs at 51", () => {
    // Too likely for 1.1x: the fair multiple to the hundredth, never under 1x.
    expect(rungE2(1_000_000_000, 51, false, 0)).toBe(100);
    expect(rungE2(990_000_000, 51, false, 0)).toBe(100);
    expect(rungE2(950_000_000, 51, false, 0)).toBe(104);
    expect(rungE2(906_000_000, 51, false, 0)).toBe(109);
    expect(rungE2(905_454_545, 51, false, 0)).toBe(110);
    expect(rungE2(500_000_000, 51, false, 0)).toBe(150);
    expect(rungE2(498_000_000, 51, false, 0)).toBe(200);
    expect(rungE2(100_000_000, 51, false, 0)).toBe(800);
    expect(rungE2(10_000_000, 51, false, 0)).toBe(9600);
    expect(rungE2(1, 51, false, 0)).toBe(12800);
    expect(rungE2(0, 51, false, 0)).toBe(0);
    expect(rungE2(1_000_000_001, 51, false, 0)).toBe(0);
    expect(rungE2(600_000_000, 51, true, 1_000_000)).toBe(110);
    expect(rungE2(600_000_000, 51, false, 1_000_000)).toBe(150);
    expect(rungE2(520_000_000, 51, true, -3_000_000)).toBe(110);
  });
  test("the cap on one section", () => {
    expect(maxStakeE6(100_000n, 12800)).toBe(200_000n);
    expect(maxStakeE6(100_000n, 110)).toBe(23_272_727n);
    expect(grossE6(200_000n, 12800)).toBe(25_600_000n);
  });
  /* The chain's rung is the app's `ladderSection`, up to the integer rounding of the chance and the fair price. */
  test("agrees with ladderSection", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let off = 0;
    for (const d of [0, 20, 51, 55, 66, 70, 75, 90, 100]) {
      setDifficulty(d);
      for (let i = 0; i < 2000; i++) {
        const p = Math.exp(-rand() * 9); // 1 down to ~1e-4
        const withIt = rand() < 0.5;
        const momentum = (rand() - 0.5) * 6;
        const margin = withIt ? RULES.momentumMargin * Math.min(2, Math.abs(momentum)) : 0;
        const pE9 = Math.round(p * 1e9);
        // The chain sees the chance in billionths and the fair price in thousandths.
        const app = ladderSection(pE9 / 1e9, RULES.rtp - margin, 1)!;
        const chain = chainSection(pE9, d, withIt, Math.round(momentum * 1e6), 1)!;
        if (Math.abs(chain.multiple - app.multiple) > 1e-9) {
          // Only where the fair price is within the chain's rounding (a thousandth) of a rung, or of a hundredth under the floor.
          const fair = (RULES.ladderBest - margin) / (pE9 / 1e9);
          const near = LADDER.some((r) => Math.abs(fair - r) < 3e-3) || (fair < RULES.ladderFloor + 3e-3 && Math.abs(fair * 100 - Math.round(fair * 100)) < 0.3);
          if (!near) throw new Error(`d ${d} p ${p} withIt ${withIt} m ${momentum}: app ${app.multiple} chain ${chain.multiple}`);
          off++;
        }
      }
    }
    setDifficulty(55);
    expect(off).toBeLessThan(50);
  });
  /* The reviewer's invariant: at any chance and any difficulty the chain allows, a band returns at most a dollar per dollar before fees. */
  test("no band returns more than it stakes, on average", () => {
    const chances = new Set<number>([1, 2, 999, 1_000_000_000]);
    for (let i = 0; i <= 3000; i++) chances.add(Math.max(1, Math.round(1e9 * Math.exp((-i / 3000) * 21))));
    for (let c = 850_000_000; c <= 1_000_000_000; c += 1_000_000) chances.add(c);
    // And either side of every rung, and of every hundredth under the floor, at every difficulty.
    for (let d = MIN_DIFFICULTY; d <= 100; d++) {
      for (const r of [...LADDER_E2, ...Array.from({ length: 11 }, (_, k) => 100 + k)]) {
        const at = Math.floor((bestE3(d) * 1_000_000) / (r * 10));
        for (const c of [at - 1, at, at + 1]) if (c > 0 && c <= CHANCE_ONE) chances.add(c);
      }
    }
    const momenta = [0, 1, -1, 500_000, 1_000_000, -1_999_999, 2_000_000, 7_000_000];
    let rows = 0;
    for (let d = MIN_DIFFICULTY; d <= 100; d++) {
      for (const c of chances) {
        for (const withIt of [false, true]) {
          for (const m of withIt ? momenta : [0]) {
            const r = rungE2(c, d, withIt, m);
            // chance x rung <= 1: in integers, chanceE9 x rungE2 <= 1e9 x 100.
            if (r < 100 || c * r > 100 * CHANCE_ONE) throw new Error(`d ${d} chance ${c} withIt ${withIt} m ${m}: rung ${r} returns ${(c * r) / 1e11}`);
            rows++;
          }
        }
      }
    }
    expect(rows).toBeGreaterThan(1_000_000);
  });
});

describe("the grid", () => {
  test("a market step of $10 gives 20 cent units and a step for areaCells of $2", () => {
    expect(unitFor(10)).toBe(0.2);
    expect(gridStep(10)).toBeCloseTo(2, 12);
    expect(onGrid(83591.44, 0.2)).toBe(8_359_140_000_000n);
  });
  test("the app's sections become bands on the grid with a stake of the area", () => {
    const openAt = 1_790_000_000_000;
    const cells = [
      { t: openAt + 1000, lo: 83591.4, hi: 83592, area: 0.5 },
      { t: openAt + 2000, lo: 83592.4, hi: 83593, area: 0.25 },
      { t: openAt + 31_000, lo: 83592.4, hi: 83593, area: 0.25 }, // past the horizon
    ];
    const s = toSections(cells, openAt, 100_000n, 0.2);
    expect(s).toEqual([
      { second: 1, lo: 8_359_140_000_000n, hi: 8_359_200_000_000n, stake: 50_000n },
      { second: 2, lo: 8_359_240_000_000n, hi: 8_359_300_000_000n, stake: 25_000n },
    ]);
  });
});

describe("strokes as bytes", () => {
  test("round trip", () => {
    const s = { t0: 1_790_000_000_123, p0: 83591.44, rt: 250, rp: 1.75, from: 4, pts: [{ t: 0, p: 0 }, { t: 90, p: -0.53 }, { t: 180, p: 2.11 }] };
    const hex = encodeStroke(s);
    expect(hex.length).toBe(2 + (33 + 3 * 12) * 2);
    expect(decodeStroke(hex)).toEqual(s);
    expect(strokeHash("0x0000000100000002")).toBe(keccak256("0x0000000100000002"));
  });
});

describe("judging, as the chain judges", () => {
  const unit = 20_000_000n;
  const lo = 8_359_140_000_000n;
  const hi = 8_359_200_000_000n;
  test("the band is one unit wider each way, inclusive", () => {
    expect(crosses({ prevClose: lo - 5n * unit, high: lo - unit, low: lo - 6n * unit }, lo, hi, unit)).toBe(true);
    expect(crosses({ prevClose: lo - 5n * unit, high: lo - unit - 1n, low: lo - 6n * unit }, lo, hi, unit)).toBe(false);
    expect(crosses({ prevClose: hi + 5n * unit, high: hi + 6n * unit, low: hi + unit }, lo, hi, unit)).toBe(true);
    expect(crosses({ prevClose: hi + 5n * unit, high: hi + 6n * unit, low: hi + unit + 1n }, lo, hi, unit)).toBe(false);
  });
  test("a jump across the band from the second before counts", () => {
    expect(crosses({ prevClose: lo - 10n * unit, high: hi + 10n * unit, low: hi + 5n * unit }, lo, hi, unit)).toBe(true);
  });
  test("agrees with the app's judge", () => {
    const step = 2; // gridStep(10): cells 0.2 tall, pad one cell
    const bet: InkBet = {
      model: "ladder-v1", stakeRounding: "up", edgeCells: 1, id: "x", placedAt: 0, openAt: 1_790_000_000_000, perUnit: 0.1, step, cell: 0.1,
      stroke: { t0: 0, p0: 0, pts: [{ t: 0, p: 0 }], rt: 1, rp: 1 }, drawn: [],
      cells: [{ t: 1_790_000_001_000, lo: 83591.4, hi: 83592, area: 0.5, multiple: 1.5, status: "live" }], status: "live",
    };
    for (const [prev, h, l] of [[83591.0, 83591.2, 83590.9], [83591.0, 83591.19, 83590.9], [83592.6, 83592.8, 83592.2], [83592.6, 83592.8, 83592.21], [83590.0, 83594.0, 83593.0]]) {
      const app = judge(bet, { t: 1_790_000_001_000, h, l, c: h }, true, prev).cells[0].status === "hit";
      const chain = crosses({ prevClose: BigInt(Math.round(prev * 1e8)), high: BigInt(Math.round(h * 1e8)), low: BigInt(Math.round(l * 1e8)) }, lo, hi, unit);
      expect(chain).toBe(app);
    }
  });
});

describe("the least a piece stakes", () => {
  // A line as the dots it covers at each read: the area is the mark itself. Pieces of 10¢, as the apps gather them.
  const BATCH = BATCH_PIECE_STAKE_E6;
  const areaOf = (s: number | null) => s ?? 0;
  const at = (perDot: number) => BigInt(Math.round(perDot * 1e6));

  test("is 1¢, gathered into 10¢ while drawing, and says so", () => {
    expect(MIN_PIECE_STAKE_E6).toBe(10_000n);
    expect(MIN_PIECE_STAKE).toBe(0.01);
    expect(usdE6(MIN_PIECE_STAKE_E6)).toBe("$0.01");
    expect(BATCH_PIECE_STAKE_E6).toBe(100_000n);
    expect(usdE6(BATCH_PIECE_STAKE_E6)).toBe("$0.10");
  });

  test("holds ink until a piece and what follows it both reach it", () => {
    // 5¢ a dot: 10¢ is two dots. Three dots drawn, nothing marked yet: nothing to cut at.
    expect(cutAt(null, [], 3, areaOf, at(0.05), BATCH)).toBe(-1);
    // Marked at 1 and 2.5: 2.5 has only half a dot after it, 1 has two but only one before it.
    expect(cutAt(null, [1, 2.5], 3, areaOf, at(0.05), BATCH)).toBe(-1);
    // At 4.5 the mark at 2.5 has two dots each side: the piece goes up to it.
    expect(cutAt(null, [1, 2.5], 4.5, areaOf, at(0.05), BATCH)).toBe(1);
    // After a piece at 2.5, the next is held the same way.
    expect(cutAt(2.5, [3, 4.5], 5, areaOf, at(0.05), BATCH)).toBe(-1);
    expect(cutAt(2.5, [3, 4.5], 6.6, areaOf, at(0.05), BATCH)).toBe(1);
  });

  test("at a dollar a dot, every read but the last goes", () => {
    expect(cutAt(null, [0.2], 0.4, areaOf, at(1), BATCH)).toBe(0);
    expect(cutAt(0.2, [0.4, 0.6], 0.8, areaOf, at(1), BATCH)).toBe(1);
    // Under a tenth of a dot since the last mark: the one before it is the cut.
    expect(cutAt(0.2, [0.4, 0.75], 0.8, areaOf, at(1), BATCH)).toBe(0);
  });

  test("cut at 10¢, with only 1¢ kept back for the end of the line", () => {
    // 5¢ a dot: the piece needs two dots before the cut, the end a fifth of one after it.
    expect(cutAt(null, [1, 2.5], 2.6, areaOf, at(0.05), BATCH, MIN_PIECE_STAKE_E6)).toBe(-1);
    expect(cutAt(null, [1, 2.5], 2.7, areaOf, at(0.05), BATCH, MIN_PIECE_STAKE_E6)).toBe(1);
    expect(cutAt(null, [1, 1.5], 1.9, areaOf, at(0.05), BATCH, MIN_PIECE_STAKE_E6)).toBe(-1);
  });

  test("with no least, the latest mark", () => {
    expect(cutAt(null, [0.01, 0.02], 0.03, areaOf, at(0.05), 0n)).toBe(1);
  });
});

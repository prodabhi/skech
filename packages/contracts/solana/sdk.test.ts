import { expect, test } from "bun:test";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import vectors from "./tests/vectors/piece.json";
import { exp2Q32 as referenceExp2 } from "../conformance/reference";
import { ACC_SCALE, claimableE6, DEFAULT_CONFIG, exp2Q32, maxPiecePayoutE6, sktNowE6, DEFAULT_REWARDS_CONFIG, domainFor, ed25519Instruction, findRewardsPda, holderAddress, pieceBytes, rewardsAddress, SKECH_PROGRAM_ADDRESS } from "./sdk";

test("the client is for the program the vectors come from", () => {
  expect(SKECH_PROGRAM_ADDRESS as string).toBe(address(vectors.program));
});

test("the domain is what the program computes", async () => {
  expect([...(await domainFor(SKECH_PROGRAM_ADDRESS, "devnet"))]).toEqual(vectors.domain);
});

test("a piece's signed bytes are its Borsh encoding, as the program reads it", async () => {
  const bytes = pieceBytes({
    domain: Uint8Array.from(vectors.domain),
    player: address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
    drawing: 1_790_000_123_456n,
    index: 7,
    market: 0,
    difficulty: 40,
    openAt: 1_790_000_001_000n,
    perDot: 100_000,
    unit: 20_000_000n,
    priceSeen: 8_300_012_345_678n,
    priceTime: 1_790_000_000_450n,
    strokeHash: new Uint8Array(32).fill(0xab),
    sections: [
      { second: 1, lo: 415_000, width: 5, stake: 50_000 },
      { second: 30, lo: 414_990, width: 12, stake: 4_294_967_295 },
    ],
  });
  expect([...bytes]).toEqual(vectors.piece);
});

test("the Ed25519 instruction points at the piece inside place", () => {
  const ix = ed25519Instruction(new Uint8Array(32).fill(1), new Uint8Array(64).fill(2), 2, 172);
  const d = ix.data!;
  const v = new DataView(d.buffer, d.byteOffset);
  expect(d.length).toBe(112);
  expect([d[0], v.getUint16(2, true), v.getUint16(4, true), v.getUint16(6, true), v.getUint16(8, true), v.getUint16(10, true), v.getUint16(12, true), v.getUint16(14, true)]).toEqual([1, 48, 0xffff, 16, 0xffff, 8, 172, 2]);
});

test("the default config is the EVM game's, as SkechGame.initialize writes it", async () => {
  const sol = await Bun.file(new URL("../evm/src/SkechGame.sol", import.meta.url)).text();
  const init = sol.slice(sol.indexOf("function initialize("));
  const body = init.slice(init.indexOf("Config({") + 8, init.indexOf("})"));
  const evm = Object.fromEntries(
    body
      .split("\n")
      .map((l) => l.split("//")[0].trim().replace(/,$/, ""))
      .filter(Boolean)
      .map((l) => l.split(":").map((x) => x.trim()))
      .map(([k, v]) => [k, BigInt(v.replaceAll("_", ""))]),
  );
  const { maxSessionSecs: _, ...shared } = DEFAULT_CONFIG;
  expect(Object.fromEntries(Object.entries(shared).map(([k, v]) => [k, BigInt(v)]))).toEqual(evm);
});

test("SKT's addresses are the program's", async () => {
  const wallet = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  // The program opens a holder at ["holder", wallet] (settle.rs, open_holder).
  const [holder] = await getProgramDerivedAddress({ programAddress: SKECH_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode("holder"), getAddressEncoder().encode(wallet)] });
  expect(await holderAddress(wallet)).toBe(holder);
  expect(await rewardsAddress()).toBe((await findRewardsPda())[0]);
});

test("SKT's default split is part of each default fee", () => {
  expect(DEFAULT_REWARDS_CONFIG.holderFeeBps).toBeLessThanOrEqual(DEFAULT_CONFIG.feeBps);
  expect(DEFAULT_REWARDS_CONFIG.holderProfitFeeBps).toBeLessThanOrEqual(DEFAULT_CONFIG.profitFeeBps);
  expect([DEFAULT_CONFIG.feeBps - DEFAULT_REWARDS_CONFIG.holderFeeBps, DEFAULT_CONFIG.profitFeeBps - DEFAULT_REWARDS_CONFIG.holderProfitFeeBps]).toEqual([100, 200]);
});

test("what is claimable is what was counted and what the shares earned since, rounded down", () => {
  const r = { acc: 0n, era: 0, eraEnds: Array(8).fill(0n) as bigint[] };
  expect(claimableE6({ shares: 100_000_000n, era: 0, accAt: 0n, unclaimed: 7n }, r)).toBe(7n);
  // 1,500 shared over 99,999,000 shares: the one holder gets 1,499.
  const acc = (1_500n * ACC_SCALE) / 99_999_000n;
  expect(claimableE6({ shares: 99_999_000n, era: 0, accAt: 0n, unclaimed: 0n }, { ...r, acc })).toBe(1_499n);
  expect(claimableE6({ shares: 99_999_000n, era: 0, accAt: acc, unclaimed: 5n }, { ...r, acc })).toBe(5n);
  // Two eras on: era 0's end on its shares, era 1's on them divided by 2^16, and this era's on them divided by 2^32.
  const ends = Array(8).fill(0n) as bigint[];
  ends[0] = acc;
  ends[1] = acc * 65_536n;
  const h = { shares: 99_999_000n * 65_536n * 65_536n, era: 0, accAt: 0n, unclaimed: 0n };
  const got = claimableE6(h, { acc: acc * 65_536n * 65_536n, era: 2, eraEnds: ends });
  expect(got).toBe((h.shares * acc) / ACC_SCALE + ((h.shares >> 16n) * ends[1]) / ACC_SCALE + ((h.shares >> 32n) * acc * 65_536n * 65_536n) / ACC_SCALE);
});

test("SKT halves every half-life, eras and all, as the program counts it", () => {
  const config = DEFAULT_REWARDS_CONFIG;
  const rewards = { anchorLog2: 0n, anchorTime: 0n, era: 0, config };
  const h = { shares: 1_000_000_000_000n, era: 0 };
  const half = BigInt(config.halfLifeSecs);
  expect(sktNowE6(h, rewards, 0n)).toBe(1_000_000_000_000n);
  for (const k of [1n, 2n, 10n, 15n, 16n, 17n, 40n]) {
    const want = 1_000_000_000_000 / 2 ** Number(k);
    const got = Number(sktNowE6(h, rewards, k * half));
    expect(Math.abs(got - want)).toBeLessThanOrEqual(1 + want * 1e-9);
  }
  // The same table as the conformance reference's (and so the program's): 2^0.5 and 2^15.75.
  for (const l of [1n << 31n, (15n << 32n) + (3n << 30n), 123_456_789n]) expect(exp2Q32(l)).toBe(referenceExp2(l));
});

test("the default reserve is three times what one piece can pay at the default terms", () => {
  expect(maxPiecePayoutE6(DEFAULT_CONFIG)).toBe(819_200_000_000n);
  expect(DEFAULT_REWARDS_CONFIG.surplusReserve).toBe(3n * 819_200_000_000n);
  // Of the surplus, three quarters to holders.
  expect(DEFAULT_REWARDS_CONFIG.surplusHolderBps).toBe(7_500);
});

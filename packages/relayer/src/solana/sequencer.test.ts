import { describe, expect, test } from "bun:test";
import { MIN_PIECE_STAKE_E6 } from "@skech/core/chain";
import type { Engine } from "../engine";
import type { Pricer } from "../pricer";
import type { SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";
import { type SolanaPieceMsg, SolanaSequencer, tooLittle } from "./sequencer";
import type { SolanaSettler } from "./settler";

const PLAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const cfg = { deployment: { program: "11111111111111111111111111111111" }, market: 0, lateMs: 200, aheadMs: 1500 } as unknown as SolanaConfig;
// No prices yet: a piece that gets past the least is turned away for that, next.
const engine = { now: () => Date.now(), ready: () => false, book: { bars: [] } } as unknown as Engine;
const sequencer = () =>
  new SolanaSequencer(cfg, engine, {} as Pricer, {} as SolanaChain, {} as SolanaSettler, { placed: () => {}, refused: () => {} }, () => {}, new Uint8Array(32));

let index = 0;
const msg = (stakes: number[]): SolanaPieceMsg => ({
  type: "piece",
  piece: {
    player: PLAYER,
    drawing: "7",
    index: index++,
    market: 0,
    difficulty: 40,
    openAt: String(Math.ceil(Date.now() / 1000) * 1000),
    perDot: 50_000,
    unit: "100000000",
    priceSeen: "6000000000000",
    priceTime: String(Date.now()),
    strokeHash: `0x${"00".repeat(32)}`,
    sections: stakes.map((stake, i) => ({ second: i + 1, lo: 60_000, width: 2, stake })),
  },
  sessionSig: `0x${"00".repeat(64)}`,
  priceSig: `0x${"00".repeat(65)}`,
  stroke: "0x01",
});

describe("the least a piece stakes", () => {
  test("says why, in dollars", () => {
    expect(tooLittle(9_999n, 10_000n)).toBe("A piece must be at least $0.01");
    expect(tooLittle(10_000n, 10_000n)).toBeNull();
    expect(tooLittle(1n, 0n)).toBeNull();
  });

  test("is 1¢ unless set", () => {
    expect(MIN_PIECE_STAKE_E6).toBe(10_000n);
    expect(sequencer().terms.minPieceStake).toBe(MIN_PIECE_STAKE_E6);
  });

  test("turns a piece under it away as it arrives, its sections added up", async () => {
    const s = sequencer();
    const small = await s.accept(msg([4_000, 5_999]));
    expect(small.ok).toBe(false);
    expect(!small.ok && small.why).toBe("A piece must be at least $0.01");
    expect(!small.ok && small.betId).toBeDefined();
    expect(s.stats.turnedAway["A piece must be at least $N.N"]).toBe(1);
    // At the least, a single dot at 5¢ a dot, the piece goes on to the next look.
    const dot = await s.accept(msg([50_000]));
    expect(!dot.ok && dot.why).toBe("Waiting for live prices");
  });

  test("follows the relayer's figure", async () => {
    const s = sequencer();
    s.terms = { ...s.terms, minPieceStake: 250_000n };
    const r = await s.accept(msg([200_000]));
    expect(!r.ok && r.why).toBe("A piece must be at least $0.25");
    s.terms = { ...s.terms, minPieceStake: 0n };
    const any = await s.accept(msg([1]));
    expect(!any.ok && any.why).toBe("Waiting for live prices");
  });
});

describe("certain ink", () => {
  test("a band taller than the widest pen is turned away as it arrives", async () => {
    const s = sequencer();
    const m = msg([50_000]);
    m.piece.sections[0].width = 65;
    const r = await s.accept(m);
    expect(!r.ok && r.why).toBe("Band too tall");
    m.piece.sections[0].width = 64;
    m.piece.index = index++;
    const ok = await s.accept(m);
    expect(!ok.ok && ok.why).toBe("Waiting for live prices");
  });

  test("a band returning more than the stake fee leaves is not placed, as the program has it", () => {
    const s = sequencer() as unknown as { settler: { posted: () => boolean }; predict: (p: unknown, bands: unknown[], chances: number[], price: bigint, momentum: number) => { sections: unknown[]; staked: bigint; refunded: bigint } };
    (s as unknown as { settler: unknown }).settler = { posted: () => false };
    const p = { openAt: 1_000n, difficulty: 50, perDot: 100_000 };
    const band = (second: number) => ({ second, lo: 100n, hi: 200n, stake: 10_000n });
    // At d = 50, 50% earns 2x: p·m = 1.0, over 0.96. At 40%, 2x too, p·m = 0.8: offered. Certain ink at 1x: not.
    const r = s.predict(p, [band(1), band(2), band(3)], [500_000_000, 400_000_000, 1_000_000_000], 10_000n, 0);
    expect(r.sections.length).toBe(1);
    expect(r.staked).toBe(10_000n);
    expect(r.refunded).toBe(20_000n);
  });
});

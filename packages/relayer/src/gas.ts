/**
 * Gas limits, worked out, not estimated.
 *
 * Monad charges a transaction its gas limit, not what it used, and its receipts
 * report the limit as used: the limit has to be right before sending, and every
 * unit over it is money. EVM gas is deterministic, so for the relayer's own
 * transactions it follows from the shape of the call: how many pieces, bands and
 * bytes of stroke; how many bars and bets. The coefficients are measured by
 * packages/contracts/evm/test/GasModel.t.sol, each in the worst state it can meet,
 * at Monad's own prices, and land in snapshots/GasModel.json. This file adds
 * them up, puts back the transaction's own 21,000 and its calldata, and leaves
 * a small margin.
 */
import snapshot from "@skech/contracts/evm/snapshots/GasModel.json";
import type { Hex } from "viem";

const table = snapshot as Record<string, string>;
const n = (name: string): bigint => {
  const v = table[name];
  if (v === undefined) throw new Error(`GasModel.json has no ${name}: run forge test in packages/contracts/evm`);
  return BigInt(v);
};

export const MODEL = {
  place: {
    base: n("place.base"),
    piece: n("place.piece"),
    section: n("place.section"),
    byte: n("place.byte"),
    coldSlot: n("place.coldSlot"),
    pageSlack: n("place.pageSlack"),
  },
  settle: {
    txBase: n("settle.txBase"),
    bar: n("settle.bar"),
    barExtra: n("settle.barExtra"),
    bet: n("settle.bet"),
    live: n("settle.live"),
    hit: n("settle.hit"),
    coldFees: n("settle.coldFees"),
    iou: n("settle.iou"),
    pageSlack: n("settle.pageSlack"),
  },
  redeem: n("redeem"),
  session: n("session"),
};

export type Shape =
  /** `place`: pieces, their bands in all, their strokes' bytes in all, and how many of the pool and the fees are zero. */
  | { kind: "place"; pieces: number; sections: number; strokeBytes: number; coldSlots: number }
  /** `postBar(s)AndSettle`: bars posted, bets settled, their live bands in all, how many pay, how many are owed IOUs, whether the fees are zero. */
  | { kind: "settle"; bars: number; bets: number; liveSections: number; hits: number; ious: number; coldFees: boolean }
  | { kind: "redeem" }
  | { kind: "session" };

/** The measured model alone: what GasModel.t.sol checks its batches against. */
export function bareExecutionGas(s: Shape): bigint {
  switch (s.kind) {
    case "place": {
      const m = MODEL.place;
      return m.base + BigInt(s.pieces) * m.piece + BigInt(s.sections) * m.section + BigInt(s.strokeBytes) * m.byte + BigInt(s.coldSlots) * m.coldSlot;
    }
    case "settle": {
      const m = MODEL.settle;
      let g = m.txBase;
      if (s.bars > 0) g += m.bar + BigInt(s.bars - 1) * m.barExtra;
      g += BigInt(s.bets) * m.bet + BigInt(s.hits) * m.hit + BigInt(s.ious) * m.iou + BigInt(Math.max(0, s.liveSections - s.bets)) * m.live;
      if (s.coldFees && s.hits > 0) g += m.coldFees;
      return g;
    }
    case "redeem":
      return MODEL.redeem;
    case "session":
      return MODEL.session;
  }
}

/** Execution gas for a shape, with room for a bet's or a session's words straddling two storage pages on chain. */
export function executionGas(s: Shape): bigint {
  const bare = bareExecutionGas(s);
  if (s.kind === "place") return bare + BigInt(s.pieces) * MODEL.place.pageSlack;
  if (s.kind === "settle") return bare + BigInt(s.bets) * MODEL.settle.pageSlack;
  return bare;
}

/**
 * What the transaction itself costs: 21,000, and its calldata at 16 a byte set and 4 a byte clear. `floor` is
 * EIP-7623's: 10 a token, a clear byte one token and a set byte four; a transaction is charged at least that.
 */
export function intrinsicGas(data: Hex): { standard: bigint; floor: bigint } {
  const hex = data.length % 2 ? data.slice(2) + "0" : data.slice(2);
  let zero = 0;
  let set = 0;
  for (let i = 0; i < hex.length; i += 2) {
    if (hex[i] === "0" && hex[i + 1] === "0") zero++;
    else set++;
  }
  const tokens = BigInt(zero + 4 * set);
  return { standard: 21_000n + 4n * tokens, floor: 21_000n + 10n * tokens };
}

/** Over the model, for what the measurements cannot see. */
export const MARGIN_BPS = 500n;

/** The gas limit to send with: the model, the transaction's own cost, the margin and `slackBps` more, up to the next thousand. */
export function gasLimit(shape: Shape, data: Hex, slackBps = 0n): bigint {
  const { standard, floor } = intrinsicGas(data);
  const used = standard + executionGas(shape);
  const total = used > floor ? used : floor;
  const withMargin = total + (total * (MARGIN_BPS + slackBps)) / 10_000n;
  return ((withMargin + 999n) / 1000n) * 1000n;
}

export function describe(s: Shape): string {
  switch (s.kind) {
    case "place":
      return `${s.pieces} piece${s.pieces === 1 ? "" : "s"}, ${s.sections} band${s.sections === 1 ? "" : "s"}, ${s.strokeBytes} B of stroke${s.coldSlots ? `, ${s.coldSlots} cold` : ""}`;
    case "settle":
      return `${s.bars} bar${s.bars === 1 ? "" : "s"}, ${s.bets} bet${s.bets === 1 ? "" : "s"}, ${s.liveSections} live, ${s.hits} hit${s.ious ? `, ${s.ious} owed` : ""}${s.coldFees && s.hits ? ", cold fees" : ""}`;
    default:
      return s.kind;
  }
}


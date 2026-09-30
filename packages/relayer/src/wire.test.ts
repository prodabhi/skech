/**
 * Nothing an app sends can throw: each message is an object of a known type with every field it is read for in
 * shape, or it is answered with why, in the reply the app is waiting for.
 */
import { describe, expect, test } from "bun:test";
import { big, read, refusal, SOLANA, U64_MAX } from "./wire";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const hex = (bytes: number, fill = "ab") => `0x${fill.repeat(bytes)}`;
const section = { second: 1, lo: 417957, width: 4, stake: 50_000 };
const piece = {
  player: WALLET,
  drawing: "1790000000000",
  index: 3,
  market: 0,
  difficulty: 55,
  openAt: "1790000001000",
  perDot: 100_000,
  unit: "20000000",
  priceSeen: "8359150000000",
  priceTime: "1790000000500",
  strokeHash: "ab".repeat(32),
  sections: [section],
};
const pieceMsg = { type: "piece", piece, sessionSig: hex(64), priceSig: hex(65), stroke: "ab".repeat(33) };
const solana = (m: unknown) => read(JSON.stringify(m), SOLANA);
const why = (r: ReturnType<typeof read>) => ("why" in r ? r.why : null);

describe("what is not a message", () => {
  test("null, and every other JSON that is not an object, is turned away", () => {
    for (const raw of ["null", "1", '"piece"', "[]", '[{"type":"piece"}]', "true"]) expect(why(read(raw, SOLANA))).toBe("Not a message");
  });
  test("text that is not JSON", () => {
    expect(why(read("{nope", SOLANA))).toBe("Not JSON");
    expect(why(read(Buffer.from([0xff, 0x00]), SOLANA))).toBe("Not JSON");
  });
  test("a type this relayer does not know, or none", () => {
    expect(why(solana({ type: "drain" }))).toBe("Unknown message drain");
    expect(why(solana({ type: "toString" }))).toBe("Unknown message toString");
    expect(why(solana({ type: 7 }))).toBe("Unknown message 7");
    expect(why(solana({ player: WALLET }))).toBe("Unknown message undefined");
    // What a wallet signs is built here and submitted, never sent as a message of its own.
    expect(why(solana({ type: "session", player: WALLET }))).toBe("Unknown message session");
  });
});

describe("a piece", () => {
  test("as the app sends it passes", () => {
    expect(why(solana(pieceMsg))).toBeNull();
  });
  test("with a section that is null, or not an object, says which", () => {
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [null] } }))).toBe("Bad piece.sections.0");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [section, 5] } }))).toBe("Bad piece.sections.1");
    expect(why(solana({ ...pieceMsg, piece: null }))).toBe("Bad piece");
  });
  test("with a band taller than the widest pen", () => {
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, width: 65 }] } }))).toBe("Bad piece.sections.0.width");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, width: 64 }] } }))).toBeNull();
  });

  test("with more sections than a piece holds, or none", () => {
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: Array(33).fill(section) } }))).toBe("Bad piece.sections");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [] } }))).toBe("Bad piece.sections");
  });
  test("with a field of the wrong type or out of range", () => {
    expect(why(solana({ ...pieceMsg, piece: { ...piece, player: "0OIl" } }))).toBe("Bad piece.player");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, index: -1 } }))).toBe("Bad piece.index");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, index: "3" } }))).toBe("Bad piece.index");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, difficulty: 101 } }))).toBe("Bad piece.difficulty");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, second: 31 }] } }))).toBe("Bad piece.sections.0.second");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, width: 0 }] } }))).toBe("Bad piece.sections.0.width");
    expect(why(solana({ ...pieceMsg, priceSig: hex(64) }))).toBe("Bad priceSig");
    expect(why(solana({ ...pieceMsg, stroke: "abc" }))).toBe("Bad stroke");
    expect(why(solana({ ...pieceMsg, stroke: "ab".repeat(33 + 2048 * 12 + 1) }))).toBe("Bad stroke");
  });
  test("a number past uint64 is refused; uint64's largest is not", () => {
    expect(why(solana({ ...pieceMsg, piece: { ...piece, unit: (U64_MAX + 1n).toString() } }))).toBe("Bad piece.unit");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, unit: "99999999999999999999" } }))).toBe("Bad piece.unit");
    expect(why(solana({ ...pieceMsg, piece: { ...piece, unit: U64_MAX.toString() } }))).toBeNull();
    expect(why(solana({ ...pieceMsg, piece: { ...piece, unit: 2 ** 53 } }))).toBe("Bad piece.unit");
  });
  test("big() reads a chain number, and nothing past uint64", () => {
    expect(big(U64_MAX.toString())).toBe(U64_MAX);
    expect(big((U64_MAX + 1n).toString())).toBeNull();
    expect(big("1".repeat(30))).toBeNull();
    expect(big(5)).toBe(5n);
    expect(big(2 ** 53)).toBeNull();
    expect(big(-1)).toBeNull();
    expect(big("0x10")).toBeNull();
  });
  test("is refused with an ack the app can match to what it sent", () => {
    const r = solana({ ...pieceMsg, piece: { ...piece, sections: [null] } });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "ack", ok: false, why: "Bad piece.sections.0", index: 3, drawing: "1790000000000" });
  });
});

describe("what the wallet signs", () => {
  test("build by kind, answered as built", () => {
    expect(why(solana({ type: "build", kind: "session", player: WALLET, key: WALLET, validUntil: "1790086400", allowance: "20000000", approve: "5000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "deposit", player: WALLET, amount: "10000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "withdraw", player: WALLET, amount: "1000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "revoke", player: WALLET }))).toBeNull();
    expect(why(solana({ type: "build", kind: "claim", player: WALLET }))).toBeNull();
    expect(why(solana({ type: "build", kind: "claim" }))).toBe("Bad player");
    const r = solana({ type: "build", kind: "deposit", player: WALLET, amount: -1 });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "built", kind: "deposit", ok: false, why: "Bad amount" });
    expect(why(solana({ type: "build", kind: "mint", player: WALLET }))).toBe("Bad kind");
    expect(why(solana({ type: "build", kind: "withdraw", player: WALLET, amount: "1000000", to: "me" }))).toBe("Bad to");
  });
  test("submit, answered as submitted with its id", () => {
    expect(why(solana({ type: "submit", id: "0b9c", tx: "AQID", approve: true }))).toBeNull();
    const r = solana({ type: "submit", id: "0b9c", tx: "not base64!" });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "submitted", id: "0b9c", ok: false, why: "Bad tx" });
    expect(why(solana({ type: "submit", id: "x".repeat(65), tx: "AQID" }))).toBe("Bad id");
  });
  test("watch needs an address; activity may name one or not", () => {
    expect(why(solana({ type: "watch" }))).toBe("Bad player");
    expect(why(solana({ type: "activity" }))).toBeNull();
    expect(why(solana({ type: "activity", player: null }))).toBeNull();
    expect(why(solana({ type: "activity", player: 12 }))).toBe("Bad player");
  });
});

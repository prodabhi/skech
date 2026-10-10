import { describe, expect, test } from "bun:test";
import type { BetCell, InkBet } from "./ink";
import { confirmPiece, expireCells, holdIds, Holds, paidOnChain, pay, type Payout, refusalLine, refusals, REFUSALS_MERGE_MS, unpay } from "./optimistic";

const FEE = 1000;
const cell = (t: number, lo: number, hi: number, over: Partial<BetCell> = {}): BetCell => ({ t, lo, hi, area: 0.5, multiple: 2, status: "live", ...over });
const piece = (over: Partial<InkBet> = {}): InkBet => ({
  model: "ladder-v1",
  stakeRounding: "up",
  id: "line:0",
  group: "line",
  placedAt: 0,
  openAt: 10_000,
  perUnit: 0.1,
  step: 1,
  cell: 0.5,
  stroke: { t0: 0, p0: 0, pts: [{ t: 0, p: 0 }], rt: 1, rp: 1 },
  drawn: [cell(11_000, 100, 101), cell(12_000, 101, 102)],
  cells: [],
  charged: 0.1,
  status: "opening",
  ...over,
});

/** The screen's own sums, as both apps do them: the chain's word on the balance, plus what is held ahead of it. */
function screen(said: number) {
  const holds = new Holds();
  const acc: Payout = { raw: 0, credited: 0 };
  return { holds, acc, balance: () => Math.round((said + holds.total()) * 100) / 100, say: (next: number) => ((said = next), holds.heard()) };
}

describe("a refused piece is rolled back", () => {
  test("its stake comes back, its hits are taken back, and the balance is where it started", () => {
    const s = screen(10);
    const K = "77:0";
    // Drawn: the stake leaves the balance at once.
    s.holds.hold(holdIds.stake(K), -0.1);
    expect(s.balance()).toBe(9.9);
    // Opened here and hit before the relayer answered: paid at once, in whole cents.
    const due = pay(s.acc, 0.2537);
    expect(due).toBe(0.25);
    s.holds.hold(holdIds.win(K, 11_000), due);
    expect(s.balance()).toBe(10.15);
    // A second hit on the same piece, a second later.
    const due2 = pay(s.acc, 0.1);
    s.holds.hold(holdIds.win(K, 12_000), due2);
    expect(s.balance()).toBe(10.25);
    // Refused: the stake back, every hit of it taken back.
    const back = -s.holds.drop(holdIds.stake(K));
    const takenBack = s.holds.dropAll(holdIds.wins(K));
    unpay(s.acc, 0.3537, due + due2);
    expect(back).toBe(0.1);
    expect(takenBack).toBeCloseTo(0.35, 9);
    expect(s.balance()).toBe(10);
    expect(s.acc).toEqual({ raw: 0, credited: 0 });
    expect(s.holds.size).toBe(0);
  });

  test("only that piece: another piece of the same drawing keeps its stake and its hits", () => {
    const s = screen(5);
    const [A, B] = ["9:0", "9:1"];
    s.holds.hold(holdIds.stake(A), -0.1);
    s.holds.hold(holdIds.stake(B), -0.1);
    s.holds.hold(holdIds.win(A, 11_000), pay(s.acc, 0.3));
    s.holds.hold(holdIds.win(B, 12_000), pay(s.acc, 0.2));
    expect(s.balance()).toBe(5.3);
    s.holds.drop(holdIds.stake(B));
    const taken = s.holds.dropAll(holdIds.wins(B));
    unpay(s.acc, 0.2, taken);
    expect(s.balance()).toBe(5.2);
    expect(s.acc.credited).toBe(0.3);
    // The ids of piece 1 are not a prefix of piece 10's.
    s.holds.hold(holdIds.win("9:10", 13_000), 0.05);
    expect(s.holds.dropAll(holdIds.wins("9:1"))).toBe(0);
  });

  test("a piece the chain took is let go once the chain's next word includes it, so the figure does not move", () => {
    const s = screen(10);
    const K = "1:0";
    s.holds.hold(holdIds.stake(K), -0.1);
    s.holds.hold(holdIds.win(K, 11_000), pay(s.acc, 0.25));
    expect(s.balance()).toBe(10.15);
    // An account word from before the chain did anything: nothing let go.
    expect(s.say(10)).toBe(false);
    expect(s.balance()).toBe(10.15);
    // Placed, with 2¢ of it handed back: the balance shows the 2¢ at once.
    s.holds.land(holdIds.stake(K), -0.08);
    expect(s.balance()).toBe(10.17);
    // The chain's word now has the stake in it: still 10.17 on screen.
    s.say(9.92);
    expect(s.balance()).toBe(10.17);
    // Settled and paid, as the screen had it.
    s.holds.land(holdIds.win(K, 11_000));
    s.say(10.17);
    expect(s.balance()).toBe(10.17);
    expect(s.holds.size).toBe(0);
  });

  test("the chain paying differently wins: the balance becomes the chain's figure", () => {
    const s = screen(10);
    s.holds.hold(holdIds.win("2:0", 11_000), 0.5);
    s.holds.landAll(holdIds.wins("2:0"));
    s.say(10.4);
    expect(s.balance()).toBe(10.4);
  });

  test("what the chain never answers for is let go when it next speaks, long after", () => {
    const holds = new Holds(1000);
    holds.hold("stake:x", -0.1, 0);
    expect(holds.heard(500)).toBe(false);
    expect(holds.heard(1500)).toBe(true);
    expect(holds.total()).toBe(0);
  });
});

describe("pay", () => {
  test("whole cents of the running total; a hit never takes back, the chain's word may", () => {
    const acc: Payout = { raw: 0, credited: 0 };
    expect(pay(acc, 0.015)).toBe(0.01);
    expect(pay(acc, 0.015)).toBe(0.02);
    expect(pay(acc, -0.02)).toBe(0);
    expect(acc.credited).toBe(0.03);
    expect(pay(acc, 0, true)).toBe(-0.02);
    expect(acc.credited).toBe(0.01);
  });
});

describe("confirmPiece", () => {
  test("the chain's bands replace the local ones, keeping what the price did to them", () => {
    const local = piece({ status: "live", cells: [cell(11_000, 100, 101, { status: "hit", paid: paidOnChain(0.05, 2, FEE), range: [100.2, 100.4], chance: 0.4 }), cell(12_000, 101, 102, { chance: 0.3 })] });
    // The chain priced the hit band at 3× and kept the other at 2×, on its own grid.
    const { bet, paidDelta, bySecond } = confirmPiece(local, [
      { second: 1, lo: 100, hi: 101, stake: 0.05, rung: 300 },
      { second: 2, lo: 101.0000001, hi: 102, stake: 0.05, rung: 200 },
    ], 0.1, FEE);
    expect(bet.status).toBe("live");
    expect(bet.cells.map((c) => c.status)).toEqual(["hit", "live"]);
    expect(bet.cells[0].paid).toBeCloseTo(paidOnChain(0.05, 3, FEE), 12);
    expect(bet.cells[0].range).toEqual([100.2, 100.4]);
    expect(bet.cells[1].chance).toBe(0.3);
    expect(paidDelta).toBeCloseTo(paidOnChain(0.05, 3, FEE) - paidOnChain(0.05, 2, FEE), 12);
    expect([...bySecond.keys()]).toEqual([11_000]);
  });

  test("a hit on ink the chain did not take is taken back", () => {
    const paid = paidOnChain(0.05, 2, FEE);
    const local = piece({ status: "live", cells: [cell(11_000, 100, 101, { status: "hit", paid }), cell(12_000, 101, 102)] });
    const { bet, paidDelta } = confirmPiece(local, [{ second: 2, lo: 101, hi: 102, stake: 0.05, rung: 200 }], 0.05, FEE);
    expect(bet.cells).toHaveLength(1);
    expect(bet.charged).toBe(0.05);
    expect(paidDelta).toBeCloseTo(-paid, 12);
  });

  test("nothing placed: void, with every local hit taken back", () => {
    const paid = paidOnChain(0.05, 2, FEE);
    const local = piece({ status: "live", cells: [cell(11_000, 100, 101, { status: "hit", paid })] });
    const { bet, paidDelta } = confirmPiece(local, [], 0, FEE);
    expect(bet.status).toBe("void");
    expect(paidDelta).toBeCloseTo(-paid, 12);
  });

  test("placed before it opened here: the chain's bands, live", () => {
    const { bet, paidDelta } = confirmPiece(piece(), [{ second: 1, lo: 100, hi: 101, stake: 0.1, rung: 150 }], 0.1, FEE);
    expect(bet.status).toBe("live");
    expect(bet.cells[0]).toMatchObject({ t: 11_000, area: 1, multiple: 1.5, status: "live" });
    expect(paidDelta).toBe(0);
  });
});

describe("expireCells", () => {
  test("bands given back: out of play, their stake back, their hits taken back", () => {
    const paid = paidOnChain(0.05, 2, FEE);
    const local = piece({ status: "live", cells: [cell(11_000, 100, 101, { status: "hit", paid }), cell(12_000, 101, 102)] });
    const { bet, back, takeBack, gone } = expireCells(local, 0b11);
    expect(back).toBeCloseTo(0.1, 12);
    expect(takeBack).toBeCloseTo(paid, 12);
    expect(gone).toHaveLength(2);
    expect(bet.status).toBe("done");
    expect(bet.cells.every((c) => c.expired && c.paid === undefined)).toBe(true);
    // Twice is once.
    expect(expireCells(bet, 0b11).back).toBe(0);
  });
});

describe("refusals", () => {
  test("a burst is one notice, counted, with what came back added up", () => {
    let r = refusals(null, 0.05, "Too many small pieces; draw a longer line", 0);
    expect(refusalLine(r)).toBe("Too many small pieces");
    r = refusals(r, 0.05, "Too many small pieces; draw a longer line", 400);
    expect(r.count).toBe(2);
    expect(r.back).toBeCloseTo(0.1, 12);
    expect(refusalLine(r)).toBe("Too many small pieces · 2 pieces");
    r = refusals(r, 0.1, "NotOffered", 800);
    expect(refusalLine(r)).toBe("3 pieces didn't go through");
    const later = refusals(r, 0.05, "NotOffered", 800 + REFUSALS_MERGE_MS);
    expect(later.id).not.toBe(r.id);
    expect(refusalLine(later)).toBe("That piece didn't go through");
  });
});

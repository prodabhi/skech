import { expect, test } from "bun:test";
import { BarBook, mergeHistory } from "./bars";

test("backfill received after live trades restores older bars and retains newer live updates", () => {
  const book = new BarBook();
  book.fold(5000, 50);
  book.fold(6200, 62);
  const trades: [number, number, number][] = [[1, 1000, 10], [2, 3000, 30], [3, 5000, 50]];
  const id = mergeHistory(book, trades, 4, (t, p) => book.fold(t, p));
  expect(id).toBe(4);
  expect(book.at(1000)?.c).toBe(10);
  expect(book.at(6000)?.c).toBe(62);
  const ticks = book.ticks.slice();
  mergeHistory(book, trades, id, (t, p) => book.fold(t, p));
  expect(book.ticks).toEqual(ticks);
});

test("quiet bars do not prevent a completed snapshot from restoring history", () => {
  const book = new BarBook();
  book.fold(5000, 50);
  book.closeQuiet(12600);
  mergeHistory(book, [[1, 1000, 10], [2, 5000, 50]], 2, (t, p) => book.fold(t, p));
  expect(book.at(1000)?.c).toBe(10);
  expect(book.ticks.at(-1)?.p).toBe(50);
});

test("a newer live trade sharing the snapshot's millisecond retains its close", () => {
  const book = new BarBook();
  book.fold(5000, 50);
  book.fold(5000, 51);
  mergeHistory(book, [[1, 1000, 10], [2, 5000, 50]], 3, (t, p) => book.fold(t, p));
  expect(book.last?.c).toBe(51);
});

test("recovering from a long outage fills only the retained bar window", () => {
  const book = new BarBook(10);
  book.fold(1000, 10);
  book.closeQuiet(1_000_000_600);
  expect(book.bars).toHaveLength(10);
  expect(book.bars[0].t).toBe(999_991_000);
  expect(book.last?.t).toBe(1_000_000_000);
  book.fold(2_000_000_000, 20);
  expect(book.bars).toHaveLength(10);
  expect(book.bars[0].c).toBe(10);
  expect(book.last?.c).toBe(20);
});

test("trades fold into their second, gaps carry the last price, late trades land in their own second", () => {
  const book = new BarBook();
  book.fold(1000, 10);
  book.fold(1500, 12);
  book.fold(1900, 9);
  expect(book.bars).toEqual([{ t: 1000, h: 12, l: 9, c: 9 }]);
  book.fold(4200, 11);
  expect(book.bars.map((b) => b.t)).toEqual([1000, 2000, 3000, 4000]);
  expect(book.bars[1]).toEqual({ t: 2000, h: 9, l: 9, c: 9 });
  // A late trade for second 1 widens it but does not change its close.
  book.fold(1950, 14);
  expect(book.bars[0]).toEqual({ t: 1000, h: 14, l: 9, c: 9 });
  expect(book.at(3000)).toEqual({ t: 3000, h: 9, l: 9, c: 9 });
  expect(book.at(2500)).toBeUndefined();
});

test("quiet seconds close at the last price once they are old enough", () => {
  const book = new BarBook();
  book.fold(1000, 10);
  expect(book.closeQuiet(2599)).toBe(false);
  expect(book.closeQuiet(2600)).toBe(true);
  expect(book.bars).toEqual([{ t: 1000, h: 10, l: 10, c: 10 }, { t: 2000, h: 10, l: 10, c: 10 }]);
  expect(book.closed(1000, 2599)).toBe(false);
  expect(book.closed(1000, 2600)).toBe(true);
});

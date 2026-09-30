import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Features, field, fieldJob, rangeChanceOf, readLibrary } from "./dots";

/** The phone makes the map a slice at a time: it must be the very map `field` makes, bit for bit. */
test("fieldJob, run in slices, is exactly field", () => {
  const lib = readLibrary(new Uint8Array(readFileSync(join(import.meta.dir, "dots-lib.bin"))));
  for (const [sigma, momentum, cell, edge] of [
    [0.00008, -1.5, 0, 0],
    [0.00015, 0.3, 0.7, 1],
    [0.0004, 2, 1, 2],
  ]) {
    const f = { price: 83_000, sigma, momentum, wick: 0.4, vol: 1 } as unknown as Features;
    const step = 0.2 * (cell || 1);
    const whole = field(lib, f, 1_790_000_000_000, step, cell, edge);
    const job = fieldJob(lib, f, 1_790_000_000_000, step, cell, edge);
    let slices = 0;
    while (!job.run(613)) slices++;
    const sliced = job.result();
    expect(slices).toBeGreaterThan(10);
    expect(Array.from(sliced.chance)).toEqual(Array.from(whole.chance));
    expect(Array.from(sliced.lowCdf!)).toEqual(Array.from(whole.lowCdf!));
    expect(Array.from(sliced.highCdf!)).toEqual(Array.from(whole.highCdf!));
    expect(sliced.paths).toBe(whole.paths);
  }
});

/** The phone's map: no per-row chances, and only as far ahead as its screen. Every band price it gives is the full map's. */
test("fieldJob without per-row chances, cut short, prices every band as the full map does", () => {
  const lib = readLibrary(new Uint8Array(readFileSync(join(import.meta.dir, "dots-lib.bin"))));
  const openAt = 1_790_000_000_000;
  for (const [sigma, momentum, cell, edge] of [
    [0.00008, -1.5, 1, 1],
    [0.0004, 2, 1, 2],
  ]) {
    const f = { price: 83_000, sigma, momentum, wick: 0.4, vol: 1 } as unknown as Features;
    const step = 0.2;
    const whole = field(lib, f, openAt, step, cell, edge);
    const job = fieldJob(lib, f, openAt, step, cell, edge, { perRow: false, seconds: 20 });
    while (!job.run(613));
    const lean = job.result();
    expect(lean.chance.length).toBe(0);
    expect(lean.seconds).toBe(20);
    expect([lean.row0, lean.rows]).toEqual([whole.row0, whole.rows]);
    const width = whole.rows + 1;
    expect(Array.from(lean.lowCdf!)).toEqual(Array.from(whole.lowCdf!.subarray(0, 20 * width)));
    expect(Array.from(lean.highCdf!)).toEqual(Array.from(whole.highCdf!.subarray(0, 20 * width)));
    for (let s = 1; s <= 20; s++)
      for (const [lo, hi] of [[-3, 3], [5, 9], [-40, -20], [0, 0]])
        expect(rangeChanceOf(lean, openAt + s * 1000, 83_000 + lo * step, 83_000 + hi * step, edge, cell)).toBe(rangeChanceOf(whole, openAt + s * 1000, 83_000 + lo * step, 83_000 + hi * step, edge, cell));
    expect(rangeChanceOf(lean, openAt + 21_000, 83_000, 83_001, edge, cell)).toBe(0);
  }
});

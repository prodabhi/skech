/**
 * The pricer's worker, when it fails: what was asked of it is refused (not kept, so the next ask goes again), and
 * a new worker takes its place.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Features } from "@skech/core/dots";
import { Pricer } from "./pricer";

test("a worker that fails is replaced, and its failure is not cached", async () => {
  const lib = await Bun.file(join(import.meta.dir, "..", "..", "core", "src", "dots-lib.bin")).arrayBuffer();
  const logs: string[] = [];
  const pricer = new Pricer(lib, (s) => logs.push(s));
  expect(await pricer.ready).toBeGreaterThan(0);
  const first = pricer["worker"];
  // Features the worker cannot make a map of: it throws, and the error takes the worker down.
  const bad = null as unknown as Features;
  const asked = pricer.fieldFor(bad, 1_790_000_000_000, 0.2, 55);
  await expect(asked).rejects.toThrow("pricer: the worker");
  expect(pricer["cache"].size).toBe(0);
  // Asked again while the next is starting: refused at once, not left to hang.
  await expect(pricer.fieldFor(bad, 1_790_000_000_000, 0.2, 55)).rejects.toThrow("starting again");
  await Bun.sleep(600);
  expect(await pricer.ready).toBeGreaterThan(0);
  expect(pricer["worker"]).not.toBe(first);
  expect(logs.some((l) => l.includes("starting another"))).toBe(true);
  pricer["worker"]?.terminate();
}, 20_000);

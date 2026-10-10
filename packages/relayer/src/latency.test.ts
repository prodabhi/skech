import { expect, test } from "bun:test";
import { Latency, openingDelay } from "./latency";

test("validation consumes the opening wait, including when the deadline has passed", () => {
  expect(openingDelay(2000, 350, 1500)).toBe(850);
  expect(openingDelay(2000, 350, 1800)).toBe(550);
  expect(openingDelay(2000, 350, 2400)).toBe(0);
});

test("stage timings retain only the newest 256 samples", () => {
  const latency = new Latency();
  for (let i = 0; i < 300; i++) latency.record("rpc", i);
  latency.record("rpc", NaN);
  latency.record("rpc", -1);
  expect(latency.snapshot().rpc).toEqual({ count: 300, samples: 256, p50Ms: 171, p95Ms: 287, maxMs: 299 });
});

test("measurement preserves values and failures while recording both", async () => {
  const latency = new Latency();
  expect(await latency.measure("accept", async () => "ok")).toBe("ok");
  const error = new Error("offline");
  await expect(latency.measure("accept", async () => { throw error; })).rejects.toBe(error);
  expect(latency.snapshot().accept.count).toBe(2);
});

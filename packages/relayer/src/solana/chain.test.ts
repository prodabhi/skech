import { expect, test } from "bun:test";
import type { Signature } from "@solana/kit";
import { SolanaChain } from "./chain";

test("log lookup stops after five requests when transaction indexing lags", async () => {
  let calls = 0;
  const chain = Object.create(SolanaChain.prototype) as SolanaChain;
  Object.defineProperty(chain, "rpc", { value: {
    getTransaction: () => ({ send: async () => { calls++; return null; } }),
  } });
  expect(await chain.events("test" as Signature)).toEqual([]);
  expect(calls).toBe(5);
});

test("default log lookup still retries for callers that require chain events", async () => {
  let calls = 0;
  const chain = Object.create(SolanaChain.prototype) as SolanaChain;
  Object.defineProperty(chain, "rpc", { value: {
    getTransaction: () => ({ send: async () => ++calls === 1 ? null : { meta: { logMessages: [] } } }),
  } });
  expect(await chain.events("test" as Signature)).toEqual([]);
  expect(calls).toBe(2);
});

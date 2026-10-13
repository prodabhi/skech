/**
 * Sending, against a node that loses track of a transaction: the send times out, and the transaction lands all
 * the same. The relayer must wait on that very transaction, not send the call again under a new nonce (both
 * would land: a bet placed twice, or placed and never settled).
 */
import { afterAll, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex, keccak256, multicall3Abi } from "viem";
import { ChainClient } from "./chain";
import type { Config } from "./config";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcab2ff4f6c7cd9b0d" as Hex; // anvil's first key
const GAME = "0x0000000000000000000000000000000000000abc";
const calls: string[] = [];
const sent: Hex[] = [];
let receiptAfter = 2;

const receiptOf = (hash: Hex) => ({
  transactionHash: hash,
  transactionIndex: "0x0",
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x10",
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: GAME,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  type: "0x2",
});

const rpc = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      calls.push(m.method);
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
      switch (m.method) {
        case "eth_chainId":
          return ok("0x7a69");
        case "eth_getTransactionCount":
          return ok("0x5");
        case "eth_sendRawTransactionSync":
          sent.push(m.params[0] as Hex);
          return { jsonrpc: "2.0", id: m.id, error: { code: 4, message: "timeout: the transaction was not included in 8000 ms" } };
        case "eth_sendRawTransaction":
          return ok(keccak256(m.params[0] as Hex));
        case "eth_getTransactionReceipt":
          return ok(receiptAfter-- > 0 ? null : receiptOf(m.params[0] as Hex));
        default:
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
      }
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  },
});
afterAll(() => rpc.stop(true));

test("a send that times out is waited on by its hash, and never sent again under another nonce", async () => {
  const chain = new ChainClient({ key: KEY, chainId: 31337, rpcUrl: `http://127.0.0.1:${rpc.port}`, game: GAME } as unknown as Config, () => {});
  const receipt = await chain.send("collectFees", [], "collect", undefined, 50_000n);
  expect(sent).toHaveLength(1);
  expect(receipt.transactionHash).toBe(keccak256(sent[0]));
  // The same bytes again, while waiting, and nothing else signed.
  expect(calls.filter((c) => c === "eth_sendRawTransactionSync")).toHaveLength(1);
  expect(calls.filter((c) => c === "eth_getTransactionCount")).toHaveLength(1);
}, 10_000);

/** A node that answers Multicall3's aggregate3, each call with the next number. */
const multicalls: number[] = [];
const node = Bun.serve({
  port: 0,
  async fetch(req) {
    type Req = { id: number; method: string; params: { to: Hex; data: Hex }[] };
    const body = (await req.json()) as Req | Req[];
    const one = (m: Req) => {
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x279f" };
      if (m.method !== "eth_call" || m.params[0].to.toLowerCase() !== "0xca11bde05977b3631167028862be2a173976ca11") return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
      const calls = (decodeFunctionData({ abi: multicall3Abi, data: m.params[0].data }).args as unknown as [unknown[]])[0];
      multicalls.push(calls.length);
      const result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map((_, i) => ({ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [BigInt(5 + i)]) })) });
      return { jsonrpc: "2.0", id: m.id, result };
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  },
});
afterAll(() => node.stop(true));

test("reads made together are one eth_call through Multicall3", async () => {
  const chain = new ChainClient({ key: KEY, chainId: 10143, rpcUrl: `http://127.0.0.1:${node.port}`, game: GAME } as unknown as Config, () => {});
  const [pool, fees, balance] = await Promise.all([chain.pool(), chain.fees(), chain.balanceOf("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")]);
  expect([pool, fees, balance]).toEqual([5n, 6n, 7n]);
  expect(multicalls).toEqual([3]);
});


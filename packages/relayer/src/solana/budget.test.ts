import { describe, expect, test } from "bun:test";
import { address, createSolanaRpcFromTransport, type RpcTransport } from "@solana/kit";
import { Budget, budgeted, type Priority, priorityOf, rateLimit } from "./budget";

/** A clock that moves only when told. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
};
const URL_ = "https://example.solana-devnet.quiknode.pro/secret/";
const http429 = (retryAfter?: string) => Object.assign(new Error("HTTP error (429): Too Many Requests"), { context: { statusCode: 429, headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }) } });

/** An RPC that turns away the first `n` requests with a 429, then answers each with `answer(method, params)`. */
function node(n: number, answer: (method: string, params: unknown) => unknown, how: "http" | "json" = "http") {
  const calls: { method: string; params: unknown }[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const { method, params, id } = payload as { method: string; params: unknown; id: unknown };
    calls.push({ method, params });
    await Bun.sleep(5);
    if (calls.length <= n) {
      if (how === "http") throw http429("0");
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "Too many requests for a specific RPC call" } };
    }
    return { jsonrpc: "2.0", id, result: answer(method, params) };
  }) as RpcTransport;
  return { transport, calls };
}

describe("the RPC budget", () => {
  test("gives its burst at once, then a request per token", async () => {
    const b = new Budget(50, () => {}, Date.now, 2);
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 7 }, () => b.take("read")));
    // Two at once, five more at 20 ms each.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(90);
    expect(b.stats.requests).toBe(7);
  });

  test("lets the most urgent go first", async () => {
    const b = new Budget(100, () => {}, Date.now, 1);
    await b.take("read");
    const order: Priority[] = [];
    const wants: Priority[] = ["sweep", "read", "blockhash", "status", "send", "read", "send"];
    await Promise.all(wants.map((p) => b.take(p).then(() => order.push(p))));
    expect(order).toEqual(["send", "send", "status", "blockhash", "read", "read", "sweep"]);
  });

  test("knows a request by its method", () => {
    expect(priorityOf("sendTransaction")).toBe("send");
    expect(priorityOf("getSignatureStatuses")).toBe("status");
    expect(priorityOf("getLatestBlockhash")).toBe("blockhash");
    expect(priorityOf("getMultipleAccounts")).toBe("read");
  });

  test("a 429 waits for Retry-After, or doubles while they keep coming; jittered either way", () => {
    const c = clock();
    let r = 0.5;
    const b = new Budget(10, () => {}, c.now, 10, () => r);
    expect(b.throttled("getAccountInfo", 3_000, URL_)).toBe(3_000);
    expect([1, 2, 3, 4].map(() => b.throttled("getAccountInfo", null, URL_))).toEqual([500, 1_000, 2_000, 4_000]);
    b.ok();
    expect(b.throttled("getAccountInfo", null, URL_)).toBe(250);
    r = 0;
    expect(b.throttled("getAccountInfo", null, URL_)).toBe(375);
    r = 0.99;
    expect(b.throttled("getAccountInfo", null, URL_)).toBe(1_245);
    for (let i = 0; i < 20; i++) b.throttled("getAccountInfo", null, URL_);
    expect(b.throttled("getAccountInfo", null, URL_)).toBeLessThanOrEqual(12_500);
  });

  test("nothing goes while the RPC is turning requests away", async () => {
    const b = new Budget(1_000, () => {}, Date.now, 100, () => 0.5);
    b.throttled("getSlot", 60, URL_);
    const t0 = performance.now();
    await b.take("send");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
  });

  test("429s are logged once in 30 s, with how many, and never the endpoint's token", () => {
    const c = clock();
    const logged: string[] = [];
    const b = new Budget(15, (s) => logged.push(s), c.now, 15, () => 0.5);
    for (let i = 0; i < 40; i++) b.throttled("getSignatureStatuses", null, URL_);
    expect(logged.length).toBe(1);
    c.pass(30_000);
    b.throttled("getAccountInfo", null, URL_);
    expect(logged.length).toBe(2);
    expect(logged[1]).toContain("turned away 40 requests in 30 s");
    expect(logged.join()).not.toContain("secret");
    expect(b.stats.throttled).toBe(41);
  });

  test("a 429 is known by status, or by words; Solana's own error codes are not 429s", () => {
    expect(rateLimit(http429("2"), undefined)).toBe(2_000);
    expect(rateLimit(http429(), undefined)).toBe(null);
    expect(rateLimit(undefined, { error: { code: -32000, message: "Too many requests for a specific RPC call" } })).toBe(null);
    expect(rateLimit(undefined, { error: { code: -32005, message: "Node is behind by 42 slots" } })).toBe(undefined);
    expect(rateLimit(undefined, { error: { code: -32007, message: "Slot 1 was skipped" } })).toBe(undefined);
    expect(rateLimit(new Error("fetch failed"), undefined)).toBe(undefined);
    expect(rateLimit(undefined, { result: 1 })).toBe(undefined);
  });
});

describe("the budgeted transport", () => {
  test("a request turned away goes again after the wait, and is answered", async () => {
    const { transport, calls } = node(2, () => 42);
    const b = new Budget(100);
    const rpc = createSolanaRpcFromTransport(budgeted(transport, b, URL_));
    expect(await rpc.getSlot().send()).toBe(42n);
    expect(calls.length).toBe(3);
    expect(b.stats.throttled).toBe(2);
  });

  test("so is one turned away in the JSON-RPC answer", async () => {
    const { transport, calls } = node(1, () => 7, "json");
    const rpc = createSolanaRpcFromTransport(budgeted(transport, new Budget(100), URL_));
    expect(await rpc.getSlot().send()).toBe(7n);
    expect(calls.length).toBe(2);
  });

  test("a status look turned away is not asked again: the poller asks on its next look", async () => {
    const { transport, calls } = node(1, () => ({ context: { slot: 1 }, value: [null] }));
    const rpc = createSolanaRpcFromTransport(budgeted(transport, new Budget(100), URL_));
    await expect(rpc.getSignatureStatuses(["5".repeat(88) as never]).send()).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  test("gives up after a few tries", async () => {
    const { transport, calls } = node(99, () => 1);
    const rpc = createSolanaRpcFromTransport(budgeted(transport, new Budget(1_000), URL_));
    await expect(rpc.getSlot().send()).rejects.toThrow();
    expect(calls.length).toBe(4);
  });

  test("the same read twice at once is one request; a different one, or a send, is not", async () => {
    const { transport, calls } = node(0, () => ({ context: { slot: 1 }, value: 5 }));
    const b = new Budget(100);
    const rpc = createSolanaRpcFromTransport(budgeted(transport, b, URL_));
    const a = address("11111111111111111111111111111111");
    const c = address("SysvarC1ock11111111111111111111111111111111");
    const [x, y, z] = await Promise.all([rpc.getBalance(a).send(), rpc.getBalance(a).send(), rpc.getBalance(c).send()]);
    expect([x.value, y.value, z.value].map(Number)).toEqual([5, 5, 5]);
    expect(calls.length).toBe(2);
    expect(b.stats.deduped).toBe(1);
    // Once answered, it is asked again: nothing is cached past the request.
    await rpc.getBalance(a).send();
    expect(calls.length).toBe(3);
    await Promise.all([1, 2].map(() => rpc.sendTransaction("AQ==" as never, { encoding: "base64" }).send().catch(() => null)));
    expect(calls.filter((x) => x.method === "sendTransaction").length).toBe(2);
  });

  test("the sweep's reads wait behind players'", async () => {
    const { transport, calls } = node(0, () => ({ context: { slot: 1 }, value: 1 }));
    const b = new Budget(100, () => {}, Date.now, 1);
    const players = createSolanaRpcFromTransport(budgeted(transport, b, URL_));
    const sweep = createSolanaRpcFromTransport(budgeted(transport, b, URL_, "sweep"));
    await players.getSlot().send();
    const a = address("11111111111111111111111111111111");
    await Promise.all([sweep.getBalance(a).send(), players.getBalance(address("SysvarC1ock11111111111111111111111111111111")).send()]);
    expect(calls.slice(1).map((x) => (x.params as string[])[0])).toEqual(["SysvarC1ock11111111111111111111111111111111", "11111111111111111111111111111111"]);
  });
});

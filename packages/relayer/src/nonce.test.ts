import { describe, expect, test } from "bun:test";
import { Nonces } from "./nonce";

/** A node whose pending count is whatever the test says, counting how often it is asked. */
function node(count: number) {
  const n = { count, asked: 0 };
  const client = { getTransactionCount: async () => (n.asked++, n.count) };
  return { n, nonces: new Nonces(client as never, "0x0000000000000000000000000000000000000001") };
}

describe("nonces", () => {
  test("are asked for once, then counted here", async () => {
    const { n, nonces } = node(7);
    expect(await Promise.all([nonces.take(), nonces.take(), nonces.take()])).toEqual([7, 8, 9]);
    nonces.used(7);
    expect(await nonces.take()).toBe(10);
    expect(n.asked).toBe(1);
  });

  test("after one is lost, none is handed out until every one out is accounted for; then the node is asked", async () => {
    const { n, nonces } = node(5);
    const [a, b] = [await nonces.take(), await nonces.take()];
    nonces.lost(a);
    n.count = 5; // the node never saw 5, and has 6 waiting behind it
    let next = null as number | null;
    const waiting = nonces.take().then((x) => (next = x));
    await Bun.sleep(5);
    expect(next).toBeNull();
    expect(n.asked).toBe(1);
    nonces.used(b);
    await waiting;
    expect(next).toBe(5);
    expect(n.asked).toBe(2);
  });

  test("a failed ask is thrown, and asked again next time", async () => {
    let fail = true;
    const nonces = new Nonces({ getTransactionCount: async () => (fail ? Promise.reject(new Error("down")) : 3) } as never, "0x0000000000000000000000000000000000000001");
    await expect(nonces.take()).rejects.toThrow("down");
    fail = false;
    await Bun.sleep(1);
    expect(await nonces.take()).toBe(3);
  });
});


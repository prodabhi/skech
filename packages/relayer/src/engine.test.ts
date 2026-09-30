/**
 * With RELAYER_ENGINE_SIGNER set, an engine that signs as anyone else is not listened to: no signer taken from
 * it, and none of its trades folded into the bars the relayer settles on.
 */
import { afterAll, expect, test } from "bun:test";
import { Engine } from "./engine";

const EXPECTED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
let signer = "0x000000000000000000000000000000000000dEaD";
const engine = Bun.serve({
  port: 0,
  fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("ws", { status: 426 })),
  websocket: {
    open: (ws) => {
      ws.send(JSON.stringify({ type: "hello", signer, typedData: { domain: { chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" } } }));
      ws.send(JSON.stringify({ type: "history", trades: [[1, 1_790_000_000_000, 80_000]] }));
    },
    message: () => {},
  },
});
afterAll(() => engine.stop(true));

test("an engine signing as someone else is refused; the expected one is heard", async () => {
  const logs: string[] = [];
  const wrong = new Engine(`ws://127.0.0.1:${engine.port}`, (s) => logs.push(s), EXPECTED);
  wrong.start();
  await Bun.sleep(200);
  wrong.stop();
  expect(wrong.signer).toBeNull();
  expect(wrong.book.bars).toHaveLength(0);
  expect(logs.some((l) => l.includes("not listening to it"))).toBe(true);

  signer = EXPECTED;
  const right = new Engine(`ws://127.0.0.1:${engine.port}`, () => {}, EXPECTED.toLowerCase() as `0x${string}`);
  right.start();
  await Bun.sleep(200);
  right.stop();
  expect(right.signer).toBe(EXPECTED);
  expect(right.book.bars.length).toBeGreaterThan(0);
});

test("heartbeats keep a quiet market ready and a replay restores the signed quote", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const trades = Array.from({ length: 650 }, (_, i) => [i + 1, now - (661 - i) * 1000, 100, i === 649 ? 1 : 0]);
  const quote = { p: 100, message: { price: "10000000000", time: now - 12_000 }, signature: "0x1234" };
  let received!: () => void;
  const history = new Promise<void>((resolve) => { received = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "history", trades, quote }));
        ws.send(JSON.stringify({ type: "beat", t: now }));
      },
      message() {},
    },
  });
  const engine = new Engine(`ws://localhost:${server.port}`, (msg) => {
    if (msg.includes("bars of history")) received();
  });
  try {
    engine.start();
    await history;
    engine.book.closeQuiet(engine.now());
    expect(engine.book.ticks.at(-1)!.t).toBeLessThan(Date.now() - 5000);
    expect(engine.ready()).toBe(true);
    expect(engine.quote?.time).toBe(quote.message.time);
    expect(engine.quote?.priceE8).toBe(10_000_000_000n);
    engine.stop();
    expect(engine.ready()).toBe(false);
  } finally {
    engine.stop();
    server.stop(true);
  }
});

test("late backfill restores pre-check history while excluding subsequent unchecked trades", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  let received!: () => void;
  const history = new Promise<void>((resolve) => { received = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch: (req, server) => server.upgrade(req) ? undefined : new Response("ws", { status: 426 }),
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "price", id: 4, t: now - 2000, p: 104, message: { price: "10400000000", time: now - 2000 }, signature: "0x1234" }));
        ws.send(JSON.stringify({ type: "history", trades: [[1, now - 6000, 100, 0], [2, now - 4000, 102, 1], [3, now - 3000, 999, 0]] }));
      },
      message() {},
    },
  });
  const client = new Engine(`ws://localhost:${server.port}`, (msg) => {
    if (msg.includes("bars of history")) received();
  });
  try {
    client.start();
    await history;
    expect(client.checkedFrom).toBe(now - 4000);
    expect(client.book.at(now - 6000)?.c).toBe(100);
    expect(client.book.at(now - 3000)?.c).toBe(102);
    expect(client.book.last?.c).toBe(104);
  } finally {
    client.stop();
    server.stop(true);
  }
});

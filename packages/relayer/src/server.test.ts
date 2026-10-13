/**
 * The door, over a real WebSocket: what used to take the process down (the text `null`, a section that is null, a
 * handler that throws) is answered, and the connection and the relayer carry on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ChainClient } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import type { Sequencer } from "./sequencer";
import { Server } from "./server";

const logged: string[] = [];
const server = new Server({
  cfg: { port: 0, chainId: 31337, game: "0x0000000000000000000000000000000000000001", market: 0, marketName: "BTC-USD", lateMs: 200 } as unknown as Config,
  engine: { signer: null } as unknown as Engine,
  chain: { account: { address: "0x0000000000000000000000000000000000000002" } } as unknown as ChainClient,
  log: (s) => logged.push(s),
  status: () => ({}),
});
server.sequencer = {
  difficulty: 55,
  gameConfig: null,
  units: () => null,
  accept: async () => {
    throw new Error("boom");
  },
} as unknown as Sequencer;
server.start();
const port = (server["server"] as unknown as { port: number }).port;
afterAll(() => server["server"]?.stop(true));

/** A connection, and each message it hears in turn. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: Record<string, unknown>[] = [];
  const waiting: ((m: Record<string, unknown>) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.shift();
    if (w) w(m);
    else inbox.push(m);
  };
  await new Promise((r) => (ws.onopen = r));
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Record<string, unknown>>((r) => waiting.push(r)));
  expect((await next()).type).toBe("hello");
  return { ws, next };
}

const piece = {
  player: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  drawing: "1",
  index: 0,
  market: 0,
  difficulty: 55,
  openAt: "1000",
  perDot: "100000",
  unit: "20000000",
  priceSeen: "1",
  priceTime: "1",
  sections: [{ second: 1, lo: "0", hi: "20000000", stake: "1" }],
  strokeHash: `0x${"00".repeat(32)}`,
};

describe("the door", () => {
  test("answers null, a null section and a handler that throws, and stays up", async () => {
    const { ws, next } = await connect();
    ws.send("null");
    expect(await next()).toEqual({ type: "error", why: "Not a message" });
    ws.send(JSON.stringify({ type: "piece", piece: { ...piece, sections: [null] }, sessionSig: "0x", priceSig: `0x${"00".repeat(65)}`, stroke: "0x" }));
    expect(await next()).toEqual({ type: "ack", ok: false, why: "Bad piece.sections.0", index: 0, drawing: "1" });
    ws.send(JSON.stringify({ type: "piece", piece, sessionSig: "0x", priceSig: `0x${"00".repeat(65)}`, stroke: "0x" }));
    expect(await next()).toEqual({ type: "ack", ok: false, why: "Something went wrong; try again", index: 0, drawing: "1" });
    expect(logged.some((l) => l.includes("boom"))).toBe(true);
    ws.send(JSON.stringify({ type: "hello" }));
    expect((await next()).type).toBe("hello");
    ws.close();
  });

  test("answers a flood of pieces with slow down, past the connection's burst", async () => {
    const { ws, next } = await connect();
    const text = JSON.stringify({ type: "piece", piece, sessionSig: "0x", priceSig: `0x${"00".repeat(65)}`, stroke: "0x" });
    for (let i = 0; i < 45; i++) ws.send(text);
    const whys: Record<string, number> = {};
    for (let i = 0; i < 45; i++) {
      const m = await next();
      whys[m.why as string] = (whys[m.why as string] ?? 0) + 1;
    }
    expect(whys).toEqual({ "Something went wrong; try again": 40, "Too many requests; slow down": 5 });
    ws.close();
  });

  test("closes a connection that sends more than a message may hold", async () => {
    const { ws } = await connect();
    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
    ws.send(JSON.stringify({ type: "hello", pad: "x".repeat(70_000) }));
    // Closed before it is read: 1009 (too big), or 1006 if the socket goes before the close frame arrives.
    expect([1006, 1009]).toContain(await closed);
  });
});


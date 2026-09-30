import { describe, expect, test } from "bun:test";
import { beat, Bucket, clientIp, Door, RATES, Rates, remember, SMALL_PIECES, SmallPieces } from "./limits";

/** A clock that moves only when told. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
};

describe("a token bucket", () => {
  test("gives its burst at once, then only as it refills", () => {
    const c = clock();
    const b = new Bucket(3, 2, c.now);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    c.pass(499);
    expect(b.take()).toBe(false);
    c.pass(1);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
  test("never holds more than its burst, however long it waits", () => {
    const c = clock();
    const b = new Bucket(2, 1, c.now);
    c.pass(60_000);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
  });
});

describe("a connection's rates", () => {
  test("pieces are generous; what a wallet signs is not", () => {
    const c = clock();
    const r = new Rates(c.now);
    let pieces = 0;
    for (let i = 0; i < 50; i++) if (r.take("piece")) pieces++;
    expect(pieces).toBe(RATES.piece[0]);
    let builds = 0;
    for (let i = 0; i < 10; i++) if (r.take("build")) builds++;
    expect(builds).toBe(RATES.build[0]);
    c.pass(1000);
    expect(r.take("piece")).toBe(true);
    expect(r.take("build")).toBe(false);
  });
  test("every message counts toward the whole, unknown ones too", () => {
    const c = clock();
    const r = new Rates(c.now);
    let taken = 0;
    for (let i = 0; i < 100; i++) if (r.take("")) taken++;
    expect(taken).toBe(60);
    expect(r.take("hello")).toBe(false);
    // `toString` is not a type with a rate of its own.
    c.pass(1000);
    expect(r.take("toString")).toBe(true);
  });
});

describe("the door", () => {
  test("holds connections to a total and to a number from one address", () => {
    const d = new Door(3, 2);
    expect([d.enter("a"), d.enter("a"), d.enter("a")]).toEqual([true, true, false]);
    expect(d.enter("b")).toBe(true);
    expect(d.enter("c")).toBe(false);
    d.leave("a");
    expect(d.enter("c")).toBe(true);
    expect(d.size).toBe(3);
  });
  test("believes X-Forwarded-For only from this machine, and only its last address", () => {
    const req = (xff?: string) => new Request("http://x/ws", { headers: xff ? { "x-forwarded-for": xff } : {} });
    expect(clientIp(req("1.2.3.4"), "127.0.0.1")).toBe("1.2.3.4");
    expect(clientIp(req("6.6.6.6, 1.2.3.4"), "::1")).toBe("1.2.3.4");
    expect(clientIp(req("6.6.6.6"), "9.9.9.9")).toBe("9.9.9.9");
    expect(clientIp(req(), "127.0.0.1")).toBe("127.0.0.1");
  });
});

test("every socket hears a beat, those that joined since too", async () => {
  const heard: string[][] = [[], []];
  const clients = new Set([{ send: (s: string) => heard[0].push(s) }]);
  const timer = beat(clients, 10);
  await Bun.sleep(15);
  clients.add({ send: (s: string) => heard[1].push(s) });
  await Bun.sleep(25);
  clearInterval(timer);
  expect(heard[0].length).toBeGreaterThanOrEqual(3);
  expect(heard[1].length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(heard[0][0])).toEqual({ type: "beat" });
});

describe("small pieces", () => {
  test("ten at once for a wallet, then two a second, whichever connection sends them", () => {
    const c = clock();
    const s = new SmallPieces(c.now);
    let taken = 0;
    for (let i = 0; i < 15; i++) if (s.take("Alice111")) taken++;
    expect(taken).toBe(SMALL_PIECES[0]);
    expect(SMALL_PIECES).toEqual([10, 2]);
    // Another wallet has its own.
    expect(s.take("Bob11111")).toBe(true);
    // Addresses are base58: case matters.
    expect(s.take("alice111")).toBe(true);
    c.pass(499);
    expect(s.take("Alice111")).toBe(false);
    c.pass(1);
    expect(s.take("Alice111")).toBe(true);
    expect(s.take("Alice111")).toBe(false);
    c.pass(10_000);
    taken = 0;
    for (let i = 0; i < 15; i++) if (s.take("Alice111")) taken++;
    expect(taken).toBe(10);
  });
  test("remembers a bounded number of wallets", () => {
    const c = clock();
    const s = new SmallPieces(c.now, [1, 0]);
    expect(s.take("w0")).toBe(true);
    expect(s.take("w0")).toBe(false);
    for (let i = 1; i <= 50_000; i++) s.take(`w${i}`);
    // The oldest was let go: it starts afresh.
    expect(s.take("w0")).toBe(true);
  });
});

test("a remembered map keeps its newest", () => {
  const m = new Map<string, number>();
  for (const [i, k] of ["a", "b", "c", "a", "d"].entries()) remember(m, k, i, 3);
  expect([...m.keys()]).toEqual(["c", "a", "d"]);
});

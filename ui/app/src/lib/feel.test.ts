import { afterAll, describe, expect, mock, test } from "bun:test";

/*
  feel.ts on a stand-in Web Audio context and vibration motor that record when each sound is started and each
  pattern asked for. Real time: what is measured is the code between the judge finding a hit and the audio start call.
*/
const audioStarts: number[] = [];
const buzzes: { at: number; pattern: number | number[] }[] = [];
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
const node = (extra: object = {}) => ({ connect: (n: unknown) => n, disconnect() {}, ...extra });
class FakeContext {
  state = "running";
  currentTime = 0;
  sampleRate = 32_000;
  destination = node();
  createGain = () => node({ gain: param() });
  createDynamicsCompressor = () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  createBiquadFilter = () => node({ type: "", frequency: param(), Q: param() });
  createOscillator = () => node({ type: "", frequency: param(), start: () => audioStarts.push(performance.now()), stop() {} });
  createBufferSource = () => node({ buffer: null, loop: false, playbackRate: param(), start: () => audioStarts.push(performance.now()), stop() {} });
  createBuffer = (_ch: number, length: number) => ({ length, getChannelData: () => new Float32Array(length), copyToChannel() {} });
  resume = async () => {};
}
// This file runs on the real clock: a test file before it may have left performance.now() stopped.
(performance.now as { mockRestore?: () => void }).mockRestore?.();
const g = globalThis as unknown as Record<string, unknown>;
const real = { window: g.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
g.window = { AudioContext: FakeContext };
Object.defineProperty(globalThis, "navigator", { value: { vibrate: (pattern: number | number[]) => void buzzes.push({ at: performance.now(), pattern }), userAgent: "test" }, configurable: true });
let settings = { sound: true, haptics: true };
mock.module(new URL("./practice.ts", import.meta.url).pathname, () => ({ practice: () => settings }));
const logs: string[] = [];
const info = console.info;
console.info = (...a: unknown[]) => void logs.push(a.join(" "));

afterAll(() => {
  g.window = real.window;
  if (real.navigator) Object.defineProperty(globalThis, "navigator", real.navigator);
  console.info = info;
});

const { celebrate, feel, haptic } = await import("./feel");
const microtask = () => new Promise<void>((r) => queueMicrotask(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a hit is heard and felt the instant it is found", () => {
  test("sound and vibration start before the next frame", async () => {
    const seen = performance.now();
    feel("hit", { multiple: 2.4, run: 0, seen });
    await microtask();
    expect(buzzes).toHaveLength(1);
    expect(audioStarts.length).toBeGreaterThan(0);
    expect(audioStarts[0] - seen).toBeLessThan(5);
    info(`[feel.test] web hit: judge → first audio start ${(audioStarts[0] - seen).toFixed(2)} ms, judge → vibrate ${(buzzes[0].at - seen).toFixed(2)} ms`);
    info(`[feel.test] timing log: ${logs.find((l) => l.startsWith("[skech:feel] hit"))}`);
  });

  test("a round that ends on a hit rings its chord as the hit ends, and never cuts it short", async () => {
    await sleep(500);
    audioStarts.length = 0;
    buzzes.length = 0;
    const seen = performance.now();
    feel("hit", { multiple: 2, seen });
    celebrate(1, 1);
    await microtask();
    const hitStarts = audioStarts.length;
    expect(audioStarts[0] - seen).toBeLessThan(5);
    await sleep(150);
    expect(audioStarts.length).toBe(hitStarts);
    while (audioStarts.length === hitStarts && performance.now() - seen < 1000) await sleep(2);
    expect(audioStarts[hitStarts] - seen).toBeGreaterThanOrEqual(235);
    expect(audioStarts[hitStarts] - seen).toBeLessThan(330);
    // Then a hit on another line during the chord: heard at once, and the chord's roll is not cut off.
    const before = buzzes.length;
    const t = performance.now();
    feel("hit", { multiple: 2, seen: t });
    await microtask();
    expect(audioStarts.at(-1)! - t).toBeLessThan(5);
    expect(buzzes.length).toBe(before);
  });
});

test("a streak escalates to the shared top rhythm without tap feedback interrupting it", async () => {
  await sleep(1600);
  buzzes.length = 0;
  celebrate(3, 3);
  expect(buzzes.map(({ pattern }) => pattern)).toEqual([[26, 40, 22, 40, 30, 40, 40, 110, 80]]);
  haptic("tap");
  expect(buzzes).toHaveLength(1);
});

test("disabled feedback does not vibrate or start audio", async () => {
  await sleep(1500);
  settings = { sound: false, haptics: false };
  buzzes.length = 0;
  audioStarts.length = 0;
  feel("hit", { multiple: 2 });
  await microtask();
  expect(buzzes).toHaveLength(0);
  expect(audioStarts).toHaveLength(0);
});

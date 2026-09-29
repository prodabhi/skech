/**
 * Every band's chance, measured on the paths, for a second: one map per grid
 * unit per second, made in a worker, read off for every piece that opens then.
 * A worker that dies, or does not answer in time, is replaced; what was asked
 * of it is refused, and asked again of the next.
 */
import { type Features, type Field, rangeChanceOf } from "@skech/core/dots";
import { INK_CELL, INK_EDGE_CELLS } from "@skech/core/ink";
import { chanceE9, fromE8, gridStep, type Section } from "@skech/core/chain";

/** A map takes a few hundred ms; one that takes this long will not be in time for its second. */
const ANSWER_MS = 3_000;

type Asked = { resolve: (f: Field) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Pricer {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, Asked>();
  private cache = new Map<string, Promise<Field>>();
  ready: Promise<number>;

  constructor(
    private readonly libBytes: ArrayBuffer,
    private readonly log: (s: string) => void,
  ) {
    this.ready = this.spawn();
  }

  /** A worker with the paths loaded: resolves with how many. */
  private spawn(): Promise<number> {
    const worker = new Worker(new URL("./field.worker.ts", import.meta.url));
    this.worker = worker;
    const ready = new Promise<number>((resolve) => {
      worker.onmessage = (e: MessageEvent<{ kind?: string; paths?: number; id?: number; field?: Field; ms?: number }>) => {
        if (e.data.kind === "ready") return resolve(e.data.paths!);
        const w = this.waiting.get(e.data.id!);
        if (!w) return;
        this.waiting.delete(e.data.id!);
        clearTimeout(w.timer);
        if (e.data.ms! > 400) this.log(`pricer: a map took ${Math.round(e.data.ms!)} ms`);
        w.resolve(e.data.field!);
      };
    });
    worker.onerror = (e) => this.replace(worker, `failed: ${e.message}`);
    worker.addEventListener("close", () => this.replace(worker, "stopped"));
    worker.postMessage({ kind: "lib", bytes: this.libBytes });
    return ready;
  }

  /** `worker` is gone or stuck: what it was asked is refused, and a new one takes its place a moment later. */
  private replace(worker: Worker, why: string) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.log(`pricer: the worker ${why}; starting another`);
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(`pricer: the worker ${why}`));
    }
    this.waiting.clear();
    this.cache.clear();
    worker.terminate();
    setTimeout(() => {
      this.ready = this.spawn();
    }, 500);
  }

  /** The map for a second, on a grid, at a difficulty. Cached: many pieces open on one second. */
  fieldFor(f: Features, openAt: number, unit: number, difficulty: number): Promise<Field> {
    const key = `${openAt}:${unit}:${difficulty}`;
    let p = this.cache.get(key);
    if (!p) {
      const worker = this.worker;
      if (!worker) return Promise.reject(new Error("pricer: the worker is starting again"));
      const id = this.nextId++;
      p = new Promise<Field>((resolve, reject) => {
        const timer = setTimeout(() => this.replace(worker, `did not answer in ${ANSWER_MS} ms`), ANSWER_MS);
        this.waiting.set(id, { resolve, reject, timer });
        // The map's rows are one grid unit tall: step * INK_CELL == unit.
        worker.postMessage({ kind: "field", id, f, at: openAt, step: gridStep(unit * 50) * INK_CELL, cell: INK_CELL, difficulty });
      });
      // A map that failed is not kept: the next piece on that second asks again.
      const kept = p;
      kept.catch(() => {
        if (this.cache.get(key) === kept) this.cache.delete(key);
      });
      this.cache.set(key, p);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Each band's chance on the map, in billionths: the band as the app drew it, judged one unit wider each way. */
  chances(fl: Field, sections: Section[], openAt: number): number[] {
    return sections.map((s) => chanceE9(rangeChanceOf(fl, openAt + s.second * 1000, fromE8(s.lo), fromE8(s.hi), INK_EDGE_CELLS, INK_CELL)));
  }
}

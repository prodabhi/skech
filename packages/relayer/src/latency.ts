/** Bounded, in-process stage timings. No player identifiers or transaction data. */
export class Latency {
  private samples = new Map<string, { count: number; values: number[]; next: number }>();

  record(stage: string, ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let sample = this.samples.get(stage);
    if (!sample) this.samples.set(stage, sample = { count: 0, values: [], next: 0 });
    sample.count++;
    sample.values[sample.next] = ms;
    sample.next = (sample.next + 1) % 256;
  }

  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await work(); }
    finally { this.record(stage, performance.now() - start); }
  }

  snapshot() {
    return Object.fromEntries([...this.samples].map(([stage, sample]) => {
      const sorted = [...sample.values].sort((a, b) => a - b);
      const percentile = (p: number) => Math.round(sorted[Math.ceil(sorted.length * p) - 1]);
      return [stage, { count: sample.count, samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: Math.round(sorted.at(-1)!) }];
    }));
  }
}

/** Re-read the clock after async validation so it does not extend the opening wait. */
export const openingDelay = (openAt: number, openAfterMs: number, now: number) => Math.max(0, openAt + openAfterMs - now);

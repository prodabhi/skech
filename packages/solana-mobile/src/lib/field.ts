import { type Features, type Field, fieldJob, type Library, setDifficulty } from "@skech/core/dots";
import { INK_EDGE_CELLS } from "@skech/core/ink";

/**
 * The map of multiples, made a few milliseconds at a time. On the web it is made in a worker; a phone has no
 * workers, and made in one go it would take the JavaScript thread from the pen for a third of a second, every
 * second. So `fieldJob` lays the paths over the map in slices, a slice a frame, each under `SLICE_MS`, and the
 * map is ready well inside its second while the pen and the chart keep every frame.
 */

const SLICE_MS = 5;
/** How far ahead the phone's map reaches: the screen shows 15s, and a piece opens a second or two after it is drawn. */
export const PHONE_SECONDS = 20;
/** A map that has taken this long gets longer slices: on a slow phone at a few milliseconds a frame it would never
 *  finish before the next second's map, and no tiles would ever show. */
const BEHIND_MS = 600;
const BEHIND_SLICE_MS = 12;
/**
 * Paths a run starts with; tuned from how long the last run took, so each takes about half of `SLICE_MS`. It starts
 * small and is capped, so the first run of a map, or one after the phone was busy, cannot overrun the frame's budget
 * by much: the budget is only checked between runs.
 */
let perSlice = 32;
const MAX_PER_RUN = 256;

export type FieldAsk = { id: number; f: Features; at: number; step: number; cell: number; difficulty: number; least: number };

export class FieldMaker {
  private job: { ask: FieldAsk; run: (n: number) => boolean; result: () => Field; began: number } | null = null;
  /** The newest map asked for while one was being made: made next. Older ones in between are skipped. */
  private next: FieldAsk | null = null;
  private frame = 0;

  constructor(
    private readonly lib: Library,
    private readonly done: (id: number, field: Field) => void,
  ) {}

  /**
   * A map to make. One already under way is finished first, then the newest asked for: dropping it for each new
   * ask, as this did, meant that on a phone slower than a map a second no map was ever finished.
   */
  ask(ask: FieldAsk) {
    if (this.job) {
      this.next = ask;
      return;
    }
    this.start(ask);
  }

  private start(ask: FieldAsk) {
    setDifficulty(ask.difficulty, ask.least);
    // Only what the phone prices with: bands (no per-row chances), as far ahead as the screen reaches.
    const j = fieldJob(this.lib, ask.f, ask.at, ask.step, ask.cell, INK_EDGE_CELLS, { perRow: false, seconds: PHONE_SECONDS });
    this.job = { ask, run: j.run, result: j.result, began: performance.now() };
    if (!this.frame) this.frame = requestAnimationFrame(this.slice);
  }

  get busy() {
    return this.job !== null;
  }

  /** The last map finished, and what it was asked as. */
  private made: { ask: FieldAsk; field: Field } | null = null;

  /**
   * The map asked as `match` says, now: the one finished last, or the one being made (or waiting to be), finished
   * at once on this thread. Null when none was asked for. For a drawing that must open and whose second's map has
   * not come in time: what is left of that map costs far less than a whole map of the paths made for it alone,
   * which is what opening it the long way does, once per piece.
   */
  finishNow(match: (ask: FieldAsk) => boolean): Field | null {
    if (this.made && match(this.made.ask)) return this.made.field;
    if (!this.job && this.next && match(this.next)) {
      const next = this.next;
      this.next = null;
      this.start(next);
    }
    const job = this.job;
    if (!job || !match(job.ask)) return null;
    job.run(Infinity);
    this.finish(job);
    return this.made?.ask === job.ask ? this.made.field : null;
  }

  private finish(job: NonNullable<FieldMaker["job"]>) {
    this.job = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    // The difficulty the paths were laid for, as the web's worker keeps its own.
    setDifficulty(job.ask.difficulty, job.ask.least);
    const field = job.result();
    this.made = { ask: job.ask, field };
    this.done(job.ask.id, field);
    const next = this.next;
    this.next = null;
    if (next) this.start(next);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.job = null;
    this.next = null;
  }

  private slice = () => {
    this.frame = 0;
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    const budget = t0 - job.began > BEHIND_MS ? BEHIND_SLICE_MS : SLICE_MS;
    let finished = false;
    while (!finished && performance.now() - t0 < budget) {
      const s = performance.now();
      finished = job.run(perSlice);
      const took = performance.now() - s;
      if (took > 0) perSlice = Math.max(1, Math.min(MAX_PER_RUN, Math.round((perSlice * (SLICE_MS / 2)) / took)));
    }
    if (finished) this.finish(job);
    else this.frame = requestAnimationFrame(this.slice);
  };
}

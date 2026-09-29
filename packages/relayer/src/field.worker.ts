/// <reference lib="webworker" />
/**
 * The map of the odds for one second, off the main thread: the same worker
 * the app runs (`ui/app/src/components/app/ink/field.worker.ts`), so the
 * chances the relayer signs are the chances the app quoted.
 */
import { INK_EDGE_CELLS } from "@skech/core/ink";
import { type Features, field, type Library, readLibrary, setDifficulty } from "@skech/core/dots";

declare const self: Worker;
let lib: Library | null = null;

type Ask = { kind: "lib"; bytes: ArrayBuffer } | { kind: "field"; id: number; f: Features; at: number; step: number; cell: number; difficulty: number };

self.onmessage = (e: MessageEvent<Ask>) => {
  const m = e.data;
  if (m.kind === "lib") {
    lib = readLibrary(new Uint8Array(m.bytes));
    self.postMessage({ kind: "ready", paths: lib.n });
    return;
  }
  if (!lib) return;
  setDifficulty(m.difficulty);
  const t0 = performance.now();
  const fl = field(lib, m.f, m.at, m.step, m.cell, INK_EDGE_CELLS);
  self.postMessage({ id: m.id, field: fl, ms: performance.now() - t0 }, [fl.chance.buffer, fl.lowCdf!.buffer, fl.highCdf!.buffer]);
};

/**
 * The relayer's state files. Written so that a crash, a kill or a full disk leaves the old file or the new one,
 * never half of either: a temporary file beside it, flushed to disk, then renamed over it. Read so that a file
 * that is there but cannot be read stops the relayer, rather than being overwritten with nothing on the next
 * save: the bets still to settle and who is owed would go with it.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      const bytes = Buffer.from(text);
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // The rename itself, to disk, where the directory lets it be flushed.
  try {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    /* not every filesystem flushes a directory */
  }
}

/** What was saved at `path`, or null when nothing was. A file that is there and is not JSON is thrown on. */
export function readState<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path} is there but cannot be read (${String((e as Error).message ?? e)}): restore it, or move it aside to start without it`);
  }
}

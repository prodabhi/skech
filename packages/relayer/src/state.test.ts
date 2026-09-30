import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import type { Engine } from "./engine";
import type { SolanaChain } from "./solana/chain";
import type { SolanaConfig } from "./solana/config";
import { SolanaSettler } from "./solana/settler";
import { readState, writeAtomic } from "./state";

const settlerAt = (path: string) => new SolanaSettler({} as SolanaConfig, {} as Engine, {} as SolanaChain, { settled: () => {}, owed: () => {}, account: () => {} }, () => {}, path);
const HOLDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;

const dir = mkdtempSync(join(tmpdir(), "relayer-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a state file", () => {
  test("round-trips, and leaves nothing beside it", () => {
    const path = join(dir, "state.json");
    const state = { holders: ["9WzDXwBb"], posted: { "1790000000000": "8000000000000" }, note: "é ".repeat(10_000) };
    writeAtomic(path, JSON.stringify(state));
    expect(readState<unknown>(path)).toEqual(state);
    writeAtomic(path, JSON.stringify({ holders: [] }));
    expect(readState<unknown>(path)).toEqual({ holders: [] });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("that is not there is nothing; one that is there and unreadable is thrown on", () => {
    expect(readState(join(dir, "none.json"))).toBeNull();
    const half = join(dir, "half.json");
    writeFileSync(half, '{"bets":[{"bet":"');
    expect(() => readState(half)).toThrow("cannot be read");
    writeFileSync(half, "");
    expect(() => readState(half)).toThrow("cannot be read");
  });

  test("a write that cannot be made throws, and the file already there is kept whole", () => {
    const path = join(dir, "kept.json");
    writeAtomic(path, '{"a":1}');
    // A directory where the temporary file would go: it cannot be opened for writing.
    mkdirSync(`${path}.${process.pid}.tmp`);
    expect(() => writeAtomic(path, '{"a":2}')).toThrow();
    expect(readState<unknown>(path)).toEqual({ a: 1 });
    rmSync(`${path}.${process.pid}.tmp`, { recursive: true });
  });

  test("the settler will not start on one it cannot read, rather than save over it", () => {
    const path = join(dir, "settler.json");
    writeFileSync(path, "{not json");
    const make = () => settlerAt(path);
    expect(make).toThrow("cannot be read");
    writeFileSync(path, JSON.stringify({ bets: [], holders: 7, posted: {} }));
    expect(make).toThrow("not state this relayer can restore");
  });

  test("is written again only when what it holds changed", () => {
    const path = join(dir, "idle.json");
    const settler = settlerAt(path);
    settler.save();
    expect(existsSync(path)).toBe(true);
    rmSync(path);
    settler.save();
    expect(existsSync(path)).toBe(false);
    settler.owed(HOLDER);
    settler.save();
    expect(readState<{ holders: string[] }>(path)?.holders).toEqual([HOLDER]);
  });
});

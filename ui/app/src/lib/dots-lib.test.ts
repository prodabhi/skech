import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLibrary, RULES } from "@skech/core/dots";

/*
  The paths every dot is priced on ship twice: once beside the engine, where
  its tests and the server read them, and once in public/, where the page
  fetches them. Two copies can drift, and a page pricing from last week's
  paths while the engine is tested on this week's would be wrong without
  anything failing.
*/
test("the paths the page downloads are the paths the engine is tested on", () => {
  const served = readFileSync(join(import.meta.dir, "../../public/dots-lib.bin"));
  const core = readFileSync(join(import.meta.dir, "../../../../packages/core/src/dots-lib.bin"));
  expect(served.equals(core)).toBe(true);
  const lib = readLibrary(new Uint8Array(served));
  expect(lib.seconds).toBe(RULES.horizon + 1);
});

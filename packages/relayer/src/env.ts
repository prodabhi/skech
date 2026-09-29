/**
 * The monorepo's one `.env.local` (then `.env`) into process.env; a value
 * already in the environment wins. Imported first by config.ts and sentry.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dir, "..", "..", "..");
for (const name of [".env.local", ".env"]) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

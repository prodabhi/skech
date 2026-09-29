/**
 * Sentry for the relayer: a crash, and the few failures that cost a player something (a piece not placed,
 * a second not settled, the sweep, the state file, running low on SOL), each with the log lines before it.
 *
 * Off unless RELAYER_SENTRY_DSN is set, and off outside systemd (it sets INVOCATION_ID) unless
 * RELAYER_SENTRY_DEV=1, so a laptop never spends the plan. Imported first by index.ts, so a throw at
 * start is caught too.
 */
import * as Sentry from "@sentry/bun";
import "./env";
import { redact } from "./rpc";

const dsn = process.env.RELAYER_SENTRY_DSN?.trim() ?? "";
const onBox = process.env.INVOCATION_ID !== undefined;

if (dsn && (onBox || process.env.RELAYER_SENTRY_DEV === "1")) {
  Sentry.init({
    dsn,
    environment: onBox ? (process.env.SKECH_SOLANA_CLUSTER?.trim() || "devnet") : "development",
    // No user, no cookies, no bodies: an RPC call's body is a signed transaction.
    dataCollection: { userInfo: false, cookies: false, httpBodies: [] },
    maxBreadcrumbs: 200,
    // The RPC is called many times a second: its fetches would push every log line out of the trail.
    beforeBreadcrumb: (b) => (b.category === "fetch" || b.category === "http" ? null : b),
    beforeSend: (event) => {
      if (event.message) event.message = scrub(event.message);
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
      for (const b of event.breadcrumbs ?? []) if (b.message) b.message = scrub(b.message);
      return event;
    },
  });
}

/** Every URL cut to its host: a private RPC's URL carries its token, and viem puts the URL in its errors. */
const scrub = (text: string) => text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, redact);

/** A log line, kept as a breadcrumb so the next event shows what led to it. */
export function trail(line: string) {
  Sentry.addBreadcrumb({ message: line, level: /WARNING/.test(line) ? "warning" : "info" });
}

/**
 * A promise that failed with nothing to hear it: logged and reported, not a reason to stop. Bun exits on one
 * otherwise, and a relayer that is down settles nothing. One line a minute at most, with how many there were.
 */
export function survive(log: (s: string) => void) {
  let last = 0;
  let quiet = 0;
  process.on("unhandledRejection", (e) => {
    report("unhandled", e);
    if (Date.now() - last < 60_000) {
      quiet++;
      return;
    }
    log(`unhandled: ${String((e as Error)?.message ?? e).split("\n")[0]}${quiet ? ` (${quiet} more since the last)` : ""}`);
    last = Date.now();
    quiet = 0;
  });
}

const EVERY_MS = 60 * 60_000;
const last = new Map<string, number>();

/**
 * One event per `kind` an hour at most: a chain that is down fails every second, and one issue with its
 * breadcrumbs says as much as three thousand.
 */
export function report(kind: string, e: unknown, level: "error" | "warning" = "error") {
  const now = Date.now();
  if (now - (last.get(kind) ?? 0) < EVERY_MS) return;
  last.set(kind, now);
  Sentry.withScope((scope) => {
    scope.setTag("kind", kind);
    scope.setLevel(level);
    if (e instanceof Error) Sentry.captureException(e);
    else {
      // A message carries amounts and addresses: group by what went wrong, not by the numbers.
      scope.setFingerprint([kind]);
      Sentry.captureMessage(String(e));
    }
  });
}

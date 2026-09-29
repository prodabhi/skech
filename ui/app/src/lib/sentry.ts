/**
 * What the browser, server and edge Sentry inits share (instrumentation-client.ts, sentry.*.config.ts).
 *
 * Sentry has the errors: what broke, the stack against our own source (source maps are uploaded at build),
 * the trail of game events before it, and a replay of the last minute on screen. PostHog has the rest
 * (src/lib/analytics.ts).
 *
 * Off unless NEXT_PUBLIC_SENTRY_DSN is set, and off in development unless NEXT_PUBLIC_SENTRY_DEV=1, so a
 * laptop never spends the plan (5k errors, 50 replays a month). Events go through /monitoring on our own
 * domain (next.config.ts), past ad blockers.
 */

import type { BrowserOptions } from "@sentry/nextjs";

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

export const SENTRY_ON = SENTRY_DSN !== "" && (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SENTRY_DEV === "1");

/** production, preview or development: Vercel's name for the deploy, so a preview's errors are not production's. */
export const SENTRY_ENVIRONMENT = process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV;

/** A fifth of server requests traced in production; every one while working on it. The browser does not trace. */
export const SENTRY_TRACES = process.env.NODE_ENV === "production" ? 0.2 : 1;

/** Marks our own bundle at build (next.config.ts), so an error thrown only by an extension or injected script is dropped. */
export const SENTRY_APP_KEY = "skech-app";

/**
 * Identity is the wallet address (src/lib/analytics.ts), never an IP, email or phone number. No cookies (a
 * signed-in session lives in them) and no request or response bodies (signatures, amounts); headers and query
 * strings stay, with the SDK's filter on anything that looks like a key or token.
 */
export const SENTRY_DATA: BrowserOptions["dataCollection"] = { userInfo: false, cookies: false, httpBodies: [] };

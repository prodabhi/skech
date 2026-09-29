import * as Sentry from "@sentry/nextjs";
import type { PostHog, Properties } from "posthog-js";

/**
 * What the app tells PostHog, and nothing else.
 *
 * On the free plan (1M events, 5k replays and 100k exceptions a month), so
 * every event here is one somebody will read: the way in (ready, sign in,
 * deposit, the drawing key, the first drawing), each round's result, the
 * money out, what fails, and one summary a visit for how long it was played.
 * Errors are Sentry's (src/lib/sentry.ts), not PostHog's: each event here is
 * also left there as a breadcrumb, so an error shows the play that led to it.
 * Autocapture, heatmaps and dead clicks are off: on a canvas game they are
 * mostly noise, and they would spend the plan on it.
 *
 * Off unless NEXT_PUBLIC_POSTHOG_KEY is set, and off in development unless
 * NEXT_PUBLIC_POSTHOG_DEV=1, so a laptop never counts against the plan.
 * Events go through /ingest on our own domain (next.config.ts), past ad
 * blockers. Identity is the wallet address, never an email or phone number.
 *
 * PostHog itself (about 110 KB gzipped) is loaded once the page has painted
 * and the browser is idle, not before the game can be seen; what is tracked
 * before then waits for it.
 */

export type Event =
  // The way in.
  | "app_ready"
  | "connect_slow"
  | "sign_in_opened"
  | "signed_in"
  | "signed_out"
  | "deposit_opened"
  | "deposit_completed"
  | "deposit_failed"
  | "founders_opened"
  | "founders_messaged"
  | "drawing_key_ready"
  | "drawing_key_failed"
  | "first_drawing"
  // Thirty seconds on paper money, signed out: started, again, and what it came to.
  | "paper_started"
  | "paper_again"
  | "paper_ended"
  // Playing.
  | "round_finished"
  | "piece_refused"
  | "piece_resent"
  | "update_shown"
  | "balance_ran_out"
  | "judge_disagreed"
  | "price_changed"
  | "pen_changed"
  // Money out.
  | "withdraw_completed"
  | "withdraw_failed"
  // What SKT earned, claimed.
  | "claim_completed"
  | "claim_failed"
  // Home Screen.
  | "home_screen_shown"
  | "home_screen_install_tapped"
  | "home_screen_dismissed"
  | "home_screen_installed"
  // Once a visit: how long it was on screen.
  | "visit_ended";

/*
  Who someone is (their email, or the phone number they signed in with) is never in a replay, Sentry's or
  PostHog's. Typing is masked in both already; these mark what is shown. PRIVATE_TEXT goes on an element whose
  text names them: Sentry masks the text, PostHog leaves the element out. PRIVATE_LINK goes on a link whose
  address does, since masking covers text and not an href: both leave it out. Privy's sign-in panel says
  where a code went, and has no mark of ours, so it is masked by its own id.
*/
export const PRIVATE_TEXT = "sentry-mask ph-no-capture";
export const PRIVATE_LINK = "sentry-block ph-no-capture";
export const SIGN_IN_PANEL = "#privy-modal-content";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const REGION = process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us";
const ON = KEY !== "" && (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_POSTHOG_DEV === "1");

/** A heavy player can finish hundreds of rounds in a visit: past this many only `visit_ended` counts the rest. */
const ROUNDS_PER_VISIT = 150;

let started = false;
let rounds = 0;
let roundsSent = 0;
/** PostHog, once loaded; until then, what was asked of it, in order. */
let ph: PostHog | null = null;
const waiting: ((posthog: PostHog) => void)[] = [];
const withPostHog = (fn: (posthog: PostHog) => void) => (ph ? fn(ph) : waiting.push(fn));

/** Whether the app was opened from the Home Screen: a tag on every event and every error. */
export const standalone = () => Boolean((navigator as Navigator & { standalone?: boolean }).standalone) || matchMedia("(display-mode: standalone)").matches;

/** Run `fn` once the page has loaded and the browser has a moment: for what the first paint should not wait on. */
export function whenIdle(fn: () => void) {
  const idle = () => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

export function startAnalytics() {
  if (!ON || started || typeof window === "undefined") return;
  started = true;
  watchVisit();
  whenIdle(() => void import("posthog-js").then(({ default: posthog }) => load(posthog), () => undefined));
}

function load(posthog: PostHog) {
  posthog.init(KEY, {
    api_host: "/ingest",
    ui_host: `https://${REGION}.posthog.com`,
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    // One page: its load and its leaving, which is where a visit starts and ends.
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    // Load and responsiveness, a handful of events a visit.
    capture_performance: { web_vitals: true, network_timing: false },
    // Crashes go to Sentry, with their stack against our source; counting them twice would only spend both plans.
    capture_exceptions: false,
    // Replays follow the project's own settings (sampling, minimum length). What is typed is never in them, nor who is playing.
    session_recording: { maskAllInputs: true, maskTextSelector: SIGN_IN_PANEL },
  });
  // On every event: whether it was opened from the Home Screen, and which network.
  posthog.register({
    standalone: standalone(),
    network: process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet",
  });
  ph = posthog;
  for (const fn of waiting.splice(0)) fn(posthog);
}

export function track(event: Event, props?: Properties) {
  Sentry.addBreadcrumb({ category: "game", message: event, data: props, level: event.endsWith("_failed") ? "warning" : "info" });
  if (!started) return;
  if (event === "round_finished" && ++rounds > ROUNDS_PER_VISIT) return;
  if (event === "round_finished") roundsSent++;
  withPostHog((posthog) => posthog.capture(event, props));
}

/** Who is playing: the wallet, once signed in, as it is (base58 is case-sensitive). Signing out starts a new anonymous visitor. */
export function identify(address: string | null) {
  Sentry.setUser(address ? { id: address } : null);
  if (!started) return;
  withPostHog((posthog) => (address ? posthog.identify(address) : posthog.reset()));
}

/** Something that went wrong and was caught, so it would not reach the automatic capture. */
export function reportError(error: unknown, props?: Properties) {
  // Which flow it broke in is a tag, so the issues can be filtered by it.
  const flow = typeof props?.flow === "string" ? props.flow : undefined;
  Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: props, tags: flow ? { flow } : undefined });
}

/*
  Active time: how long the game was on screen, sent each time it leaves the
  screen (tab away, lock, close), as one event with that stretch and the
  rounds finished in it. Summed per person and day this is play time, at the
  cost of a single event a visit instead of a heartbeat.
*/
function watchVisit() {
  let shownAt = document.visibilityState === "visible" ? performance.now() : null;
  let roundsAtShow = 0;
  const flush = () => {
    if (shownAt === null) return;
    const activeMs = Math.round(performance.now() - shownAt);
    shownAt = null;
    // Under a second is a flicker, not a visit.
    if (activeMs < 1000) return;
    const visit = { active_ms: activeMs, active_min: Math.round(activeMs / 6000) / 10, rounds: rounds - roundsAtShow, rounds_capped: rounds > roundsSent };
    withPostHog((posthog) => posthog.capture("visit_ended", visit, { transport: "sendBeacon" }));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else {
      shownAt = performance.now();
      roundsAtShow = rounds;
    }
  });
  addEventListener("pagehide", flush);
}

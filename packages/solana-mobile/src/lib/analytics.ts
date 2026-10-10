/**
 * What the app would tell analytics: the web's events (ui/app/src/lib/analytics.ts), by the same names, made where
 * the web makes them. The phone has no analytics service yet, so for now they go to the development console only;
 * wiring one in is this file.
 */

export type Event = "paper_started" | "paper_again" | "paper_ended" | "sign_in_opened";

export function track(event: Event, props?: Record<string, string | number | boolean>) {
  if (__DEV__) console.info(`[analytics] ${event}`, props ?? {});
}

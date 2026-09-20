"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether this is a phone-sized screen.
 *
 * Used to pick a panel that opens upward instead of sideways. A menu anchored
 * beside its trigger is fine on a desk and wrong here: the shapes menu opened
 * to the right of a rail at the left edge, so half of it sat off the screen
 * and the page scrolled sideways to reach it.
 *
 * Answers false on the server and until the first effect, so the desktop
 * layout is what renders first and a phone corrects it before paint matters.
 * Tailwind's `sm` is 640px, and this is the same line so the two never
 * disagree about what a phone is.
 */
const PHONE = "(max-width: 639px)";

let media: MediaQueryList | null = null;

function watch(onChange: () => void) {
  media ??= window.matchMedia(PHONE);
  media.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

export function usePhone(): boolean {
  /*
    Subscribed rather than copied into state. matchMedia is an outside source
    of truth, and reading it through an effect means rendering the wrong
    layout first and correcting it, which is a cascading render and a flash.
  */
  return useSyncExternalStore(
    watch,
    () => (media ??= window.matchMedia(PHONE)).matches,
    () => false,
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/** The build this page is running. */
export const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "local";
/** How often to look while the page is on screen; it also looks each time it comes back to the front. */
const EVERY_MS = 5 * 60_000;

async function liveBuild(): Promise<string | null> {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return null;
    return ((await r.json()) as { build?: string }).build ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a newer build is live than the one running. An iPhone resumes a Home Screen app where it left it,
 * with no address bar to reload from, so the page looks for itself: each time it comes back to the front, and
 * every few minutes on screen. Coming back with nothing in play, it simply reloads, which is the moment the
 * player expects a fresh screen. With ink in play it only says so (`ready`), and reloads when asked.
 */
export function useUpdate(busy: boolean): { ready: boolean; update: () => void } {
  const [ready, setReady] = useState(false);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    if (BUILD === "local") return;
    let alive = true;
    const look = async (resumed: boolean) => {
      const live = await liveBuild();
      if (!alive || !live || live === BUILD) return;
      if (resumed && !busyRef.current) location.reload();
      else setReady(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void look(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => document.visibilityState === "visible" && void look(false), EVERY_MS);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);
  return { ready, update: () => location.reload() };
}

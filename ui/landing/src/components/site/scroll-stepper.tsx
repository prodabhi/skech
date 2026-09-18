"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "./motion";

/** Scroll distance spent on each transition after the first slide. */
const TRAVEL_VH = 75;

/**
 * Pins a carousel and drives it from scroll position.
 *
 * The card sticks to the viewport while a tall spacer scrolls past behind it,
 * and how far through that spacer you are is which slide you are on. Scrolling
 * back rewinds it.
 *
 * `position` comes out fractional, not rounded. A rounded index would flip at
 * thresholds and the track would lurch from one slide to the next no matter how
 * smoothly you scrolled; the fraction lets the track sit wherever the scroll
 * put it, so it tracks the wheel rather than chasing it.
 *
 * The page grows by (slides - 1) x 75vh, which is where the scroll comes from.
 * That is the real cost of this pattern and it is why it is only on the two
 * walkthroughs.
 *
 * Under reduced motion none of it applies: no spacer, no pin, no scroll
 * coupling. The card renders in place and the dots are the only way through it,
 * which is also what someone who has asked for less movement wants.
 */
export function ScrollStepper({
  count,
  children,
  className,
  align = "center",
}: {
  count: number;
  /** Given the fractional position, 0 to count-1. */
  children: (position: number, jumpTo: (i: number) => void) => ReactNode;
  className?: string;
  /** Start directly below an illustrated introduction, without a blank half-screen. */
  align?: "center" | "start";
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(0);
  /** Document-space top and scrollable travel of the spacer. */
  const [geo, setGeo] = useState({ top: 0, travel: 0 });
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || count < 2) {
      return;
    }
    const el = wrap.current;
    if (!el) {
      return;
    }

    let frame = 0;
    const read = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      // Travel is the spacer minus the one viewport the card is pinned in.
      const travel = box.height - window.innerHeight;
      if (travel <= 0) {
        return;
      }
      const through = Math.min(1, Math.max(0, -box.top / travel));
      setPosition(through * (count - 1));
      setGeo({ top: window.scrollY + box.top, travel });
    };
    // Coalesced into a frame: a scroll handler that calls setState directly
    // runs several times per frame on a trackpad and re-renders every chart in
    // the card each time.
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(read);
      }
    };

    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [count, reduced]);

  /**
   * A dot was clicked: scroll to where that slide lives, and let the scroll
   * handler above do the rest. Setting the position directly would put the
   * track somewhere the scroll position disagrees with, and the next wheel
   * event would snap it back.
   *
   * Reads `geo` rather than measuring the element, so it touches no ref. It is
   * handed to a render prop, and a ref-reading closure called during render is
   * something the compiler cannot prove is safe, because it cannot see that
   * this one only ever runs from a click.
   */
  const jumpTo = useCallback(
    (i: number) => {
      if (reduced || count < 2 || geo.travel <= 0) {
        setPosition(i);
        return;
      }
      window.scrollTo({
        top: geo.top + (geo.travel * i) / (count - 1),
        behavior: "smooth",
      });
    },
    [count, reduced, geo],
  );

  if (reduced || count < 2) {
    return <div className={className}>{children(position, setPosition)}</div>;
  }

  return (
    <div
      className={className}
      ref={wrap}
      style={{ height: `calc(100vh + ${(count - 1) * TRAVEL_VH}vh)` }}
    >
      <div
        className={
          align === "start"
            ? "sticky top-24 flex min-h-[calc(100vh-6rem)] items-start"
            : "sticky top-0 flex min-h-screen items-center"
        }
      >
        <div className="w-full">{children(position, jumpTo)}</div>
      </div>
    </div>
  );
}

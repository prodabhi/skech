"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DOT_BETS } from "@skech/core/dots";
import styles from "./amount-wheel.module.css";

/*
  What a dot costs, as the canvas offers it: DOT_BETS in @skech/core. The wheel
  used to run $20 to $500 in fives, which is a position size on a venue that
  takes them. This game stakes per dot, and the smallest is ten cents.
*/
const VALUES: readonly number[] = DOT_BETS;
const MIN = VALUES[0];
const MAX = VALUES[VALUES.length - 1];
const START = 0.25;
const START_INDEX = Math.max(0, VALUES.indexOf(START));
/** Cents under a dollar, dollars at it: "10¢", "25¢", "$1". */
const label = (n: number) => (n < 1 ? `${Math.round(n * 100)}¢` : `$${n}`);

/**
 * The stake, picked on a wheel.
 *
 * It was a static pill with $100 printed in it. The card says "choose how much
 * you put in" and then offered nothing to choose with, which is the one thing
 * this section is trying to prove — that there is nothing to learn, because the
 * controls are the sort you already know.
 *
 * The wheel is a scroll container with snap points, not a drag handler. All of
 * the feel is the platform's: momentum, the rubber band at the ends, the settle
 * onto a snap point, and the fact that the same gesture works from a finger, a
 * trackpad, a mouse wheel and the arrow keys without four code paths. Reading
 * the value back out is one division.
 *
 * Deliberately not reported anywhere: nothing else on the page depends on which
 * amount is showing.
 */
export function AmountWheel() {
  const [index, setIndex] = useState(START_INDEX);
  const wheel = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  /** Height of one row, read from the DOM so CSS stays the single source. */
  const itemHeight = useCallback(() => {
    const el = wheel.current?.querySelector<HTMLElement>(`.${styles.value}`);
    return el?.offsetHeight ?? 44;
  }, []);

  // Opening position, set without animation: the wheel should already be on
  // $100 when it arrives rather than scrolling there in front of the reader.
  useEffect(() => {
    const el = wheel.current;
    if (!el) return;
    el.scrollTop = START_INDEX * itemHeight();
  }, [itemHeight]);

  const onScroll = () => {
    const el = wheel.current;
    if (!el) return;
    // Coalesced to one read per frame. The scroll event fires far faster than
    // paint during a flick, and each handler here measures layout.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next = Math.round(el.scrollTop / itemHeight());
      setIndex(Math.min(VALUES.length - 1, Math.max(0, next)));
    });
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const goTo = (next: number) => {
    const el = wheel.current;
    const clamped = Math.min(VALUES.length - 1, Math.max(0, next));
    if (!el) return;
    setIndex(clamped);
    el.scrollTo({
      top: clamped * itemHeight(),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  const value = VALUES[index];

  return (
    <div className={styles.wrap}>
      <span aria-hidden="true" className={styles.band} />
      {/*
        A slider rather than a listbox. There are 97 values in a fixed
        arithmetic range, which is a quantity being chosen, not a set of
        options — and it means the arrow keys mean what a screen reader will
        already have said they mean.

        Up increases. Dragging the wheel up brings later values into the middle,
        so the key and the gesture agree.
      */}
      <div
        aria-label="What a dot costs"
        aria-valuemax={MAX}
        aria-valuemin={MIN}
        aria-valuenow={value}
        aria-valuetext={label(value)}
        className={styles.wheel}
        onKeyDown={(event) => {
          const by =
            event.key === "ArrowUp" || event.key === "ArrowRight"
              ? 1
              : event.key === "ArrowDown" || event.key === "ArrowLeft"
                ? -1
                : event.key === "PageUp"
                  ? 5
                  : event.key === "PageDown"
                    ? -5
                    : 0;
          if (by !== 0) {
            event.preventDefault();
            goTo(index + by);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            goTo(0);
          } else if (event.key === "End") {
            event.preventDefault();
            goTo(VALUES.length - 1);
          }
        }}
        onScroll={onScroll}
        ref={wheel}
        role="slider"
        tabIndex={0}
      >
        <div className={styles.track}>
          {VALUES.map((amount, i) => (
            <div
              className={styles.value}
              data-near={Math.abs(i - index) === 1 ? "" : undefined}
              data-selected={i === index ? "" : undefined}
              key={amount}
            >
              {label(amount)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

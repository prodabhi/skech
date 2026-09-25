import { memo, useLayoutEffect, useRef } from "react";
import feedback from "./drawing-feedback.module.css";

/** Only changed characters move; the current amount is always fully visible. */
export const CrispNumber = memo(function CrispNumber({ value }: { value: string }) {
  return <span className={feedback.number}><span className="sr-only">{value}</span><span aria-hidden="true">{Array.from(value).map((char, index) => <span className={feedback.digit} key={`${value.length - index}:${char}`}>{char}</span>)}</span></span>;
});

/** How long money takes to count up to a gain, ms: quick enough that it is never the figure being waited on. */
const RISE_MS = 650;

/**
 * Money that counts up to a gain, cent by cent, rather than jumping to it; anything else (a stake going out, the first
 * figure) is simply shown. Written straight into the page each frame, so the screen around it never renders for it,
 * and a screen reader is only ever told the true amount. With Reduce Motion on, it jumps.
 */
export const RisingMoney = memo(function RisingMoney({ value, format }: { value: number; format: (n: number) => string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const from = shown.current;
    if (from === null || !(value > from) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shown.current = value;
      node.textContent = format(value);
      return;
    }
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / RISE_MS);
      const at = k >= 1 ? value : from + (value - from) * (1 - (1 - k) ** 3);
      shown.current = at;
      node.textContent = format(k >= 1 ? value : Math.floor(at * 100) / 100);
      if (k < 1) raf = requestAnimationFrame(step);
    });
    // A new figure mid-count counts on from wherever this one had got to.
    return () => cancelAnimationFrame(raf);
  }, [value, format]);
  return <span className={feedback.number}><span className="sr-only">{format(value)}</span><span aria-hidden="true" ref={el} /></span>;
});

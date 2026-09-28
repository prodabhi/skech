"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/app/logo";

/**
 * The way in, on every load: the pen runs across the screen scribbling in
 * blue until the page is inked over, "skech" wobbles in the middle, and the
 * ink wipes away off the game underneath.
 *
 * One stroke along one zigzag, as a pen would draw it: the ink grows as it
 * goes, so it covers the screen by the time the pen is out, then drains from
 * its tail. Drawn on a viewBox stretched to the screen, so it covers any
 * shape of window.
 */

/* A zigzag down the screen, from off its top left to off its bottom, in a 1000 by 1000 box. */
const SCRIBBLE =
  "M -120 60 C 300 -60, 900 40, 1120 140 C 900 300, 300 200, -120 360 C 300 520, 800 380, 1120 560 C 800 760, 200 600, -120 780 C 300 980, 800 860, 1120 1000 C 900 1120, 500 1060, 400 1160";
/** How long the pen takes to ink the screen over, and the ink to drain away, in ms. */
const IN_MS = 1000;
const OUT_MS = 1100;
/** How thick the ink is at its thinnest and when the screen is covered, in the box's units. */
const THIN = 60;
const THICK = 390;
/** Where the nib is on the pen's picture, as shares of its width and height. */
const NIB = { x: 0.517, y: 0.892 };
const PEN_W = 360;
const PEN_H = 459;

/** The longest the ink holds for live prices before it drains anyway, in ms. */
const MAX_HOLD_MS = 8000;

/*
  Whether the game has live prices to show. The ink holds, covering the
  screen, until it does, so the way in never ends on "Waiting for live
  prices". Set by the screen; read by the running intro.
*/
let ready = false;
export function introReady() {
  ready = true;
}

const inOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const clamp = (k: number) => Math.min(1, Math.max(0, k));

export function InkIntro() {
  const [done, setDone] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const ink = useRef<SVGPathElement>(null);
  const pen = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = overlay.current, s = svg.current, path = ink.current, nib = pen.current, mark = logo.current;
    if (!box || !s || !path || !nib || !mark) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    /** When the ink starts to drain: once it has covered the screen and the prices are in. */
    let drainAt = Number.POSITIVE_INFINITY;
    const drainFrom = (t: number, earliest: number) => {
      if (drainAt === Number.POSITIVE_INFINITY && t >= earliest && (ready || t > MAX_HOLD_MS)) drainAt = t;
      return drainAt;
    };
    if (still) {
      // No scribble: the name until the prices are in, then the game.
      mark.style.opacity = "1";
      const wait = () => {
        if (drainFrom(performance.now() - start, 500) === Number.POSITIVE_INFINITY) { timer = setTimeout(wait, 100); return; }
        box.style.transition = "opacity 250ms ease-out";
        box.style.opacity = "0";
        timer = setTimeout(() => setDone(true), 260);
      };
      timer = setTimeout(wait, 500);
      return () => clearTimeout(timer);
    }
    const total = path.getTotalLength();
    const frame = (now: number) => {
      const t = now - start;
      const drain = drainFrom(t, IN_MS);
      let head: number, tail: number, width: number;
      if (t < IN_MS) {
        const k = inOut(t / IN_MS);
        head = k; tail = 0; width = THIN + (THICK - THIN) * k;
      } else if (t < drain) {
        // Covered, and holding for the prices.
        head = 1; tail = 0; width = THICK;
      } else {
        const k = inOut(clamp((t - drain) / OUT_MS));
        head = 1; tail = k; width = THICK - (THICK - THIN) * k;
        // Covered: the page underneath is uncovered as the ink drains, not before.
        box.style.background = "transparent";
      }
      path.style.strokeDasharray = `${Math.max(0, head - tail)} 2`;
      path.style.strokeDashoffset = `${-tail}`;
      path.style.strokeWidth = `${width}`;
      // The pen rides the head of the ink, nib on it, until it has run off the screen.
      if (t < IN_MS) {
        const at = path.getPointAtLength(head * total);
        const m = s.getScreenCTM();
        if (m) {
          const p = new DOMPoint(at.x, at.y).matrixTransform(m);
          const w = nib.offsetWidth, h = nib.offsetHeight;
          const wobble = Math.sin(t / 70) * 5;
          nib.style.transform = `translate(${p.x - w * NIB.x}px, ${p.y - h * NIB.y}px) rotate(${wobble}deg)`;
        }
        nib.style.opacity = "1";
      } else nib.style.opacity = "0";
      // The name shows while the screen is inked over, ticking side to side.
      const showing = t > IN_MS * 0.55 && t < drain + OUT_MS * 0.45;
      mark.style.opacity = showing ? "1" : "0";
      mark.style.transform = `translate(-50%, -50%) rotate(${Math.floor(t / 150) % 2 ? 4 : -4}deg)`;
      if (t < drain + OUT_MS) raf = requestAnimationFrame(frame);
      else setDone(true);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (done) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100] overflow-hidden bg-background" ref={overlay}>
      <svg className="absolute inset-0 size-full text-brand" preserveAspectRatio="none" ref={svg} viewBox="0 0 1000 1000">
        <path d={SCRIBBLE} fill="none" pathLength={1} ref={ink} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" style={{ strokeDasharray: "0 2", strokeWidth: THIN }} />
      </svg>
      <div className="absolute top-1/2 left-1/2 text-background opacity-0 transition-opacity duration-150 [&_span]:text-[44px] sm:[&_span]:text-[56px]" ref={logo} style={{ transform: "translate(-50%, -50%)" }}>
        <Wordmark className="gap-3 text-background [&>span:first-child]:h-11 [&>span:first-child]:w-14 sm:[&>span:first-child]:h-14 sm:[&>span:first-child]:w-[72px]" />
      </div>
      <div className="absolute top-0 left-0 w-[110px] opacity-0 drop-shadow-[0_0_2px_white] sm:w-[150px]" ref={pen}>
        <Image alt="" className="h-auto w-full drop-shadow-[0_8px_14px_rgb(0_0_0/0.18)]" height={PEN_H} priority src="/assets/pen-mascot.png" width={PEN_W} />
      </div>
    </div>
  );
}

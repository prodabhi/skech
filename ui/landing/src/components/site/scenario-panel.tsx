"use client";

import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useInView, useReducedMotion } from "./motion";
import { useEffect, useRef, useState } from "react";
import { FORECAST_BARS, SCENARIOS } from "./market-data";
import { ScenarioChart } from "./scenario-chart";
import styles from "./worked-example.module.css";

const RUN_MS = 4400;

/** A single walkthrough of price following the drawn path. */
export function ScenarioPanel() {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const elapsed = useRef(0);
  const reduced = useReducedMotion();
  /*
   * Held until the panel reaches the middle of the screen, not the bottom edge
   * of it. The run is 4.4s and it used to start on 15% of the block being
   * visible, which on a phone is about 44px — so on the way down the whole
   * thing had played out before it was properly in front of anybody, and what
   * you arrived at was a finished chart. Trimming a fifth off the top of the
   * root and a quarter off the bottom means it waits its turn.
   */
  const [ref, inView] = useInView<HTMLDivElement>(0, "-20% 0px -25% 0px");

  useEffect(() => {
    if (reduced || paused || !inView) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      elapsed.current = Math.min(RUN_MS, elapsed.current + now - previous);
      previous = now;
      setStep(Math.round(elapsed.current / RUN_MS * FORECAST_BARS));
      if (elapsed.current < RUN_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, inView, reduced]);

  const scenario = SCENARIOS[0];
  const shown = reduced ? FORECAST_BARS : step;
  const done = shown >= FORECAST_BARS;
  return (
    <div className={styles.demo} ref={ref}>
      <ScenarioChart scenario={scenario} step={shown} />
      <div className={styles.controls}>
        <div className={styles.legend}><span><i className={styles.blue} />Your drawn path</span><span><i />Bitcoin price</span></div>
        {!reduced && <button className={styles.button} type="button" aria-label={done ? "Replay the walkthrough" : paused ? "Play the walkthrough" : "Pause the walkthrough"} onClick={() => {
            if (done) { elapsed.current = 0; setStep(0); setPaused(true); requestAnimationFrame(() => setPaused(false)); }
            else setPaused(value => !value);
          }}>
            {done ? <RotateCcwIcon aria-hidden="true" /> : paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
            {done ? "Replay" : paused ? "Play" : "Pause"}
          </button>}
      </div>
    </div>
  );
}

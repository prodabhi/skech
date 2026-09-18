import type { ReactNode, RefObject } from "react";
import { smoothPath } from "./market-data";
import styles from "./sketch-chart.module.css";

export const PLOT = {
  width: 760,
  height: 360,
  left: 24,
  right: 724,
  top: 32,
  bottom: 324,
  start: 52,
};

export type PlotPoint = { x: number; y: number };

/** Shared bounds keep the same price at the same height in every outcome. */
export function priceScale(prices: number[]) {
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const padding = Math.max(1, (high - low) * 0.1);
  const span = high - low + padding * 2;
  return {
    y: (price: number) => PLOT.top + (high + padding - price) / span * (PLOT.bottom - PLOT.top),
    price: (y: number) => high + padding - (y - PLOT.top) / (PLOT.bottom - PLOT.top) * span,
  };
}

/** A drawn forecast and the market, with no labels laid over either line. */
export function SketchPlot({
  drawn, market, entryY, label, children, plotRef,
}: {
  drawn: PlotPoint[];
  market: PlotPoint[];
  entryY: number;
  label: string;
  children?: ReactNode;
  plotRef?: RefObject<HTMLDivElement | null>;
}) {
  const head = market[market.length - 1];
  const end = drawn[drawn.length - 1];
  return (
    <figure className={styles.figure}>
      {market.length > 0 && <figcaption className={styles.legend}>
        <span><i className={styles.drawnKey} />Your line</span>
        {market.length > 0 && <span><i className={styles.marketKey} />Market price</span>}
      </figcaption>}
      <div className={styles.plot} ref={plotRef}>
        <svg
          aria-label={label}
          className={styles.svg}
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        >
          <path className={styles.drawn} d={smoothPath(drawn)} />
          {market.length > 1 && <path className={styles.market} d={smoothPath(market)} />}
        </svg>
        <span
          aria-hidden="true"
          className={styles.entryDot}
          style={{ left: `${PLOT.start / PLOT.width * 100}%`, top: `${entryY / PLOT.height * 100}%` }}
        />
        {head && <span aria-hidden="true" className={styles.marketDot} style={{ left: `${head.x / PLOT.width * 100}%`, top: `${head.y / PLOT.height * 100}%` }} />}
        {!children && end && <span aria-hidden="true" className={styles.drawnDot} style={{ left: `${end.x / PLOT.width * 100}%`, top: `${end.y / PLOT.height * 100}%` }} />}
        {children}
      </div>
    </figure>
  );
}

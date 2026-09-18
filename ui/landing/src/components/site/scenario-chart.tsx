import { memo } from "react";
import { DRAWN_PATH, FORECAST_BARS, ORDER, SCENARIOS, fmtUsd, pnlAt, smoothPath, type Scenario } from "./market-data";
import { PLOT, priceScale } from "./sketch-plot";

import { signed } from "./chart";
import styles from "./worked-example.module.css";

const scale = priceScale([
  ...DRAWN_PATH.map(point => point.price),
  ...SCENARIOS[0].bars.flatMap(bar => [bar.h, bar.l]),
]);
const drawn = DRAWN_PATH.map(point => ({
  x: PLOT.start + point.t * (PLOT.right - PLOT.start), y: scale.y(point.price),
}));
export function markAt(scenario: Scenario, step: number) {
  return step <= 0 ? ORDER.entry : scenario.bars[Math.min(step, scenario.bars.length) - 1].c;
}
export const ScenarioChart = memo(function ScenarioChart({ scenario, step }: { scenario: Scenario; step: number }) {
  const market = [
    { x: PLOT.start, y: scale.y(ORDER.entry) },
    ...scenario.bars.slice(0, step).map((bar, index) => ({
      x: PLOT.start + (index + 1) / FORECAST_BARS * (PLOT.right - PLOT.start), y: scale.y(bar.c),
    })),
  ];
  const head = market[market.length - 1];
  const amount = signed(pnlAt(markAt(scenario, step)));
  return (
    <div className={styles.chart}>
      <svg role="img" aria-label={`Bitcoin price follows your drawn path. Return ${amount}, at a price of $${fmtUsd(markAt(scenario, step))}.`} viewBox={`0 0 ${PLOT.width} ${PLOT.height}`} preserveAspectRatio="none">
        <path className={styles.forecast} d={smoothPath(drawn)} />
        {market.length > 1 && <path className={styles.market} d={smoothPath(market)} />}
      </svg>
      <span aria-hidden="true" className={styles.start} style={{ left: `${PLOT.start / PLOT.width * 100}%`, top: `${scale.y(ORDER.entry) / PLOT.height * 100}%` }} />
      <span aria-hidden="true" className={styles.head} style={{ left: `${head.x / PLOT.width * 100}%`, top: `${head.y / PLOT.height * 100}%` }} />
      <span aria-label={`Your return: ${amount}`} className={styles.amount} style={{ left: `clamp(2.75rem, ${head.x / PLOT.width * 100}%, calc(100% - 2.75rem))`, top: `calc(${head.y / PLOT.height * 100}% - 16px)` }}>{amount}</span>
    </div>
  );
});

import { cn } from "@/lib/utils";
import { type Candle, fmtUsd } from "./market-data";

/**
 * Candles, drawn the one way.
 *
 * Every chart on the page (the drawable one in the hero, the worked example,
 * the redraw walkthrough) had its own copy of this loop, and they had already
 * drifted: different minimum body heights, different wick widths, the same
 * colour expression written six times. A candle should look like a candle
 * everywhere, so there is one of these now and the callers supply only what
 * genuinely differs: where bar `i` sits, how wide its body is, and how far
 * back it should sit.
 *
 * `x` is a function rather than a step, because the forecast half of a chart
 * spaces its bars differently from the history half.
 */
export function Candles({
  bars,
  y,
  x,
  body,
  opacity,
  minBody = 1,
  wick = 0.9,
}: {
  bars: Candle[];
  /** Price to plot position. */
  y: (price: number) => number;
  /** Centre of bar `i`. */
  x: (i: number) => number;
  body: number;
  opacity?: number | string;
  /** Floor for the body, so a doji is still a mark and not a gap. */
  minBody?: number;
  wick?: number;
}) {
  return (
    <>
      {bars.map((c, i) => {
        const cx = x(i);
        const rising = c.c >= c.o;
        const top = y(Math.max(c.o, c.c));
        const bottom = y(Math.min(c.o, c.c));
        const tone = rising ? "var(--up)" : "var(--down)";
        return (
          <g
            fill={tone}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional series
            key={i}
            opacity={opacity}
            stroke={tone}
          >
            <line strokeWidth={wick} x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
            <rect
              height={Math.max(minBody, bottom - top)}
              width={body}
              x={cx - body / 2}
              y={top}
            />
          </g>
        );
      })}
    </>
  );
}

/** Evenly spaced bar centres, for a series that fills a fixed span. */
export const spacing = (left: number, step: number) => (i: number) =>
  left + i * step + step / 2;

/**
 * A line in a panel's rail: a quiet label, a figure that lines up with the
 * figures above and below it.
 *
 * `tone` carries direction, so the caller decides whether a number is good
 * news; the row only decides how a number is set.
 */
export function RailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-fg-subtle text-sm">{label}</span>
      <span
        className={cn("figures text-sm", tone ?? "text-foreground")}
      >
        {value}
      </span>
    </div>
  );
}

/** Money with its sign, and a plain "$0" when there is nothing in it yet. */
export function signed(n: number) {
  if (Math.round(n) === 0) {
    return "$0";
  }
  return `${n > 0 ? "+" : "−"}$${fmtUsd(Math.abs(n))}`;
}

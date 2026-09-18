import { LADDER, MIN_INK_MULTIPLE } from "@skech/core/ink";
import type { ReactNode } from "react";
import { AmountWheel } from "./amount-wheel";
import { StorySection } from "./story-section";
import styles from "./story.module.css";
import { smoothPath } from "./market-data";

/* What a section can pay, from the game rather than from this page. */
const MOST = LADDER[LADDER.length - 1];
const LEAST = Math.round(MIN_INK_MULTIPLE);

/** The three decisions, visible together in their actual order. */
const STEPS: {
  title: string;
  caption: string;
  visual: ReactNode;
}[] = [
  {
    title: "Pick what a dot costs",
    caption: "Ten cents up to a dollar, the same for every dot.",
    visual: <AmountWheel />,
  },
  {
    title: "Draw where it goes",
    caption: "Ahead of the price, as far out as you like.",
    visual: <DrawnLine />,
  },
  {
    title: "The ink it runs through pays",
    caption: "Each second the price spends inside your line pays.",
    visual: <Ladder />,
  },
];

/** The gesture, at a glance. A still is fine here; the live one is the hero. */
const LINE_PTS = [
  { x: 6, y: 62 },
  { x: 34, y: 50 },
  { x: 62, y: 68 },
  { x: 92, y: 78 },
  { x: 122, y: 58 },
  { x: 152, y: 40 },
  { x: 182, y: 46 },
  { x: 214, y: 18 },
];

function DrawnLine() {
  const pts = LINE_PTS;
  const head = pts[pts.length - 1];
  return (
    <svg
      aria-hidden="true"
      className="w-full"
      fill="none"
      viewBox="0 0 220 96"
    >
      <line
        stroke="var(--fg-subtle)"
        strokeDasharray="3 4"
        strokeOpacity="0.35"
        x1="0"
        x2="220"
        y1="62"
        y2="62"
      />
      <path
        d={smoothPath(pts)}
        stroke="var(--brand)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <circle cx={head.x} cy={head.y} fill="var(--brand)" r="3.6" />
    </svg>
  );
}

/** What you put in. The same three chips the canvas offers, so the two agree. */

/**
 * What a rung pays.
 *
 * This card used to be a leverage meter: "put in $100, trade like $1,000". There is no leverage in this game and
 * no boost anywhere in the app, so the card now shows the thing that actually decides a payout. Ink where the
 * price is unlikely to go sits on a higher rung and pays more for being there; nothing pays below the floor.
 *
 * Both figures come from the game's own settings, so the card cannot promise a multiple the game will not pay.
 */
function Ladder() {
  const rungs = [1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="flex w-full flex-col justify-center gap-2.5">
      <div className="flex h-16 items-end gap-1.5">
        {rungs.map(rung => (
          <span
            className="flex-1 rounded-t-sm bg-brand"
            key={rung}
            style={{
              height: `${20 + (rung / rungs.length) * 80}%`,
              opacity: 0.3 + (rung / rungs.length) * 0.7,
            }}
          />
        ))}
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="figures text-fg-muted">{LEAST}×</span>
        <span className="figures font-medium text-brand">{MOST}×</span>
      </div>
    </div>
  );
}

export function HowItWorks() {
  return (
    <StorySection
      id="how-it-works"
      titleId="how-title"
      title="Nothing to learn."
      lead="An amount, a line, and whatever the price does to it."
      scene="steps"
      overview
    >
      <div className={styles.stepGrid}>
        {STEPS.map((step) => (
          <article className={styles.step} key={step.title}>
            <h3 className={styles.stepTitle}>
              {step.title}
            </h3>
            <div className={styles.stepVisual}>{step.visual}</div>
            <p className={styles.stepCaption}>{step.caption}</p>
          </article>
        ))}
      </div>
    </StorySection>
  );
}

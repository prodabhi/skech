import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GradientCard } from "./gradient-card";
import { Body } from "./type";

/** One panel in the carousel. */
export type Slide = {
  key: string;
  /** Names the slide for its dot and for screen readers. */
  label: string;
  title: string;
  caption: ReactNode;
  visual: ReactNode;
  /** A rail of figures beside the visual. */
  aside?: ReactNode;
};

/**
 * How much of the viewport one panel occupies.
 *
 * The remainder is the peek: 16cqw split between the two neighbours, so roughly
 * 76px of each shows on a full-width page and 28px on a phone. 12cqw was the
 * first guess and it was too mean — on a near-black card against a near-black
 * ground, a 50px sliver reads as a vertical smudge rather than as a card with
 * more content on it.
 *
 * `cqw` rather than `%`. A percentage translate resolves against the element
 * being moved, and the element being moved is the track, whose width is the
 * slide count times this — so the arithmetic would silently change every time a
 * caller added a slide. Container units resolve against the viewport, which is
 * the box a slide is being centred in, so the sum below holds for three slides
 * or thirty.
 */
const SLIDE = "84cqw";

/**
 * The dark stepped card, as a carousel you can see the sides of.
 *
 * It used to render only the active slide, replaying its contents in place.
 * That reads as one panel redrawing itself: nothing on screen said more panels
 * existed, so the dots carried that alone and a reader who did not look at them
 * had no reason to wait. Showing the edges of the neighbours and sliding
 * between them makes the set obvious without a word of copy, and gives the
 * movement a direction, which a fade does not have.
 *
 * Every slide is mounted, not just the active one, which is the cost of the
 * peek. Callers whose slides are expensive to draw should memoise them — see
 * the note in scenario-panel.tsx, where three live charts would otherwise
 * re-render on every frame of one animating chart.
 *
 * Advancing is the caller's business. Both walkthroughs now hand it a
 * fractional `active` driven by scroll (see ScrollStepper), but the component
 * does not care where the number came from.
 *
 * `active` may be fractional. The track is translated by the raw value so it
 * can sit between two slides while a scroll is in progress; everything that has
 * to pick one slide, the dots and the scale and `inert`, rounds it. Passing a
 * whole number behaves exactly as before.
 */
export function StepCard({
  slides,
  active,
  onSelect,
  label,
  tracking,
  bodyClass,
  action,
}: {
  slides: readonly Slide[];
  /** May be fractional while a scroll is mid-transition. */
  active: number;
  onSelect: (index: number) => void;
  /**
   * The position is being driven directly, so the track must not also ease
   * toward it: two easings on one value is what makes a scroll-linked carousel
   * feel like it is lagging behind the wheel.
   */
  tracking?: boolean;
  /** Names the set of dots, e.g. "Steps" or "Scenarios". */
  label: string;
  /** Height of the visual area. Fixed, so slides cannot resize the card. */
  bodyClass?: string;
  /** Sits beside the dots. */
  action?: ReactNode;
}) {
  const index = Math.round(active);

  return (
    <div>
      {/*
        The viewport. `overflow-hidden` clips the neighbours to the page, and
        the vertical padding is what stops it clipping the active card's own
        shadow at the same time: hiding one axis forces the other to clip or
        scroll too, so the shadow needs its room inside the box rather than
        outside it.
      */}
      <div className="overflow-hidden py-4 [container-type:inline-size]">
        <div
          className={cn(
            "flex",
            tracking
              ? null
              : "transition-transform duration-slow ease-out-expo motion-reduce:transition-none",
          )}
          style={{
            transform: `translateX(calc((100cqw - ${SLIDE}) / 2 - ${active} * ${SLIDE}))`,
          }}
        >
          {slides.map((slide, i) => {
            const current = i === index;
            return (
              <div
                className="relative shrink-0 px-1.5 md:px-2.5"
                key={slide.key}
                style={{ width: SLIDE }}
              >
                {/*
                  Scale carries most of the recession and opacity only tops it
                  up. Dimming a dark card on a dark page mostly deletes it:
                  at 0.4 the neighbours disappeared into the background and the
                  peek stopped reading as a card at all.

                  `inert` rather than a lower opacity alone. The panels either
                  side are full of real controls — a pause button, a draggable
                  handle — and without it tabbing off the active card walks into
                  a card that is mostly off screen, stranding the focus ring
                  somewhere the reader cannot see.
                */}
                <div
                  className={cn(
                    "transition-[transform,opacity] duration-slow ease-out-expo motion-reduce:transition-none",
                    current
                      ? "scale-100 opacity-100"
                      : "scale-[0.93] opacity-75",
                  )}
                  inert={current ? undefined : true}
                >
                  <GradientCard>
                    <div className="cult-card relative flex flex-col overflow-hidden rounded-3xl p-7 md:p-10">
                      {/*
                        Both boxes below are fixed, not minimums. With a
                        min-height the card grew by 89px between the shortest
                        and tallest slide and the whole page below it jumped on
                        every tick, which is worse than any amount of dead
                        space. The caption reserves two lines because some are
                        one line long and some are two.
                      */}
                      <div className="flex flex-col gap-2.5 md:w-4/6">
                        <h3 className="font-semibold text-[1.375rem] text-foreground tracking-[-0.02em] md:text-2xl">
                          {slide.title}
                        </h3>
                        <Body className="min-h-[3.25rem] max-w-[46ch]">
                          {slide.caption}
                        </Body>
                      </div>

                      <div
                        className={cn(
                          // `overflow-hidden` is not cosmetic. A visual taller
                          // than this box used to spill past the card and
                          // swallow clicks meant for what was underneath.
                          "flex gap-6 overflow-hidden py-8 md:py-10",
                          slide.aside
                            ? "flex-col lg:flex-row lg:items-center"
                            : "items-center justify-center",
                          bodyClass ?? "h-60 md:h-64",
                        )}
                      >
                        {/*
                          StepCard owns the visual's box rather than trusting
                          the caller to wrap it. `max-h-full` on the drawing is
                          a percentage, so it only clamps if every ancestor up
                          to the fixed-height row has a definite height; when
                          the caller supplied its own auto-height wrapper the
                          clamp silently did nothing and the drawing overflowed.
                        */}
                        <div
                          className={cn(
                            "flex h-full min-w-0 items-center justify-center",
                            slide.aside ? "flex-1" : "w-full max-w-2xl",
                          )}
                        >
                          <div className="flex h-full w-full items-center justify-center [&>*]:w-full [&_svg]:max-h-full">
                            {slide.visual}
                          </div>
                        </div>
                        {slide.aside ? (
                          <div className="lg:w-64 lg:shrink-0">
                            {slide.aside}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </GradientCard>
                </div>

                {/*
                  The visible sliver of a neighbour is the most obvious thing on
                  screen to click, so it selects that panel. An overlay rather
                  than a wrapper, because a card full of buttons cannot legally
                  sit inside one, and it lives outside the `inert` subtree above
                  so it stays clickable while the card under it does not.
                */}
                {current ? null : (
                  <button
                    aria-label={`Show ${slide.label}`}
                    className="absolute inset-0 z-10 cursor-pointer"
                    onClick={() => onSelect(i)}
                    type="button"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/*
        Slider dots, under the track rather than inside the active card: they
        belong to the set, not to one panel, and a control printed on a card
        that slides away would be the one thing on screen that cannot be used
        to stop the sliding.

        The active one stretches into a bar rather than just changing colour, so
        which slide you are on survives being glanced at, and so the control
        still reads without relying on hue. Each is a real button carrying the
        slide's name, because three identical circles are unusable with a screen
        reader otherwise.
      */}
      <div className="mt-2 flex items-center gap-3 px-2 md:px-4">
        <div
          aria-label={label}
          className="flex flex-1 items-center justify-center gap-2"
          role="tablist"
        >
          {slides.map((slide, i) => {
            const current = i === index;
            return (
              <button
                aria-label={slide.label}
                aria-selected={current}
                className="group cursor-pointer p-2"
                key={slide.key}
                onClick={() => onSelect(i)}
                role="tab"
                type="button"
              >
                <span
                  className={cn(
                    "block h-1.5 rounded-full transition-all duration-medium ease-out-expo",
                    current
                      ? "w-7 bg-brand"
                      : "w-1.5 bg-white/28 group-hover:bg-white/50",
                  )}
                />
              </button>
            );
          })}
        </div>
        {action}
      </div>
    </div>
  );
}

/**
 * Pause and resume, for the cards that advance on their own.
 *
 * Shared rather than written twice because both walkthroughs want the same
 * control in the same corner, and anything that moves by itself owes the
 * reader a way to stop it.
 *
 * `subject` completes the label, so a screen reader hears "Pause the steps"
 * rather than three identical unlabelled circles and a pause button.
 */
export function PauseButton({
  paused,
  onToggle,
  subject,
}: {
  paused: boolean;
  onToggle: () => void;
  /** What stops, e.g. "the steps" or "the walkthrough". */
  subject: string;
}) {
  return (
    <button
      aria-label={paused ? `Play ${subject}` : `Pause ${subject}`}
      className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/8 text-fg-subtle transition-colors duration-fast ease-smooth-out hover:bg-white/14 hover:text-foreground"
      onClick={onToggle}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="size-2.5"
        fill="currentColor"
        viewBox="0 0 12 12"
      >
        {paused ? (
          <path d="M2 0 L12 6 L2 12 Z" />
        ) : (
          <>
            <rect height="12" width="3.5" x="1" y="0" />
            <rect height="12" width="3.5" x="7.5" y="0" />
          </>
        )}
      </svg>
    </button>
  );
}

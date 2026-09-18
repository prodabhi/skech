import styles from "./hero.module.css";
import { HeroScene } from "./illo";
import { Reveal } from "./motion";
import { DrawATrade } from "./app-link";
import { Body, Display } from "./type";

/**
 * The drawn line, as a glyph.
 *
 * `PenLineIcon` was a stock pen nib at an angle: it says "edit this text",
 * which is the one thing the button does not do. This is the mark the product
 * actually makes — a rising line with a round head on its leading end, the same
 * shape the canvas leaves behind and the same one the logo is built from.
 */
function DrawGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 20 20"
    >
      <path d="M2.4 13.9c2.1 0 3.1-4.1 4.9-4.1 1.4 0 1.9 2.8 3.3 2.8 1.8 0 2.6-5.4 5.2-6.2" />
      <circle cx="16.3" cy="6.2" fill="currentColor" r="1.7" stroke="none" />
    </svg>
  );
}

/** A full-width illustrated introduction, and the way into the app. */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className={styles.stage} id="top">
      <HeroScene />

      <div className={styles.content}>
        <Reveal index={1}>
          <Display id="hero-title">
            <span className="block">Draw the chart.</span>
            <span className="block">Trade the line.</span>
          </Display>
        </Reveal>

        <Reveal index={2}>
          <Body className="mx-auto mt-6 max-w-[25rem] text-balance md:text-lg">
            Think it goes up? Draw it going up.
            <span className="block">That&rsquo;s the whole thing.</span>
          </Body>
        </Reveal>

        <Reveal index={3}>
          <div className="mt-8 flex justify-center">
            <DrawATrade className="min-h-12 px-6">
              <DrawGlyph className="size-5" />
            </DrawATrade>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

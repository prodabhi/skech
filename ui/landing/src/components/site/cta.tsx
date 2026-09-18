import { CtaScene } from "./illo";
import { Reveal } from "./motion";
import { DrawATrade } from "./app-link";
import { Display } from "./type";
import styles from "./story.module.css";

/**
 * The close: one headline and the way in. The app is live, so the page's one
 * ask is to start it; it used to be an email for the waitlist.
 */
export function Cta() {
  return (
    <section aria-labelledby="cta-title" className={styles.cta} id="start">
      <Reveal className={styles.ctaCard}>
        <div>
          <Display as="h2" className="max-w-[11ch]" id="cta-title">
            Go draw something.
          </Display>
          <DrawATrade className="mt-8 min-h-12 px-6" />
        </div>
        <CtaScene className={styles.ctaArt} />
      </Reveal>
    </section>
  );
}

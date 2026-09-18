import { LADDER, MIN_INK_MULTIPLE } from "@skech/core/ink";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "./motion";
import { SectionScene } from "./illo";
import styles from "./story.module.css";

/* What a section can pay, from the game rather than from this page. */
const MOST = LADDER[LADDER.length - 1];
const LEAST = Math.round(MIN_INK_MULTIPLE);

const FAQS = [
  {
    q: "What does my drawing actually do?",
    a: "Your line is cut into one-second pieces. Each covers a band of prices and pays if the price comes through it that second. The ones it misses are gone.",
  },
  {
    q: "How much does a hit pay?",
    a: `Between ${LEAST}\u00d7 and ${MOST}\u00d7, set by how likely that band was. Ink where the price was never expected pays the most for being right.`,
  },
  {
    q: "Can I set a limit on what I lose?",
    a: "You set it before you draw. Every dot costs what you chose, and you can never lose more than the ink you put down.",
  },
  {
    q: "Do you hold my money?",
    a: "Your balance is USDC held by the game on Solana. Deposits, withdrawals and every drawing are transactions on chain.",
  },
] as const;

/**
 * The first answer is open so the questions read as part of the page.
 *
 * Plain <details>, one open at a time through their shared `name`: the browser
 * does what Base UI's accordion did, with no script to load or hydrate.
 */
export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={styles.faq} id="faq">
      <Reveal>
        <h2 className={styles.title} id="faq-title">
          Questions, answered.
        </h2>
        <SectionScene className={styles.faqArt} name="faq" />
      </Reveal>

      <div className={styles.questions}>
        {FAQS.map((item, i) => (
            <details className={cn("group border-b last:border-b-0", styles.question)} key={item.q} name="faq" open={i === 0}>
              <summary className="flex flex-1 cursor-pointer list-none items-start justify-between gap-4 rounded-md py-5 text-left font-medium text-body text-foreground outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDownIcon
                  aria-hidden="true"
                  className="pointer-events-none size-4 shrink-0 translate-y-0.5 opacity-80 transition-transform duration-200 ease-in-out group-open:rotate-180"
                />
              </summary>
              <div className="measure pt-0 pb-6 text-fg-muted text-sm leading-[1.75]">
                {item.a}
              </div>
            </details>
        ))}
      </div>
    </section>
  );
}

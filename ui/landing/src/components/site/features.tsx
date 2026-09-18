import Image from "next/image";
import { LADDER, MIN_INK_MULTIPLE } from "@skech/core/ink";
import { Crowd } from "./crowd";
import styles from "./features.module.css";

/*
  What a section can pay: the ladder's top rung. MAX_INK_MULTIPLE is not it (that is the most dots one section pays,
  256), nor RULES.maxMultiple, which shapes the odds and sat at 14x: this tile has said both.
*/
const MOST = LADDER[LADDER.length - 1];
const LEAST = Math.round(MIN_INK_MULTIPLE);

/**
 * `slot` is the tile's place in the bento (features.module.css owns those names); `art` is what it shows. They are
 * separate because the layout outlived the product: the grid areas still read as the perps app this began as.
 */
const FEATURES = [
  {
    slot: "funding",
    art: null,
    size: [0, 0],
    title: "Everyone\u2019s ink, live",
    description: "Other players\u2019 lines appear on your chart as they draw them.",
  },
  {
    slot: "leverage",
    art: { light: "ladder", dark: "ladder-dark" },
    size: [1254, 1254],
    title: `${LEAST}\u00d7 to ${MOST}\u00d7`,
    description: "The less likely the ink, the more it pays.",
  },
  {
    slot: "fees",
    art: { light: "fees", dark: "fees-dark" },
    size: [1200, 900],
    title: "Low trading fees",
    description: "Small, and the same whatever you draw.",
  },
  {
    slot: "markets",
    art: { light: "bitcoin", dark: "bitcoin-dark" },
    size: [1254, 1254],
    title: "Bitcoin, second by second",
    description: "One market, judged a second at a time.",
  },
  {
    slot: "redraw",
    art: { light: "funding-v4", dark: "funding-dark" },
    size: [1200, 900],
    title: "Funds in. Funds out.",
    description: "Easy deposits and withdrawals, all in one place.",
  },
  {
    slot: "rewards",
    art: { light: "practice", dark: "practice-dark" },
    size: [1402, 1122],
    title: "Try it free",
    description: "A full run on the real odds. No wallet, no sign-in.",
  },
] as const;

/** An asymmetric bento, with funding and leverage as the anchors. */
export function Features() {
  return (
    <section aria-labelledby="features-title" className={styles.section} id="features">
      <div className={styles.heading}>
        <h2 id="features-title">What skech enables.</h2>
        <p>From your first free run to the ink that pays.</p>
      </div>
      <div className={styles.grid}>
        {FEATURES.map(feature => (
          <article className={`${styles.feature} ${styles[feature.slot]}`} key={feature.slot}>
            <div className={styles.caption}>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
            <div className={styles.artwork}>
              {feature.art === null ? (
                <Crowd />
              ) : (
                (["light", "dark"] as const).map(theme => (
                  <Image
                    key={theme}
                    alt=""
                    className={theme === "dark" ? styles.darkArt : styles.lightArt}
                    src={`/assets/illo/features/${feature.art[theme]}.png`}
                    width={feature.size[0]}
                    height={feature.size[1]}
                    sizes="(max-width: 767px) calc(100vw - 56px), (max-width: 1023px) 45vw, 500px"
                    quality={96}
                  />
                ))
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

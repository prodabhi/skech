import Image, { getImageProps, type StaticImageData } from "next/image";
import { cn } from "@/lib/utils";
import heroLeft from "../../../public/assets/illo/hero-left.png";
import heroLeftDark from "../../../public/assets/illo/hero-left-dark.png";
import heroRightDark from "../../../public/assets/illo/hero-right-dark.png";
import heroRight from "../../../public/assets/illo/hero-right.png";
import heroLeftWebp from "../../../public/assets/illo/hero-left.webp";
import heroLeftDarkWebp from "../../../public/assets/illo/hero-left-dark.webp";
import heroRightDarkWebp from "../../../public/assets/illo/hero-right-dark.webp";
import heroRightWebp from "../../../public/assets/illo/hero-right.webp";
import heroPhone from "../../../public/assets/illo/mobile-hero.png";
import cta from "../../../public/assets/illo/cta-scene.png";
import band from "../../../public/assets/illo/band-cast.png";
import steps from "../../../public/assets/illo/spot-steps.png";
import example from "../../../public/assets/illo/spot-example.png";
import faq from "../../../public/assets/illo/spot-faq.png";
import sceneSteps from "../../../public/assets/illo/scene-steps.png";
import sceneExample from "../../../public/assets/illo/scene-example.png";
import sceneFaq from "../../../public/assets/illo/scene-faq.png";
import sceneStepsDark from "../../../public/assets/illo/scene-steps-dark.png";
import sceneExampleDark from "../../../public/assets/illo/scene-example-dark.png";
import sceneFaqDark from "../../../public/assets/illo/scene-faq-dark.png";
import sceneStepsWebp from "../../../public/assets/illo/scene-steps.webp";
import sceneExampleWebp from "../../../public/assets/illo/scene-example.webp";
import sceneFaqWebp from "../../../public/assets/illo/scene-faq.webp";
import sceneStepsDarkWebp from "../../../public/assets/illo/scene-steps-dark.webp";
import sceneExampleDarkWebp from "../../../public/assets/illo/scene-example-dark.webp";
import sceneFaqDarkWebp from "../../../public/assets/illo/scene-faq-dark.webp";
import { IllustrationPalette } from "./illustration-palette";
import styles from "./illo.module.css";

/*
 * The illustration layer.
 *
 * Static imports give changed artwork a new content-hashed URL, including in
 * Next's image cache. Dark mode remaps the neutral inks through the shared SVG
 * filter while keeping the blue, yellow, green and red fills at full opacity.
 * These small palette PNGs bypass lossy optimisation, which otherwise adds
 * colour noise and fringes that become visible when the neutrals are remapped.
 * The hero and section scenes also come as lossless WebP, the same pixels at
 * about half the bytes (`bun run assets` makes them), with the PNG kept for a
 * browser that cannot read it.
 */
const SLOTS = {
  cta,
  band,
  steps,
  example,
  faq,
} as const;

const SECTION_SCENES = {
  steps: { light: [sceneSteps, sceneStepsWebp], dark: [sceneStepsDark, sceneStepsDarkWebp] },
  example: { light: [sceneExample, sceneExampleWebp], dark: [sceneExampleDark, sceneExampleDarkWebp] },
  faq: { light: [sceneFaq, sceneFaqWebp], dark: [sceneFaqDark, sceneFaqDarkWebp] },
} as const;

const HERO = {
  left: { light: [heroLeft, heroLeftWebp], dark: [heroLeftDark, heroLeftDarkWebp] },
  right: { light: [heroRight, heroRightWebp], dark: [heroRightDark, heroRightDarkWebp] },
} as const;

/** What a browser takes in place of art it will not show: a transparent pixel, in the page, so nothing is fetched. */
const NOTHING = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Below the flanks' breakpoint (illo.module.css), where a phone shows its own scene instead. */
const PHONE = "(max-width: 47.999rem)";

/*
 * One raw illustration: the WebP, or the PNG where WebP cannot be read.
 *
 * Lazy unless it is art the first screen opens on, and a lazy image that CSS
 * hides is never fetched: the dark art waits for dark mode. `skip` is for art
 * that is hidden at some widths but needed at once at the others, so cannot be
 * lazy: under that media query the browser takes `NOTHING` instead.
 */
function Art({
  art: [png, webp],
  className,
  first = false,
  skip,
}: {
  art: readonly [StaticImageData, StaticImageData];
  className: string;
  first?: boolean;
  skip?: string;
}) {
  const { props } = getImageProps({
    alt: "",
    fetchPriority: first ? "high" : undefined,
    loading: first ? "eager" : "lazy",
    src: png,
    unoptimized: true,
  });
  return (
    <picture className={styles.picture}>
      {skip ? <source media={skip} srcSet={NOTHING} /> : null}
      <source srcSet={webp.src} type="image/webp" />
      <img {...props} alt="" className={className} />
    </picture>
  );
}

export function SectionScene({
  name,
  className,
}: {
  name: keyof typeof SECTION_SCENES;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      {/* Recolour before browser scaling, so ink edges stay smooth at any size. */}
      <Art art={SECTION_SCENES[name].light} className={cn(styles.sectionArtwork, styles.sectionLight)} />
      <Art art={SECTION_SCENES[name].dark} className={cn(styles.sectionArtwork, styles.sectionDark)} />
    </span>
  );
}

/**
 * One character above a section heading.
 *
 * Small on purpose. These sit over a heading that is already doing the work, so
 * they are a mark rather than a scene, with a 112px slot and generous padding
 * already included in each asset.
 */
export function Spot({
  name,
  className,
}: {
  name: "steps" | "example" | "faq";
  className?: string;
}) {
  const s = SLOTS[name];
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn(
        styles.image,
        "pointer-events-none mx-auto size-28 select-none",
        className,
      )}
      sizes="112px"
      src={s}
      unoptimized
    />
  );
}

/**
 * The hero art: two flanks on a wide screen, one drawn scene on a phone.
 *
 * Each flank is weighted away from the centre and nearly empty on its inner
 * third, which is the side the headline sits on.
 *
 * Phones get their own asset rather than a scaled-up flank. The flank is a
 * half-composition cropped for the edge of a wide page, so filling a phone
 * with it meant blowing it up to 24rem and sliding it off centre — the
 * characters came out enormous and the half that was designed to sit under
 * the headline was the half on screen. `mobile-hero.png` is the whole cast at
 * a size a phone can hold.
 *
 * Both are in the markup and CSS picks one, rather than branching on a media
 * query in JavaScript: the art is above the fold, and a layout that waits for
 * hydration to decide what to paint shows the wrong one first. Each is in a
 * <picture> that hands the other widths a blank, so a phone never downloads
 * the flanks and a wide screen never downloads the phone's scene.
 */
export function HeroScene() {
  const { props: phone } = getImageProps({ alt: "", fetchPriority: "high", loading: "eager", quality: 96, sizes: "20rem", src: heroPhone });
  return (
    <div aria-hidden="true" className={styles.scene}>
      <IllustrationPalette />
      <Flank side="left" />
      <Flank side="right" />
      {/*
        The one illustration here that is optimised rather than served raw.
        The others are small palette PNGs where Next's lossy pass adds fringes
        that the dark-mode remap then amplifies; this one is a 1402px asset
        drawn at 320px, and `unoptimized` means no srcset, so the browser was
        doing the whole 2.19x reduction itself in one step and softening the
        edges. Sharp resamples it once, properly, at each width in the srcset.
        `quality` is up at 96 because the art is flat colour with hard edges,
        which is exactly what a default-quality encode smears.
      */}
      <picture className={styles.picture}>
        <source media="(min-width: 48rem)" srcSet={NOTHING} />
        <img {...phone} alt="" className={cn(styles.image, styles.legacyImage, styles.phoneArt)} />
      </picture>
    </div>
  );
}

function Flank({ side }: { side: "left" | "right" }) {
  return (
    <span className={cn(styles.flank, side === "left" ? styles.left : styles.right)}>
      <Art art={HERO[side].light} className={cn(styles.sectionArtwork, styles.sectionLight)} first skip={PHONE} />
      <Art art={HERO[side].dark} className={cn(styles.sectionArtwork, styles.sectionDark)} />
      <span className={cn(styles.accent, styles.accentSquare)} />
      <span className={cn(styles.accent, styles.accentDot)} />
      <span className={cn(styles.accent, styles.accentDash)} />
    </span>
  );
}

/**
 * The whole cast, as a break between movements.
 *
 * It sits between the last walkthrough and the questions, which was the longest
 * unbroken run of dark panels on the page. Purely a breath: nothing here is
 * information.
 */
export function BandScene({ className }: { className?: string }) {
  return (
    <div className={cn("container-x px-4 sm:px-6 lg:px-8", className)}>
      <Image
        alt=""
        aria-hidden="true"
        className={cn(
          styles.image,
          styles.legacyImage,
          "pointer-events-none mx-auto h-auto w-full max-w-[34rem] select-none",
        )}
        sizes="(max-width: 576px) 90vw, 544px"
        src={SLOTS.band}
        unoptimized
      />
    </div>
  );
}

/** The closing band scene, beside the way into the app. */
export function CtaScene({ className }: { className?: string }) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn(
        styles.image,
        styles.legacyImage,
        "pointer-events-none select-none",
        className,
      )}
      sizes="(max-width: 448px) 85vw, 384px"
      src={SLOTS.cta}
      unoptimized
    />
  );
}

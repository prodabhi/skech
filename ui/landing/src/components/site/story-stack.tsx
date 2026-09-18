"use client";

import { type ReactNode, useEffect, useRef } from "react";
import styles from "./story.module.css";

/** Natural-height chapters stack and gently recede as the next one arrives. */
export function StoryStack({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-story-section]"));
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const update = () => {
      frame = 0;
      const enabled = !motion.matches && innerWidth >= 1024;
      sections.forEach((section, index) => {
        const card = section.querySelector<HTMLElement>("[data-story-card]");
        if (!card) return;
        // Tall cards stay in normal flow so every control remains reachable.
        const pinned = enabled && section.offsetHeight < innerHeight - 48;
        section.dataset.pinned = String(pinned);
        const next = sections[index + 1];
        const progress = pinned && next
          ? Math.min(1, Math.max(0, (innerHeight - next.getBoundingClientRect().top) / (innerHeight - 24)))
          : 0;
        card.style.setProperty("--recede", String(progress));
        card.inert = progress >= 0.99;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    sections.forEach(section => observer.observe(section));
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    motion.addEventListener("change", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      motion.removeEventListener("change", schedule);
      sections.forEach(section => {
        delete section.dataset.pinned;
        const card = section.querySelector<HTMLElement>("[data-story-card]");
        if (card) { card.inert = false; card.style.removeProperty("--recede"); }
      });
    };
  }, []);

  return <div className={styles.stack} ref={root}>{children}</div>;
}

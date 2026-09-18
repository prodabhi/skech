"use client";

import { type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A panel whose edge lights up in colour under the cursor.
 *
 * The mechanic is cult-ui's feature-carousel card: a ::before sitting 1px
 * outside the panel, filled with a radial gradient centred on the pointer, with
 * the panel's own opaque fill covering all of it but the edge. Theirs is a dark
 * card ringed in lime and pink; the stops here are the page's blue plus a
 * violet and a warm peach, which is as much colour as a white ground takes
 * before it reads as a toy.
 *
 * `glow="always"` holds the ring on without a pointer, for the one card that
 * has to carry colour whether or not anybody hovers it.
 */
export function GradientCard({
  children,
  className,
  id,
  glow = "hover",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  glow?: "hover" | "always";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tracked, setTracked] = useState(false);

  return (
    <div
      className={cn(
        "gcard rounded-3xl",
        glow === "always" && "gcard-on",
        // Until the pointer has been somewhere, --x/--y are unset and the
        // gradient would centre on the top-left corner. Held off until then.
        tracked && "gcard-tracked",
        className,
      )}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        const el = ref.current;
        if (!el) {
          return;
        }
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--x", `${event.clientX - rect.left}px`);
        el.style.setProperty("--y", `${event.clientY - rect.top}px`);
        setTracked(true);
      }}
      id={id}
      ref={ref}
    >
      {children}
    </div>
  );
}

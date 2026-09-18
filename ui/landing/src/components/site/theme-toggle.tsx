"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";

const KEY = "theme";

function resolved(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Private windows and blocked storage both throw here.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Light and dark, one button.
 *
 * The class is set by an inline script in the document head, so the right
 * theme is painted before anything else is. This only reads it back and flips
 * it; see app/layout.tsx.
 *
 * The `useLayoutEffect` is not redundant. React's Strict Mode remounts once in
 * development and resets `<html>` to the attributes it manages from JSX, which
 * wipes the class the script set. Re-applying it before paint makes the dev
 * page agree with the stored preference. It is a no-op in production.
 */
export function ThemeToggle() {
  // No React state. The class on <html> is the single source of truth and the
  // icons read it through `dark:` variants, so mirroring it into state would
  // just be a second copy to keep in sync.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", resolved() === "dark");
  }, []);

  const flip = () => {
    const root = document.documentElement;
    const next = root.classList.contains("dark") ? "light" : "dark";
    root.classList.toggle("dark", next === "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#121110" : "#ffffff");
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A preference that cannot be saved still applies for this visit.
    }
  };

  return (
    <Button
      aria-label="Toggle theme"
      className="relative size-9 rounded-full sm:size-9"
      onClick={flip}
      size="icon"
      variant="ghost"
    >
      <SunIcon className="size-[1.1rem] rotate-0 scale-100 transition-transform duration-medium ease-out-expo dark:-rotate-90 dark:scale-0" />
      <MoonIcon className="absolute size-[1.1rem] rotate-90 scale-0 transition-transform duration-medium ease-out-expo dark:rotate-0 dark:scale-100" />
    </Button>
  );
}

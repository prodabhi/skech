"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

/** The class on `<html>` is the source of truth, so the toggle keeps no state of its own. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribe, isDark, () => false);
}

/** Flip the theme and remember it. */
export function setDark(next: boolean) {
  document.documentElement.classList.toggle("dark", next);
  try {
    localStorage.setItem("theme", next ? "dark" : "light");
  } catch {
    // Private mode. The class still flips for this page.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const dark = useDark();
  const words = dark ? "Switch to light" : "Switch to dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={words}
            className={className}
            onClick={() => setDark(!dark)}
            size="icon"
            variant="outline"
          />
        }
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipPopup>{words}</TooltipPopup>
    </Tooltip>
  );
}

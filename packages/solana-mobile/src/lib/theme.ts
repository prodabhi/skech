import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { Uniwind } from "uniwind";
import { storage } from "./storage";

/**
 * Light or dark, as on the web: the phone's own setting until the reader picks one in Settings, then theirs,
 * remembered. Uniwind switches every className; the stage reads `useDark` for its own colours.
 */
const KEY = "theme";
const listeners = new Set<() => void>();
const saved = () => storage.getString(KEY) as "light" | "dark" | undefined;
const current = () => (saved() ?? Appearance.getColorScheme() ?? "light") === "dark";

export function initTheme() {
  const s = saved();
  Uniwind.setTheme(s ?? "system");
  Appearance.addChangeListener(() => listeners.forEach((l) => l()));
}

export function setDark(next: boolean) {
  storage.set(KEY, next ? "dark" : "light");
  Uniwind.setTheme(next ? "dark" : "light");
  listeners.forEach((l) => l());
}

export function useDark(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    current,
    () => false,
  );
}

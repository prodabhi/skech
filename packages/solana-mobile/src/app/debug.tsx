import { Redirect, useLocalSearchParams } from "expo-router";
import { traceFeel } from "@/lib/feel";

/**
 * Switches on what a release build keeps quiet, then goes straight back to the game.
 * skech://debug?feel=1 logs how long each hit takes from the judge to its sound (lib/feel.ts), as "[skech:feel]"
 * lines under logcat's ReactNativeJS tag; skech://debug?feel=0 stops it. It only ever logs: nothing else changes.
 */
export default function Debug() {
  const { feel } = useLocalSearchParams<{ feel?: string }>();
  if (feel === "1" || feel === "0") traceFeel(feel === "1");
  return <Redirect href="/" />;
}

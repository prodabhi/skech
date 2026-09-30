import { Redirect } from "expo-router";
import { AppBar } from "@/components/app/app-bar";
import { InkIntro } from "@/components/app/ink/ink-intro";
import { InkScreen } from "@/components/app/ink/ink-screen";
import { PREVIEW } from "./dev-preview";

/** The page around the game: the bar over the game, held to the screen so a finger drawing never drags it, and the way in over both. */
export default function Home() {
  if (__DEV__ && PREVIEW) return <Redirect href={`/preview?sheet=${PREVIEW}`} />;
  return (
    <>
      <InkScreen />
      <AppBar />
      <InkIntro />
    </>
  );
}

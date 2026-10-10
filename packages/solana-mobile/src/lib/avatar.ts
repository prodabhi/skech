import { Avatar, Style } from "@dicebear/core";
import dylan from "@dicebear/styles/dylan.json";
import { avatarSeedOf, type PlayerProfile, uploadedAvatarUrl } from "@skech/core/social";
import { SOCIAL_URL } from "./social";

/**
 * Everyone's face: a "Dylan" avatar (DiceBear), seeded by the one they chose or by their address, as on the web
 * (ui/app/src/lib/avatar.ts): the same seed draws the same face on both. Made once per seed, as SVG text for
 * react-native-svg's SvgXml (and Skia's SVG on the chart), and kept.
 */
let style: Style<unknown> | null = null;
const made = new Map<string, string>();

/** The Dylan avatar for a seed, as SVG markup: made once, then from memory. Its metadata and comment are left out. */
export function dylanXml(seed: string): string {
  let xml = made.get(seed);
  if (xml) return xml;
  style ??= new Style(dylan);
  xml = new Avatar(style, { seed })
    .toString()
    .replace(/<metadata>[\s\S]*?<\/metadata>/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  if (made.size >= 1000) made.delete(made.keys().next().value!);
  made.set(seed, xml);
  return xml;
}

/** A player's face: their uploaded picture's address, or null for their Dylan avatar. */
export const pictureOf = (profile: Pick<PlayerProfile, "player" | "avatar">) => (profile.avatar ? uploadedAvatarUrl(SOCIAL_URL, profile.player) : null);
export { avatarSeedOf };

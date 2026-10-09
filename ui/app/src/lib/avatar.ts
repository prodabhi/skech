import { Avatar, Style } from "@dicebear/core";
import dylan from "@dicebear/styles/dylan.json" with { type: "json" };
import { avatarSeedOf, type PlayerProfile, uploadedAvatarUrl } from "@skech/core/social";
import { SOCIAL_URL } from "./endpoints";

/**
 * Everyone's face: a "Dylan" avatar (DiceBear), seeded by the one they chose or by their address, or a picture
 * they uploaded. Made once per seed, as an SVG data URI (img-src data: in the page's policy), and kept.
 */
export { avatarChoices } from "@skech/core/social";

let style: Style<unknown> | null = null;
const made = new Map<string, string>();

/** The Dylan avatar for a seed, as a data URI: made once, then from memory (at most a few thousand kept). */
export function dylanUri(seed: string): string {
  let uri = made.get(seed);
  if (uri) return uri;
  style ??= new Style(dylan);
  uri = new Avatar(style, { seed }).toDataUri();
  if (made.size >= 2000) made.delete(made.keys().next().value!);
  made.set(seed, uri);
  return uri;
}

/** A player's face: their uploaded picture, else their Dylan avatar. */
export const faceOf = (profile: Pick<PlayerProfile, "player" | "avatar" | "avatarSeed">) => (profile.avatar ? uploadedAvatarUrl(SOCIAL_URL, profile.player) : dylanUri(avatarSeedOf(profile)));

import { memo, useMemo, useState } from "react";
import { Image, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { avatarSeedOf, type PlayerProfile } from "@skech/core/social";
import { UserIcon } from "@/components/ui/icons";
import { useColors } from "@/components/ui";
import { dylanXml, pictureOf } from "@/lib/avatar";

type Face = Pick<PlayerProfile, "player" | "avatar" | "avatarSeed">;

/** A Dylan avatar for a seed, round: its SVG made once per seed (lib/avatar.ts). */
export const Dylan = memo(function Dylan({ seed, size }: { seed: string; size: number }) {
  const xml = useMemo(() => dylanXml(seed), [seed]);
  return (
    <View className="overflow-hidden bg-muted" style={{ width: size, height: size, borderRadius: size / 2 }}>
      <SvgXml height={size} width={size} xml={xml} />
    </View>
  );
});

/** A player's face: the picture they uploaded, or their Dylan avatar (chosen, else their address's). As on the web. */
export function PlayerAvatar({ profile, size = 40 }: { profile: Face; size?: number }) {
  const [failed, setFailed] = useState(false);
  const picture = pictureOf(profile);
  if (picture && !failed) return <Image accessibilityIgnoresInvertColors onError={() => setFailed(true)} source={{ uri: picture }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  return <Dylan seed={avatarSeedOf(profile)} size={size} />;
}

/** The account's face: theirs once the address is known; before that, a plain one. */
export function AccountAvatar({ address, profile, size }: { address: string | null; profile?: Face | null; size: number }) {
  const c = useColors();
  if (!address)
    return (
      <View className="items-center justify-center bg-secondary" style={{ width: size, height: size, borderRadius: size / 2 }}>
        <UserIcon color={c.muted} size={size * 0.5} />
      </View>
    );
  return <PlayerAvatar profile={profile ?? { player: address, avatar: false, avatarSeed: null }} size={size} />;
}

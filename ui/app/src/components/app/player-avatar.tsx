"use client";

import { UserIcon } from "lucide-react";
import { useMemo } from "react";
import { avatarSeedOf, type PlayerProfile } from "@skech/core/social";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { dylanUri, faceOf } from "@/lib/avatar";
import { cn } from "@/lib/utils";

type Face = Pick<PlayerProfile, "player" | "avatar" | "avatarSeed">;

/**
 * A player's face: the picture they uploaded, or their Dylan avatar (the one they chose, else their address's).
 * A picture that does not load falls back to the Dylan avatar.
 */
export function PlayerAvatar({ profile, className }: { profile: Face; className?: string }) {
  const seed = avatarSeedOf(profile);
  const src = useMemo(() => faceOf({ player: profile.player, avatar: profile.avatar, avatarSeed: seed === profile.player ? null : seed }), [profile.player, profile.avatar, seed]);
  const dylan = useMemo(() => dylanUri(seed), [seed]);
  return (
    <Avatar className={cn("size-10 bg-muted ring-1 ring-foreground/5", className)}>
      <AvatarImage alt="" src={src} />
      <AvatarFallback className="bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI, nothing for next/image to do */}
        <img alt="" className="size-full" src={dylan} />
      </AvatarFallback>
    </Avatar>
  );
}

/** The account's face: theirs once their address is known; before that, or signed out, a plain one. */
export function AccountAvatar({ address, profile, className }: { address: string | null; profile?: Face | null; className?: string }) {
  if (!address)
    return (
      <Avatar className={cn("size-7 bg-secondary", className)}>
        <AvatarFallback className="bg-secondary">
          <UserIcon className="size-4 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
    );
  return <PlayerAvatar className={className} profile={profile ?? { player: address, avatar: false, avatarSeed: null }} />;
}

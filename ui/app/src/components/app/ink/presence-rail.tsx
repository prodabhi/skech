"use client";

import { playerHue, playerName, type PlayerProfile } from "@skech/core/social";
import { focusPlayer, useFocusedPlayer, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "@/components/app/player-avatar";
import styles from "./presence-rail.module.css";

/**
 * Who is drawing, over the chart rather than in a drawer that covered it. Each face is ringed in that player's
 * `playerHue`, the hue the canvas paints their ink with, so the ring and the line are the same person.
 */

const MOST = 8;

export function PresenceRail({ className }: { className?: string }) {
  const { playing, connected } = useSocial();
  const focused = useFocusedPlayer();
  if (!connected || !playing.length) return null;
  const shown = playing.slice(0, MOST);
  const more = playing.length - shown.length;
  return (
    <div className={cn(styles.rail, className)}>
      <span className={styles.count}>
        <span className={styles.pulse} />
        <strong className="figures">{playing.length}</strong> drawing
      </span>
      <div className={styles.faces}>
        {shown.map((p) => (
          <Face focused={focused} key={p.player} profile={p} />
        ))}
        {more > 0 ? <span className={styles.more}>+{more}</span> : null}
      </div>
      {focused ? (
        <button className={styles.release} onClick={() => focusPlayer(null)} type="button">
          Show everyone
        </button>
      ) : null}
    </div>
  );
}

function Face({ profile, focused }: { profile: PlayerProfile; focused: string | null }) {
  const mine = focused === profile.player;
  const dimmed = focused !== null && !mine;
  return (
    <button
      aria-label={`${mine ? "Stop following" : "Follow"} ${playerName(profile)}'s line`}
      aria-pressed={mine}
      className={cn(styles.face, dimmed && styles.dimmed)}
      onClick={() => focusPlayer(profile.player)}
      style={{ "--hue": playerHue(profile.player) } as React.CSSProperties}
      title={playerName(profile)}
      type="button"
    >
      <PlayerAvatar className={styles.avatar} profile={profile} />
    </button>
  );
}

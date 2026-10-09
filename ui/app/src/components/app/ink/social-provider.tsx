"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { looksLikePlayer, playerName, type PlayerProfile } from "@skech/core/social";
import { useAccount } from "@/components/app/auth";
import { toastManager } from "@/components/ui/toast";
import { bindPen, cacheProfile, connectSocial, onSocialActivity, setDrawingAudience, setSocialViewer, socialRequest, type DrawingAudience } from "@/lib/social";

/**
 * The community around the game: one live stream for the page, who the player follows, and the sheet with the
 * leaderboard, the live feed and profiles, opened from the bar, from an avatar on the chart, or from a shared link
 * (/fun?player=… or ?drawing=…). The sheet's code comes only when it is first opened.
 */

const SocialSheet = dynamic(() => import("./social-sheet").then((m) => m.SocialSheet), { ssr: false });
export type SocialTab = "leaderboard" | "activity" | "profile";
type SocialContext = { open: (tab?: SocialTab, player?: string) => void; audience: DrawingAudience; changeAudience: (value: DrawingAudience) => void; refreshFollowing: () => void };
const noFollowing: string[] = [];
const Context = createContext<SocialContext | null>(null);
export const useCommunity = () => useContext(Context);

export function SocialProvider({ children }: { children: ReactNode }) {
  const notified = useRef(new Set<string>());
  const me = useAccount();
  const player = me.address;
  const [panel, setPanel] = useState<{ tab: SocialTab; player?: string; drawing?: string } | null>(null);
  const [audience, setAudience] = useState<DrawingAudience>("everyone");
  const [followed, setFollowed] = useState<{ player: string; targets: string[] } | null>(null);
  const following = followed?.player === player ? followed.targets : noFollowing;
  const [version, refresh] = useState(0);
  const open = useCallback((tab: SocialTab = "leaderboard", target?: string) => setPanel({ tab, player: target }), []);
  useEffect(() => connectSocial(), []);
  // Others see this player's pen as it draws, once their wallet has said so (silently, with Privy).
  const sign = me.signMessage;
  const test = me.handle === "Test player" && process.env.NODE_ENV !== "production";
  useEffect(() => bindPen(player, player ? sign : null, test), [player, sign, test]);
  useEffect(() => {
    if (!player) {
      setSocialViewer(null, []);
      return;
    }
    const controller = new AbortController();
    setSocialViewer(player, []);
    void socialRequest<{ profile: PlayerProfile }>(`/identity?player=${player}`, undefined, controller.signal).then((r) => cacheProfile(r.profile), () => undefined);
    void socialRequest<{ players: string[] }>(`/following?player=${player}`, undefined, controller.signal).then(
      (r) => {
        setFollowed({ player, targets: r.players });
        setSocialViewer(player, r.players);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [player, version]);
  useEffect(() => {
    const profile = (e: Event) => open("profile", (e as CustomEvent<string>).detail);
    const drawing = (e: Event) => setPanel({ tab: "activity", drawing: (e as CustomEvent<string>).detail });
    window.addEventListener("skech:profile", profile);
    window.addEventListener("skech:drawing", drawing);
    const query = new URLSearchParams(window.location.search);
    const target = query.get("player"), id = query.get("drawing");
    // After hydration, so the page first renders as the server made it.
    const frame = requestAnimationFrame(() => {
      if (id && /^[1-9A-HJ-NP-Za-km-z]{32,44}:\d{1,20}$/.test(id)) setPanel({ tab: "activity", drawing: id });
      else if (looksLikePlayer(target)) open("profile", target);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("skech:profile", profile);
      window.removeEventListener("skech:drawing", drawing);
    };
  }, [open]);
  // A drawing finished by someone followed: said once, unless alerts are off.
  useEffect(
    () =>
      onSocialActivity((activity) => {
        if (!following.includes(activity.player) || activity.kind !== "settled" || !activity.complete) return;
        try {
          if (localStorage.getItem("skech:social:alerts") === "off") return;
        } catch {}
        if (notified.current.has(activity.drawing)) return;
        notified.current.add(activity.drawing);
        if (notified.current.size > 500) notified.current.delete(notified.current.values().next().value!);
        toastManager.add({ title: `${playerName(activity.profile)} finished a drawing`, description: "See how it went in Live.", timeout: 4000 });
      }),
    [following],
  );
  const value = useMemo<SocialContext>(
    () => ({
      open,
      audience,
      changeAudience(next) {
        setAudience(next);
        setDrawingAudience(next);
      },
      refreshFollowing() {
        refresh((v) => v + 1);
      },
    }),
    [open, audience],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {panel ? <SocialSheet initialDrawing={panel.drawing} initialPlayer={panel.player} initialTab={panel.tab} onClose={() => setPanel(null)} /> : null}
    </Context.Provider>
  );
}

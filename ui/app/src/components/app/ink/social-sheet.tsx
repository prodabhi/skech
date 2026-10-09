"use client";

import { ArrowLeftIcon, CheckIcon, RadioIcon, Share2Icon, ShuffleIcon, TrophyIcon, UserIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { activityRuns, BIO_MAX, playerName, usernameProblem, type LeaderboardRow, type PlayerProfile, type ProfileResponse, type PublicDrawing, type SocialActivity, type SocialWindow } from "@skech/core/social";
import { useAccount } from "@/components/app/auth";
import { PlayerAvatar } from "@/components/app/player-avatar";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { explorerTx } from "@/lib/chain";
import { avatarChoices, dylanUri } from "@/lib/avatar";
import { avatarFrom, cacheProfile, socialAction, socialMoney, socialRequest, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { useGate } from "./gate";
import { type SocialTab, useCommunity } from "./social-provider";

/**
 * The community: the leaderboard by window, the live feed, and a player's page with their numbers, their drawings,
 * and Follow. From the right on a computer; from the bottom on a tablet held upright.
 */

const tabletPortrait = "(min-width: 640px) and (max-width: 1023px) and (orientation: portrait)";
const subscribeTablet = (callback: () => void) => {
  const media = matchMedia(tabletPortrait);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

const windows: { value: SocialWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All time" },
];
const quietCard = "rounded-[18px] bg-muted";

/** Who is playing now: their faces in a row, each a way to their profile. */
export function SocialSheet({ initialTab, initialPlayer, initialDrawing, onClose }: { initialTab: SocialTab; initialPlayer?: string; initialDrawing?: string; onClose: () => void }) {
  const tablet = useSyncExternalStore(subscribeTablet, () => matchMedia(tabletPortrait).matches, () => false);
  const me = useAccount();
  const social = useSocial();
  const gate = useGate();
  const viewer = me.address ?? "";
  const [tab, setTab] = useState<SocialTab>(initialTab);
  const [player, setPlayer] = useState<string | null>(initialPlayer ?? me.address ?? null);
  const [drawing, setDrawing] = useState<string | null>(initialDrawing ?? null);
  const [window, setWindow] = useState<SocialWindow>("all");
  const [friends, setFriends] = useState(false);
  const feed = useMemo(() => activityRuns(social.activity), [social.activity]);
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; counting: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(() => {
    try {
      return localStorage.getItem("skech:social:alerts") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (tab !== "leaderboard" || drawing) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await socialRequest<NonNullable<typeof board>>(`/leaderboard?window=${window}${viewer ? `&viewer=${viewer}` : ""}&friends=${friends ? "1" : "0"}`, undefined, controller.signal);
        if (!controller.signal.aborted) {
          setBoard(result);
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) setError("Could not load the board.");
      } finally {
        pending = false;
      }
    };
    void load();
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [tab, window, viewer, friends, drawing]);
  const viewPlayer = (target: string) => {
    setPlayer(target);
    setDrawing(null);
    setTab("profile");
  };
  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open>
      <SheetPopup className={cn("rounded-t-3xl motion-reduce:transition-none sm:rounded-2xl", tablet ? "mx-auto max-h-[85dvh] max-w-xl" : "sm:max-w-md")} closeProps={{ className: "absolute end-2 top-2 min-h-11 min-w-11" }} side={tablet ? "bottom" : "right"} variant="inset">
        <SheetHeader className="px-5 pt-6 sm:px-6 sm:pt-8">
          <SheetTitle className="font-bold text-xl">{drawing ? "The drawing" : tab === "profile" ? (player === viewer ? "Your profile" : "Player") : "Players"}</SheetTitle>
          <SheetDescription className="sr-only">{drawing ? "One drawing, piece by piece." : "Who is here and what they drew."}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4 px-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
          {drawing ? (
            <DrawingDetail id={drawing} onBack={() => setDrawing(null)} onPlayer={viewPlayer} />
          ) : (
            <>
              <div aria-label="Community" className="flex rounded-full bg-muted p-1" role="group">
                {(
                  [
                    { value: "leaderboard", label: "Leaderboard", icon: TrophyIcon },
                    { value: "activity", label: "Live", icon: RadioIcon },
                    { value: "profile", label: "Profile", icon: UserIcon },
                  ] as const
                ).map((item) => (
                  <button
                    aria-pressed={tab === item.value}
                    className={cn("flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full font-semibold text-[13px] transition-colors", tab === item.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                    key={item.value}
                    onClick={() => {
                      setTab(item.value);
                      if (item.value === "profile") setPlayer(viewer || null);
                    }}
                    type="button"
                  >
                    <item.icon className="size-3.5" />
                    {item.label}
                  </button>
                ))}
              </div>
              {tab !== "activity" ? (
                <div aria-label="Time period" className="flex gap-1.5" role="group">
                  {windows.map((item) => (
                    <button aria-pressed={window === item.value} className={cn("min-h-11 flex-1 rounded-full font-medium text-[13px] transition-colors", window === item.value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted")} key={item.value} onClick={() => setWindow(item.value)} type="button">
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {tab === "leaderboard" ? (
                <>
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[13px] text-muted-foreground">Ranked by net PnL</span>
                    <button aria-pressed={friends} className="flex min-h-11 items-center gap-1.5 font-medium text-[13px]" onClick={() => (viewer ? setFriends((v) => !v) : gate.openSignIn("community"))} type="button">
                      <UsersIcon className="size-3.5" />
                      {friends ? "Following" : "Everyone"}
                    </button>
                  </div>
                  {board?.counting || social.counting ? <p className="text-[13px] text-muted-foreground">Still reading older drawings.</p> : null}
                  {error ? (
                    <Notice text={error} />
                  ) : !board ? (
                    <LoadingRows />
                  ) : !board.rows.length ? (
                    <Empty text={friends ? "You follow nobody yet." : "No drawings yet."} />
                  ) : (
                    <div className={cn(quietCard, "divide-y divide-border overflow-hidden")}>
                      {board.rows.map((row) => (
                        <LeaderRow key={row.profile.player} me={viewer === row.profile.player} onClick={() => viewPlayer(row.profile.player)} row={row} />
                      ))}
                    </div>
                  )}
                  {board?.me && !board.rows.some((row) => row.profile.player === viewer) ? (
                    <div className={quietCard}>
                      <LeaderRow me onClick={() => viewPlayer(viewer)} row={board.me} />
                    </div>
                  ) : null}
                  <p className="px-1 text-muted-foreground text-xs">Ink still in play is not counted.</p>
                </>
              ) : tab === "activity" ? (
                <>
                  {feed.length ? (
                    <div className="flex flex-col gap-2">
                      {feed.map((run) => (
                        <LiveRow drawings={social.drawings} key={run[0].drawing} onOpen={setDrawing} onPlayer={() => viewPlayer(run[0].player)} run={run} />
                      ))}
                    </div>
                  ) : (
                    <Empty text={social.connected ? "Nobody is drawing." : "Reconnecting…"} />
                  )}
                  <div className="flex min-h-11 items-center justify-between px-1 text-[13px] sm:hidden">
                    <span>Appearance</span>
                    <ThemeToggle className="size-11 rounded-full" />
                  </div>
                  <label className="flex min-h-11 items-center justify-between gap-3 px-1 text-[13px]">
                    Tell me when someone I follow finishes
                    <input
                      checked={alerts}
                      className="size-5 accent-brand"
                      onChange={(e) => {
                        setAlerts(e.target.checked);
                        try {
                          localStorage.setItem("skech:social:alerts", e.target.checked ? "on" : "off");
                        } catch {}
                      }}
                      type="checkbox"
                    />
                  </label>
                </>
              ) : player ? (
                <ProfileView key={`${player}:${window}`} onDrawing={setDrawing} player={player} window={window} />
              ) : (
                <div className="flex flex-col items-start gap-3 rounded-[18px] bg-muted p-4">
                  <p className="text-muted-foreground text-sm">Sign in to make your profile and keep your drawing history.</p>
                  <Button className="rounded-full" onClick={() => gate.openSignIn("community")}>
                    Sign in
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

const when = (at: number) => (Date.now() - at < 86_400_000 ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" }));

/** A player's run in the feed: their latest line, how many it was, and where the run stands. */
function LiveRow({ run, drawings, onOpen, onPlayer }: { run: SocialActivity[]; drawings: PublicDrawing[]; onOpen: (id: string) => void; onPlayer: () => void }) {
  const head = run[0];
  const net = run.reduce((sum, item) => sum + (item.kind === "settled" ? BigInt(item.amount) : 0n), 0n);
  const open = run.filter((item) => !item.complete).length;
  const drawing = drawings.find((d) => d.id === head.drawing);
  // Only a real line is worth showing. DrawingPreview falls back to bands, which on a two-second drawing is a block.
  const line = drawing?.pieces.some((piece) => (piece.stroke?.pts.length ?? 0) > 1) ? drawing : null;
  return (
    <div className={cn(quietCard, "flex items-center gap-3 px-3 py-2")}>
      <button aria-label={`Open ${playerName(head.profile)}'s profile`} className="shrink-0" onClick={onPlayer} type="button">
        <PlayerAvatar className="size-9" profile={head.profile} />
      </button>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(head.drawing)} type="button">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="truncate font-medium text-sm">{playerName(head.profile)}</strong>
          <span className="text-muted-foreground text-xs">
            {run.length > 1 ? `${run.length} lines` : open ? "Still going" : "Done"} · {when(head.at)}
          </span>
        </span>
        {line ? <DrawingPreview className="h-7 w-14 shrink-0 text-brand" drawing={line} /> : null}
        <span className={cn("figures shrink-0 font-semibold text-sm", net > 0n && "text-success-foreground")}>{net === 0n && open ? "" : socialMoney(net.toString(), true)}</span>
      </button>
    </div>
  );
}

function LeaderRow({ row, me, onClick }: { row: LeaderboardRow; me: boolean; onClick: () => void }) {
  return (
    <button className={cn("flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-foreground/5", me && "bg-brand/5")} onClick={onClick} type="button">
      <span className="figures w-5 text-center text-[13px] text-muted-foreground">{row.rank}</span>
      <PlayerAvatar className="size-9" profile={row.profile} />
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate font-medium text-sm">
          {playerName(row.profile)}
          {me ? <span className="ml-1 text-muted-foreground text-xs">you</span> : null}
        </strong>
        <span className="text-muted-foreground text-xs">{row.stats.completed} finished drawings</span>
      </span>
      <span className={cn("figures font-semibold text-sm", BigInt(row.stats.pnl) > 0n && "text-success-foreground")}>{socialMoney(row.stats.pnl, true)}</span>
    </button>
  );
}

function ProfileView({ player, window, onDrawing }: { player: string; window: SocialWindow; onDrawing: (id: string) => void }) {
  const me = useAccount(), community = useCommunity(), gate = useGate();
  const viewer = me.address ?? "", own = viewer === player;
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    void socialRequest<ProfileResponse>(`/profile?player=${player}${viewer ? `&viewer=${viewer}` : ""}&window=${window}`, undefined, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setData(result);
      },
      () => {
        if (!controller.signal.aborted) setError("Could not load this profile.");
      },
    );
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [player, viewer, window]);
  const follow = async () => {
    if (!viewer) return gate.openSignIn("community");
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await socialAction(viewer, "follow", { target: player, enabled: !data.following }, me.signMessage);
      if (mounted.current) setData({ ...data, following: !data.following, profile: { ...data.profile, followers: data.profile.followers + (data.following ? -1 : 1) } });
      community?.refreshFollowing();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const more = async () => {
    if (!data?.next || busy) return;
    setBusy(true);
    try {
      const next = await socialRequest<ProfileResponse>(`/profile?player=${player}${viewer ? `&viewer=${viewer}` : ""}&window=${window}&cursor=${encodeURIComponent(data.next)}`);
      if (mounted.current) setData({ ...data, drawings: [...data.drawings, ...next.drawings], next: next.next });
    } catch {
      if (mounted.current) setError("Could not load earlier drawings");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!data) return error ? <Notice text={error} /> : <LoadingRows />;
  if (editing)
    return (
      <EditProfile
        onCancel={() => setEditing(false)}
        onSaved={(profile) => {
          // Everywhere at once: the bar's face, the feed, the board.
          cacheProfile(profile);
          setData({ ...data, profile });
          setEditing(false);
        }}
        profile={data.profile}
      />
    );
  return (
    <>
      <div className="flex items-center gap-3">
        <PlayerAvatar className="size-14 text-lg" profile={data.profile} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-lg">{playerName(data.profile)}</h3>
          <p className="text-muted-foreground text-xs">{data.profile.joinedAt ? `Drawing since ${new Date(data.profile.joinedAt).toLocaleDateString([], { month: "short", year: "numeric" })}` : "A fresh page"}</p>
        </div>
        {own ? (
          <Button className="rounded-full" onClick={() => setEditing(true)} size="sm" variant="secondary">
            Edit
          </Button>
        ) : (
          <Button className="rounded-full" disabled={busy} onClick={() => void follow()} size="sm" variant={data.following ? "secondary" : "default"}>
            {data.following ? "Following" : "Follow"}
          </Button>
        )}
      </div>
      {data.profile.bio ? <p className="whitespace-pre-line text-muted-foreground text-sm leading-relaxed">{data.profile.bio}</p> : null}
      <div className="flex items-center gap-4 text-muted-foreground text-xs">
        <span>
          <strong className="figures text-foreground">{data.profile.followers}</strong> followers
        </span>
        <span>
          <strong className="figures text-foreground">{data.profile.following}</strong> following
        </span>
        <ShareButton player={player} />
      </div>
      {error ? <Notice text={error} /> : null}
      <div className={cn(quietCard, "px-4 pt-4 pb-3")}>
        <span className="text-[13px] text-muted-foreground">Net PnL</span>
        <div className={cn("figures mt-1 font-bold text-[38px] leading-none tracking-[-.02em]", BigInt(data.stats.pnl) > 0n && "text-success-foreground")}>{socialMoney(data.stats.pnl, true)}</div>
        <PnlChart points={data.curve} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Total staked" value={socialMoney(data.stats.staked)} />
        <Stat label="Win rate" value={data.stats.completed ? `${Math.round((data.stats.wins / data.stats.completed) * 100)}%` : "—"} />
        <Stat label="Finished drawings" value={String(data.stats.completed)} />
        <Stat label="Biggest profit" value={socialMoney(data.stats.biggest, true)} />
      </div>
      {BigInt(data.stats.owed) > 0n ? (
        <p className="px-1 text-muted-foreground text-xs">
          Includes {socialMoney(data.stats.owed)} earned as IOUs. Paid at settlement: {socialMoney(data.stats.paid)}.
        </p>
      ) : null}
      {data.badges.length ? (
        <div className="flex flex-wrap gap-1.5">
          {data.badges.map((badge) => (
            <span className="rounded-full bg-brand/10 px-2.5 py-1 font-medium text-brand text-xs" key={badge}>
              {badge}
            </span>
          ))}
        </div>
      ) : null}
      <span className="px-1 text-[13px] text-muted-foreground">Drawings</span>
      {data.drawings.length ? (
        <div className={cn(quietCard, "divide-y divide-border overflow-hidden")}>
          {data.drawings.map((d) => (
            <button className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-foreground/5" key={d.id} onClick={() => onDrawing(d.id)} type="button">
              <DrawingPreview className="h-10 w-14 shrink-0 text-brand" drawing={d} />
              <span className="flex flex-1 flex-col">
                <span className="font-medium text-sm">{d.complete ? (BigInt(d.pnl) > 0n ? "Won" : "Finished") : "In play"}</span>
                <span className="text-muted-foreground text-xs">
                  {new Date(d.at).toLocaleDateString([], { month: "short", day: "numeric" })} · {socialMoney(d.stake)} staked
                </span>
              </span>
              <span className={cn("figures font-semibold text-sm", BigInt(d.pnl) > 0n && "text-success-foreground")}>{d.complete ? socialMoney(d.pnl, true) : "Pending"}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty text={own ? "Your first drawing will start the story." : "No drawings in this period."} />
      )}
      {data.next ? (
        <Button disabled={busy} onClick={() => void more()} variant="ghost">
          {busy ? "Loading…" : "Earlier drawings"}
        </Button>
      ) : null}
    </>
  );
}

function EditProfile({ profile, onCancel, onSaved }: { profile: PlayerProfile; onCancel: () => void; onSaved: (profile: PlayerProfile) => void }) {
  const me = useAccount();
  const [username, setUsername] = useState(profile.username ?? "");
  const [bio, setBio] = useState(profile.bio);
  // The Dylan avatar chosen: its seed (the address's own is null).
  const [seed, setSeed] = useState<string | null>(profile.avatarSeed);
  const [page, setPage] = useState(0);
  // undefined: keep the uploaded picture; null: none; a data URL: this one.
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => avatarChoices(profile.player, page * 8 + 1), [profile.player, page]);
  const picture = image === undefined ? profile.avatar : image !== null;
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    try {
      setImage(await avatarFrom(file));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const field = "rounded-[18px] bg-foreground/[0.06] px-4 text-[16px] outline-none ring-inset transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-ring";
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!me.address || busy) return;
        const problem = usernameProblem(username);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
          const result = await socialAction<{ profile: PlayerProfile }>(me.address, "profile", { username, bio, avatarSeed: seed, ...(image !== undefined ? { image } : {}) }, me.signMessage);
          onSaved(result.profile);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Button className="self-start rounded-full" onClick={onCancel} type="button" variant="ghost">
        <ArrowLeftIcon />
        Back to profile
      </Button>
      <div className="flex items-center gap-4">
        {image ? (
          <Avatar className="size-16">
            <AvatarImage alt="Your new picture" src={image} />
          </Avatar>
        ) : (
          <PlayerAvatar className="size-16" profile={{ player: profile.player, avatar: picture, avatarSeed: seed }} />
        )}
        <div className="flex flex-col items-start gap-1">
          <span className="font-medium text-[13px]">{picture ? "Your picture" : "Your avatar"}</span>
          <label className="cursor-pointer text-[13px] text-muted-foreground underline underline-offset-4">
            Upload a photo instead
            <input accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void chooseAvatar(e.target.files?.[0])} type="file" />
          </label>
          {picture ? (
            <button className="text-[13px] text-muted-foreground underline underline-offset-4" onClick={() => setImage(null)} type="button">
              Use an avatar
            </button>
          ) : null}
        </div>
      </div>
      <div aria-label="Avatars" className="grid grid-cols-3 gap-2" role="radiogroup">
        {choices.map((choice) => {
          const value = choice === profile.player ? null : choice;
          const on = !picture && value === seed;
          return (
            <button
              aria-checked={on}
              aria-label={value ? `Avatar ${choice.split(":")[1]}` : "Your address's avatar"}
              className={cn("flex aspect-square items-center justify-center rounded-[18px] bg-muted p-2 transition-shadow", on && "ring-2 ring-brand")}
              key={choice}
              onClick={() => {
                setSeed(value);
                if (picture) setImage(null);
              }}
              role="radio"
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI */}
              <img alt="" className="size-full rounded-full" src={dylanUri(choice)} />
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button className="rounded-full" onClick={() => setPage(1 + Math.floor(Math.random() * 100_000))} size="sm" type="button" variant="secondary">
          <ShuffleIcon />
          Shuffle
        </Button>
      </div>
      <label className="flex flex-col gap-2 text-[13px]">
        Username
        <input autoCapitalize="off" autoComplete="nickname" className={cn(field, "h-12")} maxLength={24} minLength={3} onChange={(e) => setUsername(e.target.value.toLowerCase())} pattern="[a-z][a-z0-9_]{2,23}" placeholder="your_name" required spellCheck={false} value={username} />
      </label>
      <label className="flex flex-col gap-2 text-[13px]">
        Bio
        <textarea className={cn(field, "min-h-24 resize-none py-3")} maxLength={BIO_MAX} onChange={(e) => setBio(e.target.value)} placeholder="A little about you" value={bio} />
        <span className="self-end text-muted-foreground text-xs">
          {[...bio].length}/{BIO_MAX}
        </span>
      </label>
      {error ? <Notice text={error} /> : null}
      <Button className="rounded-full" disabled={busy} type="submit">
        {busy ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}

function DrawingDetail({ id, onBack, onPlayer }: { id: string; onBack: () => void; onPlayer: (player: string) => void }) {
  const social = useSocial();
  const live = social.drawings.find((d) => d.id === id);
  const [stored, setStored] = useState<PublicDrawing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void socialRequest<{ drawing: PublicDrawing | null }>(`/drawing?id=${encodeURIComponent(id)}`, undefined, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setStored(result.drawing);
        if (!result.drawing) setError("This drawing could not be found");
      },
      () => {
        if (!controller.signal.aborted) setError("Could not load this drawing");
      },
    );
    return () => controller.abort();
  }, [id]);
  const d = live ?? stored;
  return (
    <>
      <Button className="self-start rounded-full" onClick={onBack} variant="ghost">
        <ArrowLeftIcon />
        Back
      </Button>
      {!d ? (
        error ? (
          <Notice text={error} />
        ) : (
          <LoadingRows />
        )
      ) : (
        <>
          <button className="flex items-center gap-3 text-left" onClick={() => onPlayer(d.player)} type="button">
            <PlayerAvatar profile={d.profile} />
            <span className="flex flex-col">
              <strong className="text-sm">{playerName(d.profile)}</strong>
              <span className="text-muted-foreground text-xs">{new Date(d.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </span>
          </button>
          <div className={cn(quietCard, "flex flex-col gap-3 p-4")}>
            <DrawingPreview className="h-32 w-full text-brand" drawing={d} />
            <span className="text-[13px] text-muted-foreground">{d.complete ? "Final net result" : "So far · ink still in play"}</span>
            <span className={cn("figures font-bold text-[38px] leading-none", BigInt(d.pnl) > 0n && "text-success-foreground")}>{socialMoney(d.pnl, true)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Staked" value={socialMoney(d.stake)} />
            <Stat label="Paid at settlement" value={socialMoney(d.paid)} />
            <Stat label="Still in play" value={socialMoney((BigInt(d.stake) - BigInt(d.settledStake)).toString())} />
            <Stat label="Earned as IOUs" value={socialMoney(d.owed)} />
          </div>
          <ShareButton drawing={d.id} player={d.player} />
          <a className="self-start text-[13px] text-muted-foreground underline underline-offset-4" href={explorerTx(d.tx)} rel="noopener noreferrer" target="_blank">
            See it placed on the chain
          </a>
        </>
      )}
    </>
  );
}

/** The ink of a drawing, fitted to its box; or, read from the chain (which keeps no shape), its bands. */
export function DrawingPreview({ drawing, className }: { drawing: PublicDrawing; className?: string }) {
  const strokes = drawing.pieces.flatMap((piece) => (piece.stroke ? [piece.stroke] : []));
  const points = strokes.flatMap((stroke) => stroke.pts.map((p) => ({ t: stroke.t0 + p.t, p: stroke.p0 + p.p })));
  if (!points.length) {
    const bands = drawing.pieces.flatMap((piece) => piece.sections.map((s) => ({ t: piece.openAt + s.second * 1000, lo: Number(s.lo) / 1e8, hi: Number(s.hi) / 1e8 })));
    if (!bands.length) return <span className={cn("flex items-center justify-center text-muted-foreground text-xs", className)}>Ink</span>;
    let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
    for (const b of bands) {
      t0 = Math.min(t0, b.t);
      t1 = Math.max(t1, b.t + 1000);
      lo = Math.min(lo, b.lo);
      hi = Math.max(hi, b.hi);
    }
    const sx = (t: number) => 10 + ((t - t0) / Math.max(1000, t1 - t0)) * 140;
    const sy = (p: number) => 70 - ((p - lo) / Math.max(0.01, hi - lo)) * 60;
    return (
      <svg aria-label="Where the drawing was" className={className} role="img" viewBox="0 0 160 80">
        {bands.map((b, i) => (
          <rect fill="currentColor" height={Math.max(3, sy(b.lo) - sy(b.hi))} key={i} opacity={0.55} rx={2} width={Math.max(3, sx(b.t + 1000) - sx(b.t) - 1)} x={sx(b.t)} y={sy(b.hi)} />
        ))}
      </svg>
    );
  }
  let loT = Infinity, hiT = -Infinity, loP = Infinity, hiP = -Infinity;
  for (const p of points) {
    loT = Math.min(loT, p.t);
    hiT = Math.max(hiT, p.t);
    loP = Math.min(loP, p.p);
    hiP = Math.max(hiP, p.p);
  }
  return (
    <svg aria-label="The drawing" className={className} role="img" viewBox="0 0 160 80">
      {strokes.map((stroke, index) => (
        <path
          d={stroke.pts.map((p, i) => `${i ? "L" : "M"}${(10 + ((stroke.t0 + p.t - loT) / Math.max(1000, hiT - loT)) * 140).toFixed(1)},${(70 - ((stroke.p0 + p.p - loP) / Math.max(0.01, hiP - loP)) * 60).toFixed(1)}`).join(" ")}
          fill="none"
          key={index}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
      ))}
    </svg>
  );
}

function PnlChart({ points }: { points: ProfileResponse["curve"] }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!points.length) return <p className="mt-3 text-muted-foreground text-xs">Finished ink builds this line.</p>;
  const values = [0, ...points.map((p) => Number(p.pnl) / 1e6)];
  const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(0.01, hi - lo);
  const path = values.map((value, i) => `${i ? "L" : "M"}${(4 + (i / Math.max(1, values.length - 1)) * 312).toFixed(1)},${(76 - ((value - lo) / span) * 68).toFixed(1)}`).join(" ");
  return (
    <div className="mt-3">
      <svg
        aria-label="Net PnL over time"
        className="h-24 w-full touch-pan-y text-brand"
        onPointerLeave={() => setSelected(null)}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setSelected(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width) * (points.length - 1)))));
        }}
        role="img"
        viewBox="0 0 320 84"
      >
        <path d={path} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
      </svg>
      <p className="figures min-h-4 text-muted-foreground text-xs">{selected !== null ? `${new Date(points[selected].at).toLocaleDateString()} · ${socialMoney(points[selected].pnl, true)}` : "Net, after the stakes settled"}</p>
    </div>
  );
}

function ShareButton({ player, drawing }: { player: string; drawing?: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  const share = useCallback(async () => {
    const url = new URL("/", location.origin);
    url.searchParams.set(drawing ? "drawing" : "player", drawing ?? player);
    try {
      if (typeof navigator.share === "function") await navigator.share({ title: drawing ? "A drawing on skech" : "Draw with me on skech", url: url.toString() });
      else {
        await navigator.clipboard.writeText(url.toString());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(true);
    }
  }, [player, drawing]);
  return (
    <button className="flex min-h-11 items-center gap-1.5 font-medium text-muted-foreground text-xs" onClick={() => void share()} type="button">
      {copied ? <CheckIcon className="size-3.5" /> : <Share2Icon className="size-3.5" />}
      {copied ? "Link copied" : error ? "Could not share · retry" : drawing ? "Share drawing" : "Share profile"}
    </button>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] bg-muted px-3.5 py-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <p className="figures font-semibold text-[17px]">{value}</p>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[18px] bg-muted px-5 py-10 text-center">
      <UsersIcon className="size-6 text-muted-foreground/60" />
      <p className="max-w-60 text-muted-foreground text-sm">{text}</p>
    </div>
  );
}
function Notice({ text }: { text: string }) {
  return (
    <p className="rounded-[14px] bg-muted px-4 py-3 text-[13px] text-muted-foreground leading-relaxed" role="status">
      {text}
    </p>
  );
}
function LoadingRows() {
  return (
    <div aria-label="Loading" className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton className="h-16 rounded-[18px]" key={i} />
      ))}
    </div>
  );
}

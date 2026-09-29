"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { money, signed } from "@/lib/money";
import { usePracticeOf } from "@/lib/practice";
import { curve, resetScoreboard, type Scoreboard, useScoreboard } from "@/lib/scoreboard";
import { cn } from "@/lib/utils";
import { fmtMultiple } from "./stage";


/**
 * This session's wins: what they came to, how they built up, and the best of them. Only what was won is shown,
 * as a casino's win meter does; the balance is the full picture. Opened from the number beside the balance. A
 * bottom sheet on a phone, a side panel on a desk.
 */
export function ScoreboardSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const s = useScoreboard();
  const all = usePracticeOf("bestHit", "bestStreak");
  const rounds = s.rounds.length;
  const wins = s.rounds.filter((r) => r.won > r.cost);
  // From the first round to the last: pure, and what the session actually spanned.
  const minutes = rounds ? Math.max(1, Math.round((s.lastAt - Math.min(...s.rounds.map((r) => r.at))) / 60_000)) : 0;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-md" side="right" variant="inset">
        <SheetHeader className="px-5 pt-6 sm:px-6 sm:pt-8">
          <SheetTitle className="font-bold text-xl">This session</SheetTitle>
          <SheetDescription>{rounds ? `${rounds} ${rounds === 1 ? "round" : "rounds"} over ${minutes} min` : "Nothing yet. Draw ahead of the price."}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-3.5 px-5 pb-10 sm:px-6">
          <div className="flex flex-col gap-1 rounded-[18px] bg-muted px-4 pt-4 pb-3">
            <span className="text-[13px] text-muted-foreground">Won this session</span>
            <span className={cn("figures font-bold text-[40px] leading-none tracking-[-0.02em] motion-safe:animate-[landed-pop_520ms_cubic-bezier(.2,1.5,.4,1)_both]", s.won > 0 ? "text-success-foreground" : "text-foreground")} key={s.won}>
              {s.won > 0 ? `+${money(s.won)}` : money(0)}
            </span>
            {s.streak >= 2 ? <span className="mt-1 self-start rounded-full bg-brand/12 px-2.5 py-0.5 font-semibold text-[13px] text-brand">{s.streak} wins in a row</span> : null}
            {rounds >= 2 ? <Line s={s} /> : null}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Wins" value={s.wins ? String(s.wins) : "–"} />
            <Stat label="Best hit" value={s.best ? fmtMultiple(s.best) : "–"} />
            <Stat label="Biggest win" value={s.biggest > 0 ? signed(s.biggest) : "–"} good={s.biggest > 0} />
            <Stat label="Streak now" value={s.streak ? String(s.streak) : "–"} />
            <Stat label="Best streak" value={s.bestStreak ? String(s.bestStreak) : "–"} />
            <Stat label="Hits" value={s.hits ? String(Math.round(s.hits)) : "–"} />
          </div>
          {wins.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-[13px] text-muted-foreground">Your wins</span>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[18px] bg-muted">
                {wins.slice(0, 25).map((r, i) => {
                  const n = Math.round((r.won - r.cost) * 100) / 100;
                  return (
                    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm motion-safe:animate-[row-in_320ms_cubic-bezier(.2,.8,.2,1)_both]" key={r.id} style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{r.best >= 10 ? "Big win" : "Won"}</span>
                        <span className="figures text-[13px] text-muted-foreground">
                          {new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {money(r.cost)}
                          {r.best ? ` · best ${fmtMultiple(r.best)}` : ""}
                        </span>
                      </span>
                      <span className="figures font-semibold text-success-foreground">{signed(n)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {all.bestHit || all.bestStreak ? (
            <p className="figures px-1 text-[13px] text-muted-foreground">
              All time: best hit {all.bestHit ? fmtMultiple(all.bestHit) : "–"}, best streak {all.bestStreak}
            </p>
          ) : null}
          {rounds ? (
            <Button className="self-start" onClick={resetScoreboard} size="sm" variant="ghost">
              Start a new session
            </Button>
          ) : null}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[14px] bg-muted px-3.5 py-2.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={cn("figures font-semibold text-[17px]", good && "text-success-foreground")}>{value}</span>
    </div>
  );
}

/**
 * What was won in total after each round, from zero: it only climbs. One series, so no legend: the card's
 * title names it. Touch or hover reads a round.
 */
function Line({ s }: { s: Scoreboard }) {
  const pts = useMemo(() => curve(s), [s]);
  const [at, setAt] = useState<number | null>(null);
  const W = 320;
  const H = 72;
  const pad = 4;
  const lo = Math.min(0, ...pts);
  const hi = Math.max(0, ...pts);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = pts.at(-1)!;
  const colour = "var(--success-foreground)";
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1));
    setAt(Math.max(1, Math.min(pts.length - 1, i)));
  };
  const round = at !== null ? pts[at] - pts[at - 1] : 0;
  return (
    <div className="relative mt-2">
      <p className="figures h-5 text-[13px] text-muted-foreground" aria-live="polite">
        {at !== null ? (
          <>
            Round {at}: {round > 0 ? <span className="text-success-foreground">+{money(round)}</span> : "no win"}, {money(pts[at])} won so far
          </>
        ) : (
          "Your winnings, round by round"
        )}
      </p>
      <svg
        aria-label={`Winnings after each of ${pts.length - 1} rounds, ${money(last)} in all`}
        className="h-[72px] w-full touch-none overflow-visible motion-safe:animate-[reveal_900ms_cubic-bezier(.2,.8,.2,1)_both]"
        onPointerDown={pick}
        onPointerLeave={() => setAt(null)}
        onPointerMove={pick}
        onPointerUp={(e) => e.pointerType !== "mouse" && setAt(null)}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        <line stroke="var(--border)" strokeDasharray="3 4" strokeWidth={1} vectorEffect="non-scaling-stroke" x1={0} x2={W} y1={y(0)} y2={y(0)} />
        <path d={d} fill="none" stroke={colour} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {at !== null ? (
          <>
            <line stroke="var(--muted-foreground)" strokeWidth={1} vectorEffect="non-scaling-stroke" x1={x(at)} x2={x(at)} y1={0} y2={H} opacity={0.4} />
          </>
        ) : null}
      </svg>
      {/* The marker sits outside the stretched drawing, so it stays round. */}
      {at !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-muted"
          style={{ left: `${(x(at) / W) * 100}%`, top: `calc(20px + ${(y(pts[at]) / H) * 72}px)`, background: colour }}
        />
      ) : null}
    </div>
  );
}

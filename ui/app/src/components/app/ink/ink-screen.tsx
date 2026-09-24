"use client";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Bar, DIFFICULTY, difficulty, features, type Field, field, type Library, MIN_DIFFICULTY, openFor, readLibrary, RULES, setDifficulty, setMaxReturn, stepFor } from "@skech/core/dots";
import { canDraw, levelFor, PAPER_PER_DOT, paperResult } from "@skech/core/paper";
import { howItWorks, howItWorksSummary } from "@skech/core/explain";
import { areaCells, areaCostOf, CELL, cost, decided, isArea, liveInkTotals, judge, open, openOn, INK_EDGE_CELLS, drawingLayout, INK_CELL, placeInk, refund, type Cell, type InkBet, type Stroke, won } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import { BATCH_PIECE_STAKE_E6, cutAt, encodeStroke, fromE8, gridStep, LATE_MS, stakeOf, toE6, toE8, toSections, unitFor, usdE6 } from "@skech/core/chain";
import { pieceBytes, type SolanaPiece } from "@skech/contracts/solana/sdk";
import { sha256 } from "@noble/hashes/sha256";
import { confirmPiece, expireCells, holdIds, paidOnChain, pay, refusalLine, refusals, type Refusals, unpay } from "@skech/core/optimistic";
import { type Incoming, leastPiece } from "@/lib/relayer";
import { NETWORK } from "@/lib/chain";
import { useChain } from "./chain-context";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { setDark, useDark } from "@/components/app/theme-toggle";

import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { type Market, useEngine } from "@/lib/engine";
import { cents, practice, record, setPractice, usePracticeOf } from "@/lib/practice";
import { endPaperRun, paper, paperCredit, paperDebit, paperDrew, paperTick, pausePaperRun, resumePaperRun, startPaperRun, usePaper, usePaperPhase } from "@/lib/paper";
import { celebrate, feel, sound } from "@/lib/feel";
import { type Tier, winTier } from "@skech/core/cheer";
import { money, signed, skt as sktAmount } from "@/lib/money";
import { scoreboard, useScoreboard } from "@/lib/scoreboard";
import { ScoreboardSheet } from "./scoreboard-sheet";
import { addChange, Ledger } from "./ledger";
import { WalletButton } from "./wallet-button";
import { publishStroke } from "@/lib/social";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { firstAtOrAfter, fmtMultiple, type Game, type Placed, type Preview, Stage } from "./stage";
import { HapticHost } from "./haptic-host";
import { UpdateReady } from "./update-ready";
import { TokenAvatar } from "@/components/app/token-avatar";
import { DepositButton, InkControls } from "./ink-controls";
import { PresenceRail } from "./presence-rail";
import feedback from "./drawing-feedback.module.css";
import { CrispNumber, RisingMoney } from "./crisp-number";
import { introReady } from "./ink-intro";
import { homeBarRoom, HomeScreenBar, HomeScreenSheet, useHomeScreen } from "./home-screen";
import { forReal, Onboarding, useOnboarding } from "./onboarding";
import { SignInButton } from "@/components/app/sign-in";
import { useGate, useGatePanels } from "./gate";
import { useAccount } from "@/components/app/auth";

/**
 * skech. Draw ahead of the Bitcoin price; wherever it runs through your ink
 * pays.
 *
 * A line is the union of its pen-covered area, priced in full-dot units.
 * It is quoted while drawing and bet as it is drawn, a piece at a time. Only
 * touched ink pays. The rules are `@skech/core/dots`; playing for real, the
 * chain prices and settles each piece by the same rules, and this screen
 * follows what it says. This screen keeps the practice money, prices the
 * map, opens each drawing on its second, and judges every second's trades as
 * they arrive.
 */

/** In development, anything that holds the page up for more than 50 ms says so. */
const slow = (what: string, since: number, detail: string) => {
  const ms = performance.now() - since;
  if (process.env.NODE_ENV !== "production" && ms > 50) console.warn(`[ink] slow ${what}: ${Math.round(ms)} ms (${detail})`);
};

/** A drawing opens once its second has closed and this much longer, for trades that arrive late. */
const OPEN_AFTER_MS = 350;
/** By then a drawing whose second has no map yet (the pen changed, or the worker is slow) is priced on the paths, here. */
const OPEN_BY_MS = 900;
/** A full map of the paths, made for a drawing whose second's map had not come from the worker in time: kept for the next. */
let lateField: { key: string; field: Field } | null = null;
/**
 * A drawing opened past its deadline without its second's map: priced exactly as `open` prices it, but the map of the
 * paths it makes is made once for the second, not once for every piece (each a long task on a slow phone's browser).
 */
function openLate(bet: InkBet, lib: Library, bars: Bar[]): InkBet {
  const f = features(bars, bet.openAt);
  if (!f || bet.model !== "ladder-v1") return open(bet, lib, bars);
  const cell = bet.cell ?? CELL, size = bet.step * cell, edge = bet.edgeCells ?? 0;
  const key = JSON.stringify([bet.openAt, size, cell, edge, f, RULES]);
  if (lateField?.key !== key) lateField = { key, field: field(lib, f, bet.openAt, size, cell, edge) };
  return openOn(bet, lateField.field) ?? open(bet, lib, bars);
}
/** A second's dots are missed only this long after it ends, for the same reason. */
const CLOSE_AFTER_MS = 600;
/** A piece sent to the chain and not placed by then is let go. */
const CHAIN_ANSWER_MS = 8000;
/** The chain's name for a drawing: 64 bits of the line's id, as the phone names it. Kept per line: it is asked for on every price batch. */
const drawingIds = new Map<string, bigint>();
const drawingIdOf = (line: string) => {
  let id = drawingIds.get(line);
  if (id === undefined) {
    const h = sha256(new TextEncoder().encode(line));
    id = new DataView(h.buffer, h.byteOffset).getBigUint64(0, true);
    if (drawingIds.size > 2000) drawingIds.clear();
    drawingIds.set(line, id);
  }
  return id;
};
/** A line's round so far: its pieces still in play, and what the decided ones staked, won, hit and covered. */
type Tally = { at: number; open: number; won: number; cost: number; hits: number; points: number; best: number };
/** A decided piece into its line's books (`sign` 1), or out of them again (-1), and into the totals of what is settled. */
function book(lines: Map<string, Tally>, settled: { committed: number; returned: number }, bet: InkBet, sign: 1 | -1) {
  settled.committed += sign * (cost(bet) - refund(bet));
  settled.returned += sign * won(bet);
  const line = bet.group ?? bet.id;
  let t = lines.get(line);
  if (!t) lines.set(line, (t = { at: bet.placedAt, open: 0, won: 0, cost: 0, hits: 0, points: 0, best: 0 }));
  t.open -= sign;
  if (bet.status !== "done") return;
  const hitCells = bet.cells.filter((d) => d.status === "hit");
  t.won += sign * won(bet);
  t.cost += sign * (cost(bet) - refund(bet));
  t.hits += sign * (isArea(bet.model) ? hitCells.reduce((n, c) => n + c.area, 0) : hitCells.length);
  t.points += sign * (isArea(bet.model) ? bet.cells.reduce((n, c) => n + (c.expired ? 0 : c.area), 0) : bet.cells.length);
  if (sign > 0) t.best = Math.max(t.best, ...hitCells.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
}
/** A piece's number within its drawing, from its id `line:index`. */
const pieceIndexOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/**
 * A piece's key while it is on its way: its drawing and number, as the relayer names it back. Its bet's address
 * on chain is a program address, found by hashing until one is off the curve: known from `placed`, not worked out.
 */
const keyOf = (drawing: bigint | string, index: number) => `${drawing}:${index}`;
const hexOf = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const bytesOf = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The dots a line as it stood covers on an opening: once per mark and second, as held ink is asked at every read. */
const areas = new WeakMap<Stroke, { at: number; step: number; area: number }>();
const inkArea = (st: Stroke, at: number, step: number) => {
  const c = areas.get(st);
  if (c && c.at === at && c.step === step) return c.area;
  const area = areaCells(st, at, step).reduce((n, x) => n + x.area, 0);
  areas.set(st, { at, step, area });
  return area;
};
/** Reads of a line kept while its ink is held back: a cut can only be at one of them. */
const MARKS = 32;

/**
 * A piece sent to the chain: its bet, its drawing, its stake, and what it takes to send its ink again. It plays at
 * once, as if placed (opened here, judged here, its hits paid into the balance), until the chain says otherwise.
 * `placed`: the chain has taken it. `credited`: what its hits have paid into the balance so far, so a refusal can
 * take exactly that back.
 */
type SentPiece = { id: string; line: string; openAt: number; stakeUsd: number; drawing: bigint; stroke: Uint8Array; tries: number; placed: boolean; credited: number };
/**
 * Refusals that mean nothing was placed and the same ink can go again on the
 * next second: too late for its second, a price quote that aged on the way,
 * a difficulty that changed, a relayer still starting. Not "no answer": that
 * piece may have gone in.
 */
const RESEND = /^(Too late for that second|Price seen is stale|Difficulty|Waiting for live prices|Starting up|No price to open on|Late$|StalePrice$)/;
/** How many times a piece is sent again before its ink is let go. */
const RESENDS = 2;
const RESEND_BASE = 100_000;

type Chain = ReturnType<typeof useChain>;
/**
 * A piece as the session key signs it, and as it goes on the wire: bands in grid units, the chain's numbers as
 * strings. Signed is the piece exactly as it sits in the program's `place` instruction (`pieceBytes`), which
 * begins with this deployment's domain, so a signature is good for this game on this cluster only.
 */
function pieceFor(ch: Chain, level: number, drawing: bigint, index: number, openAt: number, perDot: number, unit: number, quote: { price: string | number; time: string | number }, sections: ReturnType<typeof toSections>, stroke: Uint8Array) {
  const unitE8 = toE8(unit);
  const piece: SolanaPiece = {
    domain: bytesOf(ch.hello!.domain),
    player: ch.player! as SolanaPiece["player"],
    drawing,
    index,
    market: ch.hello!.market.id,
    difficulty: ch.hello!.difficulty ?? level,
    openAt: BigInt(openAt),
    perDot: Number(toE6(perDot)),
    unit: unitE8,
    priceSeen: BigInt(quote.price),
    priceTime: BigInt(quote.time),
    strokeHash: sha256(stroke),
    sections: sections.map((s) => ({ second: s.second, lo: Number(s.lo / unitE8), width: Number((s.hi - s.lo) / unitE8), stake: Number(s.stake) })),
  };
  const wire = { ...piece, domain: undefined, drawing: drawing.toString(), openAt: String(openAt), unit: unitE8.toString(), priceSeen: piece.priceSeen.toString(), priceTime: piece.priceTime.toString(), strokeHash: hexOf(piece.strokeHash as Uint8Array) };
  return { piece, wire };
}
/** Sign a piece with the session key and send it; `fail` hears why, if the relayer turns it away. */
function sendPiece(ch: Chain, { piece, wire }: ReturnType<typeof pieceFor>, stroke: Uint8Array, priceSig: string, fail: (why: string) => void) {
  const { key: sessionKey, client } = ch;
  void (async () => {
    try {
      const sig = await sessionKey!.sign(pieceBytes(piece));
      const ack = await client.request({ type: "piece", piece: wire, sessionSig: hexOf(sig), priceSig, stroke: hexOf(stroke) }, (m): m is Extract<Incoming, { type: "ack" }> => m.type === "ack" && m.drawing === wire.drawing && m.index === piece.index, 10_000);
      if (!ack || !ack.ok) fail(ack?.why ?? "No answer. Your money is back.");
      // Taken: its stroke to the community, so other players see the line (the chain keeps only its hash).
      else if (ack.betId) publishStroke(ack.betId, hexOf(stroke));
    } catch (e) {
      fail(String((e as Error).message ?? e));
    }
  })();
}
/** On chain a hit pays its gross less 10% of the profit: shown that way here too, as each hit lands. */
function lessProfitFee(bet: InkBet, before: InkBet, profitFeeBps: number): InkBet {
  let touched = false;
  const cells = bet.cells.map((c, k) => {
    if (c.status !== "hit" || before.cells[k]?.status === "hit" || c.paid === undefined) return c;
    touched = true;
    const stake = bet.perUnit * c.area;
    return { ...c, paid: c.paid - Math.max(0, c.paid - stake) * (profitFeeBps / 10_000) };
  });
  return touched ? { ...bet, cells } : bet;
}

/** A price with its cents quieter than its dollars. */
const Price = ({ value }: { value: number }) => {
  const [whole, part] = money(value).split(".");
  return <><CrispNumber value={whole} /><span className={feedback.cents}>.{part}</span></>;
};

/*
  Two things on this screen change faster than it should re-render: the price, with every trade, and the
  terms of the stroke under the pen, with every move. Each is its own small component that listens for its
  own value, so the screen around them renders only when something else changes.
*/

/** The price in the market row, from the feed as each trade batch lands. */
function LivePrice({ feed }: { feed: Market }) {
  const price = useSyncExternalStore(feed.subscribe, () => feed.ticks.at(-1)?.p ?? feed.bars.at(-1)?.c ?? 0, () => 0);
  return price ? <Price value={price} /> : <Skeleton className="my-[3px] h-6 w-32 rounded-md" />;
}

/** The practice balance, which moves with every piece of ink placed: read here, so only the figure renders again. */
function PracticeBalance({ crisp = false }: { crisp?: boolean }) {
  const { balance } = usePracticeOf("balance");
  return crisp ? <RisingMoney format={money} value={balance} /> : <>{money(balance)}</>;
}

/*
  The paper run's own figures, read here so only they render as they change. "Paper money", never "Balance":
  paper dollars are never shown where a real balance would be read.
*/
function PaperMoney({ gained }: { gained: boolean }) {
  const run = usePaper();
  if (!run) return null;
  return (
    <div className={feedback.accounts}>
      <div aria-label={`Paper money ${money(run.balance)}, not real`} className={feedback.balance}>
        <span className={feedback.eyebrow}>Paper money</span>
        <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}><RisingMoney format={money} value={run.balance} /></span>
        <Ledger />
      </div>
      <div className={feedback.balance}>
        <span className={feedback.eyebrow}>Won</span>
        <span className={cn(feedback.pnlValue, "figures", run.won > 0 ? "text-success-foreground" : "text-foreground")}><CrispNumber value={run.won > 0 ? `+${money(run.won)}` : money(0)} /></span>
      </div>
    </div>
  );
}

/**
 * The paper run's clock, always on screen while it runs: subtle, and urgent in its last seconds. The odds are
 * easier than real play, and it says so every second of the run, since the game it stands in for is real money.
 */
function PaperClock() {
  const run = usePaper();
  if (!run || run.phase === "over") return null;
  return (
    <div className={cn(feedback.clockPill, run.urgent && feedback.clockUrgent)} role="timer">
      <strong className="figures">{run.clock}</strong>
      <span aria-hidden="true">·</span>
      <span>Practice</span>
    </div>
  );
}

/** The end of a paper run: what it came to, and the two ways on. The card is the way-in card's (onboarding.tsx). */
function PaperEnd({ onSignIn, onAgain }: { onSignIn: () => void; onAgain: () => void }) {
  const run = usePaper();
  if (!run || run.phase !== "over") return null;
  const { headline } = paperResult(run, money);
  return (
    <div aria-label="Your practice run" className={cn(feedback.notice, "absolute inset-0 z-30 flex items-center justify-center bg-background/30 px-4 backdrop-blur-md")} role="dialog">
      <div className={cn(feedback.notice, "w-full max-w-[360px] rounded-[28px] bg-raised p-6 shadow-[var(--raised-shadow)]")}>
        <h2 className="font-semibold text-[22px] leading-tight">{headline}</h2>
        <p className="mt-1.5 text-[15px] text-muted-foreground">Practice money on the live Bitcoin price.</p>
        <Button className="mt-5 h-12 w-full rounded-full font-semibold text-base sm:h-12" onClick={onSignIn}>Sign in to play for real</Button>
        <Button className="mt-2 h-12 w-full rounded-full font-semibold text-base sm:h-12" onClick={onAgain} variant="outline">Try again</Button>
      </div>
    </div>
  );
}

/** A value that changes faster than the screen should re-render, for the one part that shows it. */
type Signal<T> = { get: () => T; set: (next: T) => void; subscribe: (fn: () => void) => () => void };
function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** While drawing: what the stroke has put in play, and the most it can win. */
function PreviewPill({ preview: store, className }: { preview: Signal<Preview | null>; className?: string }) {
  const preview = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!preview) return null;
  return (
    <div className={cn(feedback.floatPill, className)} role="status">
      {preview.inPlay.length ? (
        <>
          <span>In play <strong>{money(preview.cost)}</strong></span>
          <span>Could win <strong className={feedback.win}>{money(preview.high)}</strong></span>
          <span className="max-sm:hidden">Up to <strong className={feedback.win}>{fmtMultiple(preview.multipleHigh)}</strong></span>
        </>
      ) : (
        <span>Move to a spot with a multiplier on it</span>
      )}
    </div>
  );
}

/** One setting on a switch, in a grouped list. */
function ToggleRow({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex min-h-[60px] cursor-pointer items-center gap-3 px-4">
      <span className="flex grow flex-col"><span className="text-[17px]">{title}</span><span className="text-[13px] text-muted-foreground">{detail}</span></span>
      <Switch checked={checked} className="[--thumb-size:27px] data-checked:bg-success sm:[--thumb-size:27px]" onCheckedChange={onChange} />
    </label>
  );
}

const navRow = "flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-[17px] transition-colors hover:bg-accent";

export function InkScreen() {
  const feed = useEngine();
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });
  // Not the balance (PracticeBalance) nor the drawings in play (only kept, never shown): those change many times a second.
  const state = usePracticeOf("perDot", "brush", "taught", "houseDifficulty", "sound", "haptics");
  /*
    Real money: the game on chain, through the relayer. Read through a ref
    inside the effects and the pen, which run for the life of the page.
  */
  const chain = useChain();
  const chainRef = useRef(chain);
  useEffect(() => {
    chainRef.current = chain;
  });
  const real = chain.real;
  /** Pieces sent to the chain, by their drawing and number: which local bet each is, and what was staked. */
  const chainBets = useRef(new Map<string, SentPiece>());
  /** The chain's name for a bet (its account), once placed, to the piece's key: settlements name it that way. */
  const betKeys = useRef(new Map<string, string>());
  /** Pieces sent again this visit: their indices, well clear of any line's own. */
  const resent = useRef(0);
  /* The paths every chance is measured on: a file of their own, fetched once. Nothing is priced until it is in. */
  const [lib, setLib] = useState<Library | null>(null);
  /* The map is measured in a worker of its own, on its own copy of the paths: see `field.worker.ts`. */
  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    let live = true;
    const w = new Worker(new URL("./field.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    // By its content's hash (next.config.ts), so the browser keeps it.
    void fetch(process.env.NEXT_PUBLIC_DOTS_LIB ?? "/dots-lib.bin")
      .then((r) => r.arrayBuffer())
      .then((b) => {
        if (!live) return;
        // Read here first (the library is copied out of the file), then the file itself is handed to the worker, not copied to it.
        setLib(readLibrary(new Uint8Array(b)));
        w.postMessage({ kind: "lib", bytes: b }, [b]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      w.terminate();
      worker.current = null;
    };
  }, []);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const expand = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* Embedded browsers may not expose fullscreen. The layout still fills its viewport. */ }
  };

  /* The stroke's terms, for the pill; the screen itself only needs to know whether there is a stroke. */
  const [preview] = useState(() => signal<Preview | null>(null));
  const [previewing, setPreviewing] = useState(false);
  // Settings and How it works are held by the gate, so the account menu opens them too.
  const { help, setHelp, settings: settingsOpen, setSettings: setSettingsOpen } = useGatePanels();
  const [returnedInk, setReturnedInk] = useState<{ id: string; amount: number } | null>(null);
  useEffect(() => {
    if (!returnedInk) return;
    const timer = setTimeout(() => setReturnedInk(null), 3200);
    return () => clearTimeout(timer);
  }, [returnedInk]);
  /* Pieces that did not go through: one short notice for a burst of them, with what came back. */
  const [refused, setRefused] = useState<Refusals | null>(null);
  const refusedRef = useRef<Refusals | null>(null);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => {
      refusedRef.current = null;
      setRefused(null);
    }, 3200);
    return () => clearTimeout(timer);
  }, [refused]);
  const dark = useDark();
  /*
    A paper run: "Try it free", signed out, on paper money that lives only in memory (lib/paper.ts). Paper ink is
    priced, judged and paid here, as practice is, and never goes near the relayer: it can only be drawn signed
    out, where there is no session to send it with, and signing in throws it away.
  */
  const paperPhase = usePaperPhase();
  const paperOn = paperPhase !== null && !real;
  // What How it works explains: the paper run, real USDC (a build that signs in), or practice money.
  const helpMode = paperOn ? "paper" : forReal ? "real" : "practice";
  /**
   * How hard the game is here: on chain, what the game contract says; on a paper run, its own easier setting;
   * else what the house set on this browser, or the game's own. `least`: only the paper run goes under 50.
   */
  const { level, least } = levelFor({ paper: paperOn, chain: real || paperOn ? chain.hello?.difficulty ?? null : null, house: state.houseDifficulty });
  /* The house's controls show in development, or with ?house in the address. */
  const [house] = useState(() => typeof window !== "undefined" && (process.env.NODE_ENV !== "production" || new URLSearchParams(window.location.search).has("house")));
  const [live, setLive] = useState(0);
  const [result, setResult] = useState<{ key: string; won: number; cost: number; hits: number; points: number; voided: boolean; best?: number; streak?: number } | null>(null);
  useEffect(() => {
    if (!result) return;
    // A win stays long enough to enjoy; a loss is said once and gets out of the way.
    const t = setTimeout(() => setResult(null), result.won > result.cost ? 4200 : 2400);
    return () => clearTimeout(t);
  }, [result]);
  /**
   * SKT a round's misses minted, as the chain says it, by line; the rounds that came out behind; and the latest word,
   * which shows as a quiet "+120 SKT": on the round's card while it is up, or alone once it has gone, and only for a
   * round that came out behind. A loss is never celebrated: no sound, no colour.
   */
  const mintedBy = useRef(new Map<string, number>());
  const lostLines = useRef(new Set<string>());
  const [sktNote, setSktNote] = useState<{ line: string; skt: number; lost: boolean } | null>(null);
  useEffect(() => {
    if (!sktNote) return;
    const t = setTimeout(() => setSktNote(null), 2400);
    return () => clearTimeout(t);
  }, [sktNote]);
  const [fresh, setFresh] = useState(false);
  const me = useAccount();
  // The way in holds its ink over the screen until there are live prices to show, and it is known who is playing:
  // the first screen is the right one, never a sign-in flashed at someone already signed in.
  useEffect(() => {
    if (fresh && me.ready) introReady();
  }, [fresh, me.ready]);
  // Once a load: how long until the game could be played, and if it is slow, which part is.
  const readyAt = useRef<number | null>(null);
  const health = useRef({ prices: false, account: false, relayer: false, signedIn: false });
  useEffect(() => {
    health.current = { prices: fresh, account: me.ready, relayer: chain.real, signedIn: me.signedIn };
  }, [fresh, me.ready, me.signedIn, chain.real]);
  useEffect(() => {
    if (!fresh || !me.ready || readyAt.current !== null) return;
    readyAt.current = performance.now();
    track("app_ready", { ms: Math.round(readyAt.current), signed_in: me.signedIn });
  }, [fresh, me.ready, me.signedIn]);
  useEffect(() => {
    const t = setTimeout(() => {
      const h = health.current;
      if (h.prices && h.account && (!forReal || !h.signedIn || h.relayer)) return;
      track("connect_slow", { prices: h.prices, account: h.account, relayer: h.relayer, signed_in: h.signedIn });
    }, 10_000);
    return () => clearTimeout(t);
  }, []);
  /* The balance shows green for a moment when a hit pays into it. What paid lands in the changes under it. */
  const [gained, setGained] = useState<number>(0);
  useEffect(() => {
    if (!gained) return;
    const t = setTimeout(() => setGained(0), 1400);
    return () => clearTimeout(t);
  }, [gained]);
  /* Hits close together climb: each one within a few seconds of the last sounds a step higher. */
  const hitRun = useRef({ n: 0, at: 0 });
  /*
    A profitable round's celebration on the screen, besides its card: the balance lights up, and a strong one lights
    the edges. `key` plays it again for the next. Profitable rounds in a row on paper, which keeps no books.
  */
  const [cheer, setCheer] = useState<{ key: string; tier: Tier } | null>(null);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(null), 2600);
    return () => clearTimeout(t);
  }, [cheer]);
  const paperRun = useRef(0);
  /** Where the price last met each line's ink, for its confetti. */
  const lastHit = useRef(new Map<string, { t: number; price: number; at: number }>());
  const game = useRef<Game>({ bars: [], ticks: [], skew: 0, field: null, placeLead: 0, step: 1, priceStep: 1, marketStep: 1, viewport: { width: 1280, height: 800 }, displayPrice: 0, perDot: state.perDot, pen: state.brush, cell: INK_CELL, bets: [], quote: null, fx: [], dark: false });

  const onViewport = useCallback((size: { width: number; height: number }) => { game.current.viewport = size; }, []);
  const settledTotals = useRef({ committed: 0, returned: 0 });
  // Only what the "Won" figure shows: what is staked moves with every piece placed, and the screen need not render for it.
  const [totals, setTotals] = useState({ batch: false, returned: 0 });
  const updateTotals = useCallback(() => {
    const next = liveInkTotals(game.current.bets, settledTotals.current);
    const batch = next.drawings > 0 || next.committed > 0;
    setTotals(previous => previous.batch === batch && previous.returned === next.returned ? previous : { batch, returned: next.returned });
  }, []);

  // For tests and debugging in development: the live game, and the engine and paths it prices on, from the console.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __dots: game.current, __engine: { lib, open, judge, features }, __practice: { get: practice, set: setPractice }, __rules: RULES });
  }, [lib]);

  // On chain a piece opens a margin later than it is drawn; the map, the quote and the placement all use the same one.
  useEffect(() => {
    game.current.placeLead = real ? LATE_MS : 0;
  }, [real]);

  useEffect(() => {
    const g = game.current;
    // A paper run's price is its own, fixed for the run; the player's own pick waits for real play.
    g.perDot = paperOn ? PAPER_PER_DOT : state.perDot;
    // How hard the game is: every drawing priced from now on, and the map, use it.
    setDifficulty(level, least);
    // On chain, ink that would return more than the stake fee leaves is not offered: not on the map either.
    const feeBps = real ? chain.hello?.terms?.feeBps : undefined;
    setMaxReturn(feeBps === undefined ? 1 : 1 - feeBps / 10_000);
    if (g.field && g.field.rtp !== difficulty(level, least).rtp) g.field = null;
    g.pen = state.brush;
    g.cell = INK_CELL;
  }, [state.perDot, state.brush, state.taught, level, least, paperOn, real, chain.hello?.terms?.feeBps]);

  /*
    Every quarter second: whether the page is dark, whether the prices are
    fresh, and the field, priced for a drawing placed now. The dot size
    follows the market, but only while nothing of yours is on it.
  */
  // Prices alone make the chart fresh: the paths only price the map, and its tiles come in when they do.
  const connected = feed.connected;
  useEffect(() => {
    /* One map asked for at a time; a new one once a second, or at once when the pen or the step changes. */
    let asked = "";
    let busy = 0;
    let pendingId = 0;
    const w = worker.current;
    const onMap = (e: MessageEvent<{ id: number; field: Field }>) => {
      if (e.data.id !== pendingId) return;
      busy = 0;
      const g = game.current;
      if (Date.now() + g.skew - e.data.field.openAt > 2500) { asked = ""; return; }
      // Reject results priced for an outdated scale or difficulty.
      // The map is asked for on the price grid (`size` below), not the screen's step: check it against the same.
      if (Math.abs(e.data.field.step - g.priceStep * g.cell) > 1e-9 || e.data.field.rtp !== difficulty(level, least).rtp || e.data.field.edgeCells !== INK_EDGE_CELLS) return;
      g.field = e.data.field;
    };
    w?.addEventListener("message", onMap);
    const tick = () => {
      const g = game.current;
      g.dark = document.documentElement.classList.contains("dark");
      const latest = g.bars.at(-1);
      const nowMs = Date.now() + g.skew;
      // Heartbeats keep quiet seconds live; signed prices are checked separately when placing.
      const ok = connected && !!latest && nowMs - latest.t < 5000 && g.bars.length > 60;
      setFresh(ok);
      if (!ok) {
        g.field = null;
        return;
      }
      /*
        The map is of the last second that is over, with the margin for late
        trades: the second the drawings due now open on, so they are priced
        straight off it. What is being drawn is quoted on it too, a second
        behind at most.
      */
      const at = Math.floor((nowMs - OPEN_AFTER_MS) / 1000) * 1000;
      const f = features(g.bars, at);
      if (!f) return;
      /*
        The price step follows the market, once it has moved well off the
        old one so it does not flicker. Drawings already placed keep their
        own prices, so it can change under them. Held while they were live,
        a market that got busy was mapped in hundreds of tiny steps, and the
        page stalled drawing them.
      */
      const want = stepFor(f.sigma, f.price);
      if (!g.drawing) {
        if (g.field === null || Math.abs(Math.log(want / g.marketStep)) > Math.log(1.6)) g.marketStep = want;
        g.step = drawingLayout(g.viewport.width, g.viewport.height, g.marketStep).step;
        // Ink is priced and judged on a grid of the market step, the same on every screen and on chain.
        g.priceStep = gridStep(g.marketStep);
      }
      // The chart is scaled from the prices alone; the map waits for the paths.
      if (!lib) {
        g.field = null;
        return;
      }
      // Use the same fine price slices for every pen.
      const size = g.priceStep * g.cell;
      const key = `${at}:${size}:${level}`;
      // An answer that never came (a worker that died, say) stops holding the next one up after two seconds.
      if (busy && performance.now() - busy > 2000) { busy = 0; asked = ""; }
      if (key !== asked && !busy && w) {
        asked = key;
        busy = performance.now();
        pendingId = ++requestId.current;
        w.postMessage({ kind: "field", id: pendingId, f, at, step: size, cell: g.cell, difficulty: level, least });
      }
    };
    tick();
    // Often, so a second's map is asked for soon after the second is over: the tick itself is a fraction of a millisecond.
    const timer = setInterval(tick, 100);
    // What the stroke being drawn would cost and pay: the terms of the game, read off the map, cheap enough for every move of the pen.
    game.current.quote = (st: Stroke) => {
      const g = game.current;
      if (!g.field) return null;
      const t0 = performance.now();
      const l = areaTerms(g.field, Date.now() + g.skew + g.placeLead, g.drawing?.priceStep ?? g.priceStep, g.drawing?.perDot ?? g.perDot).line(st);
      slow("quote", t0, `points ${l.points.length} pts ${st.pts.length} step ${g.step}`);
      return { multipleLow: l.multipleLow, multipleHigh: l.multipleHigh, cost: l.cost, low: l.low, high: l.high, units: l.units, inPlay: l.inPlay, out: l.out };
    };
    return () => {
      clearInterval(timer);
      w?.removeEventListener("message", onMap);
    };
  }, [connected, lib, level, least]);

  /*
    Every trade: open what is due, judge what is live. Drawings placed
    before a reload come back once there are prices to judge them on; dots
    older than those prices cannot be judged either way, and come back.
  */
  const lines = useRef(new Map<string, Tally>());
  /**
   * Drawings still under the pen: what has been bet of each so far, so the next piece bets only new ink, and on
   * chain the line as it stood at each read since, while its ink is held back (`marks`).
   */
  const drawing = useRef(new Map<string, { prev: Stroke | null; area: number; charged: number; at: number; pieces: number; marks: Stroke[] }>());
  /** What each drawing's hits came to, unrounded, and what has been credited: a drawing rounds its payout once, not once per piece. */
  const payouts = useRef(new Map<string, { raw: number; credited: number }>());
  const tally = (line: string, at: number) => {
    let t = lines.current.get(line);
    if (!t) lines.current.set(line, (t = { at, open: 0, won: 0, cost: 0, hits: 0, points: 0, best: 0 }));
    return t;
  };
  /**
   * A line is over once the pen has lifted, every point of it is decided, and on chain every piece of it has been
   * taken or refused: say what it came to, once. A round's card never has to be taken back.
   */
  const closeLine = (line: string) => {
    const t = lines.current.get(line);
    if (!t || t.open > 0 || drawing.current.has(line)) return;
    for (const sent of chainBets.current.values()) if (sent.line === line && !sent.placed) return;
    lines.current.delete(line);
    const paidOut = payouts.current.get(line);
    payouts.current.delete(line);
    if (paidOut) t.won = paidOut.credited;
    // Paper rounds are counted as such, and kept out of the session's books: those are the player's own.
    const onPaper = paper() !== null && !chainRef.current.real;
    const played = { pen: practice().brush, per_dot: onPaper ? PAPER_PER_DOT : practice().perDot, real: chainRef.current.real, ...(onPaper ? { paper: true } : {}) };
    if (!t.points) {
      track("round_finished", { ...played, voided: true, cost: 0, won: 0, net: 0 });
      return setResult({ key: line, won: 0, cost: 0, hits: 0, points: 0, voided: true });
    }
    track("round_finished", { ...played, voided: false, cost: cents(t.cost), won: cents(t.won), net: cents(t.won - t.cost), hits: t.hits, dots: t.points, hit_share: Math.round((100 * t.hits) / t.points), best: t.best });
    if (!onPaper) record({ id: line, at: t.at, cost: cents(t.cost), won: cents(t.won), hits: t.hits, dots: t.points, best: t.best });
    // Only a round that came out ahead is celebrated, by how much it made; a loss, or breaking even, passes in silence.
    const tier = winTier(cents(t.won), cents(t.cost), t.best);
    if (onPaper) paperRun.current = tier ? paperRun.current + 1 : 0;
    const streak = onPaper ? paperRun.current : scoreboard().streak;
    setResult({ key: line, won: cents(t.won), cost: cents(t.cost), hits: t.hits, points: t.points, voided: false, best: t.best, streak });
    if (!tier) {
      lostLines.current.add(line);
      if (lostLines.current.size > 64) lostLines.current.delete(lostLines.current.values().next().value!);
      setSktNote((n) => (n && n.line === line ? { ...n, lost: true } : n));
    }
    const hit = lastHit.current.get(line);
    lastHit.current.delete(line);
    if (tier) {
      celebrate(tier, Math.max(1, streak));
      setCheer({ key: line, tier });
      // From where the price last met the ink, if that is still on the chart.
      if (hit && performance.now() - hit.at < 20_000) game.current.fx.push({ kind: "burst", t: hit.t, price: hit.price, born: performance.now(), tier });
    } else if (!t.hits) hitRun.current.n = 0;
  };
  /** Bet `i` replaced by what the chain (or a refusal) made of it, the line's books kept right either way. */
  const swap = (i: number, next: InkBet) => {
    const g = game.current;
    if (decided(g.bets[i])) book(lines.current, settledTotals.current, g.bets[i], -1);
    g.bets[i] = next;
    if (decided(next)) book(lines.current, settledTotals.current, next, 1);
  };
  /** Ink that was in play and is not now fades out, and the "+$x" its hits showed goes with it. */
  const fadeOut = (bet: InkBet, cells: Cell[] = bet.status === "opening" ? bet.drawn : bet.cells.filter((c) => !c.expired), only = false) => {
    const g = game.current;
    const line = bet.group ?? bet.id;
    const whole = !only && !g.bets.some((b) => b !== bet && b.status !== "void" && (b.group ?? b.id) === line);
    if (cells.length || whole) (g.gone ??= []).push({ stroke: bet.stroke, cells, edgeCells: bet.edgeCells ?? 0, step: bet.step, born: performance.now(), whole });
    if (g.fx.some((e) => e.piece === bet.id)) g.fx = g.fx.filter((e) => e.piece !== bet.id);
  };
  /** A piece that did not go through, said once for a burst of them, quietly: the soft "nope" only as a burst begins. */
  const sayRefused = (back: number, why: string) => {
    const next = refusals(refusedRef.current, back, why, performance.now());
    if (next.count === 1) feel("nope");
    refusedRef.current = next;
    setRefused(next);
  };
  /** A piece the chain refused, or never answered: its ink is let go and its stake is back. */
  const gate = useGate();
  /** A piece was refused for want of money: offer the deposit sheet once every drawing is settled. */
  const topUp = useRef(false);
  const gateRef = useRef(gate);
  useEffect(() => {
    gateRef.current = gate;
  }, [gate]);
  const letGoRef = useRef<(key: string, why: string) => void>(() => {});
  /*
    A piece turned away for a reason that placed nothing (too late for its
    second, a price that aged on the way, a new difficulty) goes again at
    once, on the next second: the same ink, a fresh quote, a new index. Ink
    that is by then too close to the price stays out, and its stake comes
    back. A refused piece used to leave its ink faint for good: the next
    piece of the line only carries what was drawn after it.
  */
  const resend = useCallback((key: string, why: string): boolean => {
    const g = game.current;
    const ch = chainRef.current;
    const sent = chainBets.current.get(key);
    const quote = feedRef.current.quote;
    if (!sent || sent.tries >= RESENDS || !RESEND.test(why)) return false;
    if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key || !ch.sessionOk) return false;
    const i = g.bets.findIndex((b) => b.id === sent.id);
    // Already opened here, it may be playing: anything but decided goes again.
    if (i < 0 || decided(g.bets[i])) return false;
    const bet = g.bets[i];
    const line = bet.group ?? bet.id;
    const openAt = openFor(Date.now() + g.skew + g.placeLead);
    const drawn = bet.drawn.filter((c) => c.t >= openAt + 1000);
    // The bet's own grid: its cells are one unit tall.
    const unit = bet.step * (bet.cell ?? INK_CELL);
    const sections = toSections(drawn, openAt, toE6(bet.perUnit), unit);
    // What is still ahead of the price must make a piece by itself: under the least, the ink is let go.
    if (!sections.length || stakeOf(sections) < leastPiece(ch.hello)) return false;
    const stakeUsd = Number(stakeOf(sections)) / 1e6;
    const index = RESEND_BASE + resent.current++;
    const next = keyOf(sent.drawing, index);
    const signed = pieceFor(ch, level, sent.drawing, index, openAt, bet.perUnit, unit, quote.message, sections, sent.stroke);
    chainBets.current.delete(key);
    chainBets.current.set(next, { ...sent, id: `${line}:${index}`, openAt, stakeUsd, tries: sent.tries + 1, placed: false, credited: 0 });
    // The first stake back, the second out: only what dropped out shows, as returned. Any hit the first had (it was
    // playing here) is taken back: the seconds it was in are not in the second.
    ch.holds.drop(holdIds.stake(key));
    ch.holds.hold(holdIds.stake(next), -stakeUsd);
    const takenBack = ch.holds.dropAll(holdIds.wins(key));
    const acc = payouts.current.get(line);
    if (acc && bet.status !== "opening") unpay(acc, won(bet), sent.credited);
    g.fx = g.fx.filter((e) => e.piece !== bet.id);
    const back = cents(sent.stakeUsd - stakeUsd - takenBack);
    if (back) addChange(back, back > 0 ? "back" : "stake");
    g.bets[i] = { ...bet, id: `${line}:${index}`, openAt, drawn, charged: stakeUsd, status: "opening", cells: [], why: undefined };
    track("piece_resent", { why: why.slice(0, 120), tries: sent.tries + 1 });
    if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${sent.id} refused (${why}); sent again as ${index}, opening ${openAt}`);
    sendPiece(ch, signed, sent.stroke, quote.signature, (w) => letGoRef.current(next, w));
    updateTotals();
    return true;
  }, [level, updateTotals]);
  /*
    A piece that did not go through: refused by the relayer or the chain, or never answered. It was playing as if
    placed; now its ink fades out, its stake comes back, and whatever its hits paid is taken back, so the balance is
    what it would have been had it never been drawn. One quiet notice says so.
  */
  const letGo = useCallback((key: string, why: string) => {
    const g = game.current;
    if (resend(key, why)) return;
    track("piece_refused", { why: why.slice(0, 120) });
    // Out of money: the deposit sheet, but not while drawings are still in play, which may yet pay (below).
    if (/not enough|balance|allowance/i.test(why)) topUp.current = true;
    const sent = chainBets.current.get(key);
    chainBets.current.delete(key);
    if (!sent) return;
    const ch = chainRef.current;
    const back = -ch.holds.drop(holdIds.stake(key)) || sent.stakeUsd;
    const takenBack = ch.holds.dropAll(holdIds.wins(key));
    const i = g.bets.findIndex((b) => b.id === sent.id);
    if (i >= 0 && g.bets[i].status !== "void") {
      const bet = g.bets[i];
      const acc = payouts.current.get(sent.line);
      if (acc) unpay(acc, won(bet), sent.credited);
      fadeOut(bet);
      swap(i, { ...bet, status: "void", why, cells: [] });
      updateTotals();
    }
    closeLine(sent.line);
    const net = cents(back - takenBack);
    if (net) addChange(net, net > 0 ? "back" : "stake");
    sayRefused(cents(back), why);
    if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${sent.id} not placed: ${why}`);
  }, [updateTotals, resend]);
  useEffect(() => {
    letGoRef.current = letGo;
  }, [letGo]);
  /*
    One tab plays at a time. Two tabs of the game each brought back the
    drawings in play from storage, and each paid their hits: every win in
    play was paid twice. The tab holding the lock restores, judges and
    places; another says so, and can take over.
  */
  // Where the browser cannot lock, this tab plays.
  const [owner, setOwner] = useState<boolean | null>(() => (typeof navigator !== "undefined" && !navigator.locks ? true : null));
  const takeOver = useRef<(() => void) | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return;
    let done = false;
    let release: (() => void) | null = null;
    /*
      Waiting for the lock, not asking only if it is free: a page that is
      remounted (a reload in development, React's double start) asks again
      while its first copy still holds it. Not given it within a moment, it
      says another tab has it; given it later, when that tab closes, it plays.
    */
    let blocked: ReturnType<typeof setTimeout> | undefined;
    const ask = (steal: boolean) => {
      clearTimeout(blocked);
      blocked = setTimeout(() => !done && setOwner((o) => (o ? o : false)), 800);
      return locks
        .request("skech:ink", steal ? { steal: true } : {}, (lock) => {
          clearTimeout(blocked);
          if (done || !lock) return;
          // A new holder starts from what is in storage, as a fresh page does.
          restored.current = false;
          game.current.bets = [];
          setOwner(true);
          return new Promise<void>((r) => (release = r));
        })
        .catch(() => {
          // Taken by another tab: stop, and leave its drawings to it.
          if (done) return;
          game.current.bets = [];
          setOwner(false);
        });
    };
    void ask(false);
    takeOver.current = () => void ask(true);
    return () => {
      done = true;
      clearTimeout(blocked);
      release?.();
    };
  }, []);
  /*
    Run for every trade batch, straight from the feed, not from a render: the screen does not re-render for a
    trade. Everything it reads is in refs or the feed's store, so a callback from an earlier render judges the
    same as a fresh one would; it is made again only when the paths, the tab's ownership or the feed change.
  */
  const judgeTrades = useCallback(() => {
    const { bars, ticks, skew } = feed;
    const g = game.current;
    g.bars = bars;
    g.ticks = ticks;
    g.skew = skew;
    g.displayPrice = ticks.at(-1)?.p ?? bars.at(-1)?.c ?? 0;
    const latest = bars.at(-1);
    if (!latest || !lib || !owner) return;
    const nowMs = Date.now() + skew;
    let credit = 0;
    /** What of `credit` hits paid, for a paper run's "Won". */
    let paidOut = 0;
    if (!restored.current && bars.length > 300) {
      restored.current = true;
      const firstBar = bars[0].t + 5000;
      // Practice drawings come back from storage; real ones live on chain and are not.
      for (const bet of chainRef.current.real ? [] : practice().open) {
        if (bet.openAt >= firstBar) {
          g.bets.push(bet);
          if (!decided(bet)) tally(bet.group ?? bet.id, bet.placedAt).open++;
          continue;
        }
        // Too old to judge: what is still riding on it comes back. Ink already hit was paid when it was.
        credit += bet.status === "opening" ? cost(bet) : bet.perUnit * bet.cells.filter((s) => s.status === "live").reduce((a, s) => a + s.area, 0);
      }
    }
    let changed = false;
    /** Played for real: what the hits of pieces still in the chain's hands paid, held in the balance piece by piece. */
    let held = 0;
    const ch = chainRef.current;
    /** Pieces the chain has not placed in time: let go once this pass is over, as a refusal is. */
    const unanswered: string[] = [];
    /** Pieces still waiting on the chain: kept on the chart, decided or not, until it has said. */
    const waiting = new Set<string>();
    for (const [key, sent] of chainBets.current) {
      if (sent.placed) continue;
      waiting.add(sent.id);
      if (nowMs >= sent.openAt + CHAIN_ANSWER_MS) unanswered.push(key);
    }
    for (let i = 0; i < g.bets.length; i++) {
      let bet = g.bets[i];
      const key = ch.real ? keyOf(drawingIdOf(bet.group ?? bet.id), pieceIndexOf(bet.id)) : "";
      // A piece on its way to the chain plays as if placed.
      const sent = ch.real ? chainBets.current.get(key) : undefined;
      if (bet.status === "opening" && nowMs >= bet.openAt + OPEN_AFTER_MS) {
        // Off its second's map when that is in; on the paths, here, if it is not by the time it has to be.
        const quick = g.field ? openOn(bet, g.field) : null;
        if (!quick && nowMs < bet.openAt + OPEN_BY_MS) {
          g.bets[i] = bet;
          continue;
        }
        const drawn = bet.drawn.length;
        bet = quick ?? openLate(bet, lib, bars);
        // Why part of a stroke is faint rather than solid, when it happens: for finding out, in development only.
        if (process.env.NODE_ENV !== "production" && (bet.status === "void" || bet.cells.length < drawn))
          console.warn(`[ink] piece ${bet.id} opened ${bet.status}: ${bet.status === "void" ? bet.why : `${drawn - bet.cells.length} of ${drawn} sections refused`}`);
        if (sent) {
          // On chain: opened here exactly as the chain opens it, so it is judged from its first second, hits and all,
          // without waiting for the chain. What the chain hands back, and its own bands, come with `placed`; until
          // then nothing is refunded, and ink with nothing in play here waits on the chain's word, faint.
          if (bet.status === "void") bet = { ...bet, status: "live", why: undefined, cells: [] };
        } else {
          const returned = refund(bet);
          credit += returned;
          if (returned > 0) setReturnedInk({ id: bet.id, amount: returned });
          if (bet.status === "void") g.fx.push({ kind: "placed", t: bet.openAt, price: latest.c, born: performance.now() });
        }
        changed = true;
      }
      if (bet.status === "live") {
        const from = Math.min(...bet.cells.filter((d) => d.status === "live").map((d) => d.t));
        // Straight to its first live second: the ten minutes of bars before it were walked on every trade.
        for (let k = firstAtOrAfter(bars, from); k < bars.length; k++) {
          const bar = bars[k];
          const before = bet;
          // From where the second before closed: a jump across the ink crosses it, as the line on the chart does.
          const prev = k > 0 && bars[k - 1].t === bar.t - 1000 ? bars[k - 1].c : undefined;
          bet = judge(bet, bar, bar.t + 1000 + CLOSE_AFTER_MS <= nowMs, prev);
          if (bet === before) continue;
          if (ch.real) bet = lessProfitFee(bet, before, ch.hello?.terms?.profitFeeBps ?? 1000);
          changed = true;
          // One burst a second, however many cells of ink the price crossed in it, with what they paid together.
          const fresh2 = bet.cells.filter((d, k) => d.status === "hit" && before.cells[k].status !== "hit");
          if (fresh2.length) {
            // When the price was found touching the ink, for feel's timing log.
            const seen = performance.now();
            const line = bet.group ?? bet.id;
            const acc = payouts.current.get(line) ?? { raw: 0, credited: 0 };
            payouts.current.set(line, acc);
            // Credit whole cents of the drawing's running total; the fraction waits for its next hit.
            const due = pay(acc, won(bet) - won(before));
            if (sent) {
              // Paid now, as if the piece were placed; held under its name until the chain pays it, or takes it back.
              sent.credited = cents(sent.credited + due);
              ch.holds.hold(holdIds.win(key, bar.t), due);
              held += due;
            } else credit += due;
            paidOut += due;
            // Where it landed, what this hit paid: always a gain. What the
            // drawing came to, win or lose, is the round's card when it ends.
            const paid = Math.floor((won(bet) - won(before)) * 100 + 1e-8) / 100;
            const best = Math.max(...fresh2.map((d) => d.multiple * (isArea(bet.model) ? d.area : 1)));
            const lo = Math.min(...fresh2.map((d) => d.lo));
            const hi = Math.max(...fresh2.map((d) => d.hi));
            // Every hit gets its own toast, sound and touch: each one is a win. Hits judged late, from bars of prices
            // restored after a reload, are paid but not celebrated: ten at once would be noise, not news.
            const fresh3 = nowMs - (bar.t + 1000) < 3000;
            // Every hit pays more than its own ink cost: it is heard and felt the instant it is found, in the same
            // frame as its "+$x". Only the spray waits for the round to be ahead (what it has paid so far is more
            // than everything it has staked); the round's own celebration waits for it to end.
            let stake = lines.current.get(line)?.cost ?? 0;
            for (let j = 0; j < g.bets.length; j++) {
              const b = j === i ? bet : g.bets[j];
              if ((b.group ?? b.id) === line && !decided(g.bets[j])) stake += cost(b) - refund(b);
            }
            const ahead = acc.credited - stake > 0.005;
            const where = { t: fresh2[0].t + 500, price: Math.min(hi, Math.max(lo, bar.c)) };
            if (fresh3) {
              g.fx.push({ kind: "hit", ...where, born: performance.now(), text: paid > 0 ? `+${money(paid)}` : undefined, line, big: best >= 10, profit: ahead, piece: bet.id });
              lastHit.current.set(line, { ...where, at: performance.now() });
            }
            if (fresh3) {
              const run = hitRun.current;
              run.n = performance.now() - run.at < 6000 ? run.n + 1 : 0;
              run.at = performance.now();
              feel(best >= 10 ? "big" : run.n >= 2 ? "run" : "hit", { multiple: best, run: run.n, seen });
            }
          }
          if (bet.status !== "live") break;
        }
      }
      if (decided(bet) && !decided(g.bets[i])) {
        book(lines.current, settledTotals.current, bet, 1);
        const line = bet.group ?? bet.id;
        if ((lines.current.get(line)?.open ?? 0) <= 0) closeLine(line);
      }
      g.bets[i] = bet;
    }
    for (const key of unanswered) {
      if (process.env.NODE_ENV !== "production") console.warn(`[ink] piece ${key} was never placed by the relayer`);
      letGoRef.current(key, "No answer. Your money is back.");
    }
    // Paper ink exists only while signed out with a run on (it is thrown away at sign-in), so its money goes back to the run.
    const onPaper = paper() !== null && !ch.real;
    if (credit) {
      if (ch.real) ch.nudge(credit);
      else if (onPaper) paperCredit(credit, paidOut);
      else setPractice((s) => ({ balance: cents(s.balance + credit) }));
    }
    if (credit + held > 0) {
      setGained(performance.now());
      addChange(cents(credit + held), "win");
    }
    // Practice drawings are kept for a reload; paper ones are not, and must never come back as practice.
    if ((changed || credit) && !ch.real && !onPaper) setPractice({ open: g.bets.filter((b) => !decided(b)) });
    setLive(new Set(g.bets.filter((b) => !decided(b)).map((b) => b.group ?? b.id)).size);
    // Keep finished drawings only as long as their dots are still fading.
    g.bets = g.bets.filter((b) => !decided(b) || b.cells.some((d) => d.t + 3000 > nowMs) || waiting.has(b.id));
    updateTotals();
  }, [feed, lib, owner, updateTotals]);
  useEffect(() => {
    judgeTrades();
    return feed.subscribe(judgeTrades);
  }, [feed, judgeTrades]);

  /*
    Ink is bet as it is drawn: every few moments while the pen is down, the
    ink added since the last piece opens on the next second, priced on what
    is known then. A long stroke is not priced on where the market was when
    the pen lifted, and ink near now is not lost to the wait. The drawing's
    stake rounds up once over its pieces (each piece takes the growth of the
    rounded total), so cost does not depend on how often the pen is read.
  */
  const onPlace = useCallback(
    (stroke: Stroke, line: string, done: boolean): Placed => {
      const g = game.current;
      if (!owner) return "Playing in another tab";
      if (!fresh || !g.field) return "Waiting for live prices";
      const d = drawing.current.get(line) ?? { prev: null, area: 0, charged: 0, at: 0, pieces: 0, marks: [] };
      const finish = () => {
        if (!done) return;
        // On chain: the soft seal as the pen lifts, once a drawing has ink going in. It is played as placed from
        // the start; the chain's own word on it comes later, and only a refusal is heard from it (the soft "nope").
        if (chainRef.current.real && (drawing.current.get(line)?.pieces ?? 0) > 0) sound.placed();
        drawing.current.delete(line);
        closeLine(line);
      };
      const ch = chainRef.current;
      // A paper run takes ink only while its clock runs: at zero the stroke ends where it is, and what is in play settles.
      const onPaper = forReal && !ch.real && paper() !== null;
      if (onPaper && !canDraw(paper(), performance.now())) {
        finish();
        return { stop: "Time’s up" };
      }
      const t0 = performance.now();
      if (!done && t0 - d.at < 150) return null;
      d.at = t0;
      const settings = g.drawing ?? { step: g.step, priceStep: g.priceStep, perDot: g.perDot };
      const placedAt = Date.now() + g.skew;
      const now: Stroke = { ...stroke, pts: stroke.pts.slice() };
      if (forReal && !ch.real && !onPaper) return ch.player ? "Connecting…" : "Sign in to play";
      if (ch.real && !ch.sessionOk) return "Getting ready, one moment";
      /*
        On chain each piece is a transaction the relayer pays for, and only a stake of about 10¢ pays its gas
        back. Ink is held back, drawn as it is, and sent in pieces of 10¢ (`cutAt`), each up to a read with at
        least the relayer's least (1¢) drawn after it: when the pen lifts, that end goes as a piece of its own,
        and a whole line goes if it reaches the least. The relayer limits each player's pieces under 10¢.
      */
      const minStake = ch.real ? leastPiece(ch.hello) : 0n;
      const batch = minStake > BATCH_PIECE_STAKE_E6 ? minStake : BATCH_PIECE_STAKE_E6;
      const hold = () => {
        d.marks.push(now);
        if (d.marks.length > MARKS) d.marks.shift();
        drawing.current.set(line, d);
        return null;
      };
      let snap = now;
      let cut = -1;
      if (ch.real && !done) {
        const at = openFor(placedAt + g.placeLead);
        cut = cutAt(d.prev, d.marks, now, (st) => (st ? inkArea(st, at, settings.priceStep) : 0), toE6(settings.perDot), batch, minStake);
        if (cut < 0) return hold();
        snap = d.marks[cut];
      }
      // On chain a piece drawn in the last moments of a second opens on the one after, so it is never late.
      const bet = placeInk(snap, d.prev, settings.perDot, settings.priceStep, placedAt + g.placeLead, `${line}:${d.pieces}`, line, INK_EDGE_CELLS);
      if (!bet) {
        if (cut >= 0) return hold();
        finish();
        return done && !d.pieces ? "Draw ahead of the wait line" : null;
      }
      const area = d.area + bet.drawn.reduce((n, c) => n + c.area, 0);
      let charge = cents(areaCostOf(settings.perDot, area) - d.charged);
      if (ch.real) {
        // The chain takes the stake exactly, in millionths: no rounding to the cent.
        const unit = unitFor(g.marketStep);
        const sections = toSections(bet.drawn, bet.openAt, toE6(settings.perDot), unit);
        const stake = stakeOf(sections);
        if (!sections.length) {
          if (cut >= 0) return hold();
          finish();
          return done && !d.pieces ? "Draw ahead of the wait line" : null;
        }
        if (stake < (done ? minStake : batch)) {
          if (!done) return hold();
          finish();
          // The whole line too little to send: nothing is placed or charged. The end of a placed line falls
          // short only if its held ink went behind the wait line before the pen lifted.
          return d.pieces ? null : `Draw a little more: at least ${usdE6(minStake)} a line`;
        }
        charge = Number(stake) / 1e6;
        if (charge > ch.balance) {
          finish();
          // The line ends here: nothing further of it can go in. Some money, just not this much: the way out is
          // a smaller price per dot (a long line on a big screen is many dots), not the deposit sheet.
          track("balance_ran_out", { per_dot: settings.perDot, pieces: d.pieces, balance: ch.balance });
          // Not enough for a piece at all: the deposit sheet once this drawing and any others are settled.
          const enough = ch.balance >= Number(minStake) / 1e6;
          if (!enough) topUp.current = true;
          return { stop: enough ? "Balance used up here · lower the price per dot" : "Not enough USDC in the game" };
        }
        const quote = feedRef.current.quote;
        if (!quote?.message || !quote.signature || !ch.hello || !ch.player || !ch.key) {
          finish();
          return "Waiting for a signed price";
        }
        const drawing = drawingIdOf(line);
        const key = keyOf(drawing, d.pieces);
        const from = d.prev?.pts.length ?? 0;
        const stroke = bytesOf(encodeStroke({ t0: snap.t0, p0: snap.p0, rt: snap.rt, rp: snap.rp, from, pts: snap.pts.slice(from) }));
        const signed = pieceFor(ch, level, drawing, d.pieces, bet.openAt, settings.perDot, unit, quote.message, sections, stroke);
        chainBets.current.set(key, { id: bet.id, line, openAt: bet.openAt, stakeUsd: charge, drawing, stroke, tries: 0, placed: false, credited: 0 });
        // Out of the balance now, as placed; held under the piece's name until the chain takes it, or gives it back.
        ch.holds.hold(holdIds.stake(key), -charge);
        sendPiece(ch, signed, stroke, quote.signature, (why) => letGo(key, why));
      }
      // Paper money runs out as real money does: the line ends where it can no longer be paid for.
      if (onPaper && !paperDebit(charge)) {
        finish();
        return { stop: "Paper money used up" };
      }
      bet.charged = charge;
      addChange(-charge, "stake");
      if (!drawing.current.has(line)) drawing.current.set(line, d);
      d.prev = snap;
      if (cut >= 0) d.marks = [...d.marks.slice(cut + 1), now];
      d.area = area;
      d.charged = cents(d.charged + charge);
      d.pieces++;
      if (d.pieces === 1 && onPaper) paperDrew();
      // The first drawing this browser ever places: where the way in ends and playing starts. Not a paper one.
      if (d.pieces === 1 && !onPaper) {
        try {
          if (!localStorage.getItem("skech:first-drawing")) {
            localStorage.setItem("skech:first-drawing", "1");
            track("first_drawing", { real: ch.real });
          }
        } catch {}
      }
      if (!g.bets.some(b => !decided(b))) settledTotals.current = { committed: 0, returned: 0 };
      tally(line, bet.placedAt).open++;
      g.bets.push(bet);
      updateTotals();
      if (process.env.NODE_ENV !== "production") (window as unknown as { __lastBet?: unknown }).__lastBet = bet;
      // On chain the hint is all practice keeps: written once, as each write re-rendered everything that reads it.
      if (ch.real || onPaper) {
        if (!practice().taught) setPractice({ taught: true });
      } else setPractice(st => ({ balance: cents(st.balance - charge), taught: true, open: g.bets.filter(b => !decided(b)) }));
      setLive(new Set(g.bets.filter(b => !decided(b)).map(b => b.group ?? b.id)).size);
      if (done) {
        const tip = stroke.pts.at(-1)!;
        g.fx.push({ kind: "placed", t: stroke.t0 + tip.t, price: stroke.p0 + tip.p, born: performance.now() });
      }
      finish();
      return null;
    },
    [fresh, owner, updateTotals, level, letGo],
  );

  /*
    What the chain says: a piece placed (its bands, as priced there), refused,
    or settled. The ink was drawn, opened, judged and paid as if it would go
    in; here it is made to match what did, the balance with it, eased rather
    than jumped wherever the two differ.
  */
  useEffect(() => {
    if (!real) return;
    const g = game.current;
    const feeBps = () => chainRef.current.hello?.terms?.profitFeeBps ?? 1000;
    /** The chain moved what a piece's hits pay by `bySecond`: paid into (or out of) the balance in whole cents, as hits are. */
    const repay = (key: string, sent: SentPiece, bySecond: Map<number, number>, landed: boolean) => {
      const ch = chainRef.current;
      const acc = payouts.current.get(sent.line) ?? { raw: 0, credited: 0 };
      payouts.current.set(sent.line, acc);
      for (const [t, usd] of bySecond) {
        const due = pay(acc, usd, true);
        if (!due) continue;
        sent.credited = cents(sent.credited + due);
        ch.holds.hold(holdIds.win(key, t), due);
        if (landed) ch.holds.land(holdIds.win(key, t));
      }
    };
    const off = chain.client.on((m) => {
      if (m.type === "placed") {
        const key = keyOf(m.drawing, m.index);
        const sent = chainBets.current.get(key);
        if (!sent) return;
        const ch = chainRef.current;
        betKeys.current.set(m.betId, key);
        const staked = Number(m.staked) / 1e6;
        // Taken: the stake the chain took is out of its balance now, and its next word says so.
        ch.holds.land(holdIds.stake(key), -staked);
        const before = sent.stakeUsd;
        Object.assign(sent, { placed: true, stakeUsd: staked });
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return closeLine(sent.line);
        const bet = g.bets[i];
        const bands = m.sections.map((s) => ({ second: s.second, lo: fromE8(BigInt(s.lo)), hi: fromE8(BigInt(s.hi)), stake: Number(s.stake) / 1e6, rung: s.rung }));
        const { bet: next, bySecond } = confirmPiece(bet, bands, staked, feeBps());
        const credited = sent.credited;
        repay(key, sent, bySecond, false);
        if (next.status === "void") {
          // The chain placed none of it: to the player, the same as a refusal. Its hits and their taking back
          // cancel out, and are let go together.
          chainBets.current.delete(key);
          betKeys.current.delete(m.betId);
          ch.holds.dropAll(holdIds.wins(key));
          fadeOut(bet);
          swap(i, next);
          const net = cents(before - (credited - sent.credited));
          if (net) addChange(net, net > 0 ? "back" : "stake");
          sayRefused(cents(before), next.why ?? "");
        } else {
          swap(i, next);
          // What the chain did not take is back.
          if (before > staked + 1e-9) {
            addChange(cents(before - staked), "back");
            setReturnedInk({ id: sent.id, amount: cents(before - staked) });
          }
        }
        closeLine(sent.line);
        updateTotals();
      } else if (m.type === "account") {
        // Nothing on its way to the chain or waiting on it: the relayer's balance is exact, and the app's own
        // reckoning since is let go. While anything is in flight it is kept, so a stake shows the moment it goes.
        if (chainBets.current.size === 0) chainRef.current.resync();
      } else if (m.type === "refused") {
        letGo(keyOf(m.drawing, m.index), m.why);
      } else if (m.type === "settled") {
        // The chain's word on hits and misses, where it differs from what was judged here, or before it was.
        const key = betKeys.current.get(m.betId);
        const sent = key ? chainBets.current.get(key) : undefined;
        if (!sent || !key) return;
        // What its misses minted, added to the round's.
        const minted = Number(m.minted ?? 0);
        if (minted > 0) {
          const total = (mintedBy.current.get(sent.line) ?? 0) + minted;
          mintedBy.current.set(sent.line, total);
          if (mintedBy.current.size > 64) mintedBy.current.delete(mintedBy.current.keys().next().value!);
          setSktNote({ line: sent.line, skt: total, lost: lostLines.current.has(sent.line) });
        }
        const ch = chainRef.current;
        const i = g.bets.findIndex((b) => b.id === sent.id);
        if (i < 0) return;
        // Bands whose bar was never posted: given their stake back on chain, so out of play here too.
        const expired = expireCells(g.bets[i], m.expiredMask ?? 0);
        const bet = expired.bet;
        let changed = expired.gone.length > 0;
        let disagreed = 0;
        /** What the chain's word changes this piece's hits by, by second. */
        const bySecond = new Map<number, number>();
        const moved = (t: number, usd: number) => bySecond.set(t, (bySecond.get(t) ?? 0) + usd);
        for (const c of expired.gone) if (c.status === "hit") moved(c.t, -(c.paid ?? 0));
        /** The seconds this settlement decided: what the screen paid for them, the chain has now paid too. */
        const seconds = new Set<number>();
        const cells = bet.cells.map((c, k) => {
          const hit = (m.hitMask >> k) & 1;
          const miss = (m.missMask >> k) & 1;
          if (!hit && !miss) return c;
          seconds.add(c.t);
          const status = hit ? ("hit" as const) : ("miss" as const);
          if (c.status === status) return c;
          changed = true;
          if (c.status !== "live") disagreed++;
          // The screen paid a hit the chain calls a miss, or missed one it calls a hit: the balance follows the chain.
          const paid = hit ? paidOnChain(bet.perUnit * c.area, c.multiple, feeBps()) : undefined;
          moved(c.t, (paid ?? 0) - (c.paid ?? 0));
          return { ...c, status, paid };
        });
        for (const c of expired.gone) seconds.add(c.t);
        if (changed) {
          swap(i, { ...bet, cells, status: cells.every((c) => c.status !== "live") ? "done" : "live" });
          if (expired.back > 0) {
            ch.holds.land(holdIds.back(key), expired.back);
            addChange(cents(expired.back), "back");
            fadeOut(g.bets[i], expired.gone, true);
          }
          // The chain deciding first is normal; the chain deciding otherwise is worth knowing about.
          if (disagreed) track("judge_disagreed", { bands: disagreed });
          if (disagreed && process.env.NODE_ENV !== "production") console.warn(`[ink] the chain judged ${disagreed} band${disagreed > 1 ? "s" : ""} of ${bet.id} otherwise: hits ${m.hitMask.toString(2)} misses ${m.missMask.toString(2)}`);
          updateTotals();
        }
        repay(key, sent, bySecond, true);
        for (const t of seconds) ch.holds.land(holdIds.win(key, t));
        // Decided here, or closed on chain: nothing more will come for it.
        if (decided(g.bets[i]) || m.closed) {
          ch.holds.landAll(holdIds.wins(key));
          chainBets.current.delete(key);
          betKeys.current.delete(m.betId);
        }
        closeLine(sent.line);
        // No account asked for here: the relayer sends it after every payout, and at least every few seconds of
        // settlements, so what nothing is waiting on is resynced.
      }
    });
    return () => {
      off();
    };
  }, [real, chain.client, letGo, updateTotals]);

  // For tuning, in development or with ?house as the house's controls: stage a finished round from the console, card,
  // sound, touch, confetti and all, from where the price is now. Nothing is paid.
  useEffect(() => {
    if (!house) return;
    (window as unknown as { __round?: unknown }).__round = (won: number, cost = 1, best = 4, streak = 0) => {
      const key = crypto.randomUUID();
      setResult({ key, won, cost, hits: won > 0 ? 1 : 0, points: 2, voided: false, best, streak });
      const tier = winTier(won, cost, best);
      if (!tier) return;
      celebrate(tier, Math.max(1, streak));
      setCheer({ key, tier });
      setGained(performance.now());
      addChange(cents(won - cost), "win");
      const g = game.current;
      const now = Date.now() + g.skew;
      g.fx.push({ kind: "burst", t: now - 1000, price: g.displayPrice, born: performance.now(), tier });
    };
  }, [house]);
  /*
    For tuning, in development or with ?house: what a piece the chain turns away looks like, on the newest drawing
    still in play here, from the console. Its ink fades, its stake comes back and its hits are taken back, as a real
    refusal's are; in practice the money is practice money.
  */
  useEffect(() => {
    if (!house) return;
    (window as unknown as { __refuse?: unknown }).__refuse = (why = "Too many small pieces; draw a longer line") => {
      const g = game.current;
      let i = -1;
      for (let j = g.bets.length - 1; j >= 0; j--) if (!decided(g.bets[j])) { i = j; break; }
      if (i < 0) return "Nothing in play";
      if (chainRef.current.real) {
        const bet = g.bets[i];
        letGoRef.current(keyOf(drawingIdOf(bet.group ?? bet.id), pieceIndexOf(bet.id)), why);
        return bet.id;
      }
      const bet = g.bets[i];
      const line = bet.group ?? bet.id;
      const acc = payouts.current.get(line);
      const credited = Math.floor(won(bet) * 100 + 1e-8) / 100;
      if (acc) unpay(acc, won(bet), credited);
      const back = cents(cost(bet) - refund(bet));
      fadeOut(bet);
      swap(i, { ...bet, status: "void", why, cells: [] });
      const onPaper = paper() !== null;
      if (onPaper) paperCredit(cents(back - credited), -credited);
      else setPractice((s) => ({ balance: cents(s.balance + back - credited), open: g.bets.filter((b) => !decided(b)) }));
      addChange(cents(back - credited), back >= credited ? "back" : "stake");
      sayRefused(back, why);
      closeLine(line);
      updateTotals();
      return bet.id;
    };
  });
  // For tests in development: place a line from the console, as the pen does.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") (window as unknown as { __place?: typeof onPlace }).__place = onPlace;
  }, [onPlace]);

  /*
    The paper run's clock: moved on a few times a second, with whether any of its ink is still out, so at zero
    it stops taking ink, waits for what is in play to settle, and shows the end card once it has. A hidden tab
    stops the clock where it is, and it goes on from there when the tab is back: thirty seconds on screen.
  */
  useEffect(() => {
    if (!paperOn) return;
    const tick = () => paperTick(game.current.bets.some((b) => !decided(b)) || drawing.current.size > 0);
    const shown = () => (document.visibilityState === "hidden" ? pausePaperRun() : resumePaperRun());
    shown();
    tick();
    const timer = setInterval(tick, 200);
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [paperOn]);
  useEffect(() => {
    if (paperPhase !== "over") return;
    const run = paper();
    if (run) track("paper_ended", { pnl: paperResult(run, money).pnl, drawings: run.drawings, ended: "time" });
  }, [paperPhase]);
  /*
    Signing in, during a run or after it, ends it: the paper ink still out is thrown away here, unpaid, so none
    of it is ever judged or paid once the real balance has taken over. Signed out there is nothing else on the
    chart to keep.
  */
  useEffect(() => {
    const run = paper();
    if (!me.signedIn || !run) return;
    if (run.phase !== "over") track("paper_ended", { pnl: paperResult(run, money).pnl, drawings: run.drawings, ended: "signed_in" });
    game.current.bets = [];
    lines.current.clear();
    drawing.current.clear();
    payouts.current.clear();
    settledTotals.current = { committed: 0, returned: 0 };
    // What is in play is counted again on the next trade, from the chart now emptied.
    updateTotals();
    endPaperRun();
  }, [me.signedIn, updateTotals]);
  const startPaper = (again: boolean) => {
    track(again ? "paper_again" : "paper_started");
    setResult(null);
    startPaperRun();
  };

  /* A light touch as the ink reaches each new spot; the pen's own scratch comes from the stage. */
  const painted = useRef(0);
  const onPreview = useCallback((p: Preview | null) => {
    preview.set(p);
    setPreviewing(p !== null);
    const n = p?.inPlay.length ?? 0;
    if (!p?.keyboard && n > painted.current) feel("tick");
    painted.current = n;
  }, [preview]);

  const onboarding = useOnboarding(live);
  /*
    The game plays on for everyone; a tap from someone who cannot play yet opens the way to: Privy's sign-in
    signed out, the deposit sheet with less in the balance than one piece stakes (1¢). It never reaches the
    chart, so no ink is drawn that could not be placed.
  */
  const leastUsd = Number(leastPiece(chain.hello)) / 1e6;
  const cannotPlay: "signin" | "deposit" | null = !forReal || !me.ready ? null : !me.signedIn ? (paperOn ? null : "signin") : real && chain.account !== null && chain.balance < leastUsd && live === 0 ? "deposit" : null;
  const onGate = (e: React.PointerEvent) => {
    if (!cannotPlay || owner === false) return;
    // A button or link over the game (a card's action) is not a tap on the game.
    if ((e.target as Element).closest("button, a")) return;
    e.preventDefault();
    e.stopPropagation();
    // Felt and heard, not just a sheet appearing: the short low double note and a double tap under the finger.
    feel("nope");
    if (cannotPlay === "signin") gate.openSignIn("tap");
    else gate.openDeposit("tap");
  };
  /*
    The deposit sheet after running out, only when the game has nothing left to say: no drawing still in play
    (one of them may yet win the balance back), and still not enough for a single piece. A win cancels it.
  */
  useEffect(() => {
    if (!topUp.current || !real || chain.account === null || live > 0) return;
    topUp.current = false;
    if (chain.balance < leastUsd) gate.openDeposit("short");
  }, [live, real, chain.account, chain.balance, gate, leastUsd]);
  // No deposit sheet on arrival: the game is there to look at and try first. With nothing to play with, the
  // "Deposit USDC to play" line says so, and a tap on the game (or Deposit) opens the sheet.
  /*
    Until the game can be played the screen says one thing. Signed out: the way in, over the game blurred.
    Signed in: one "Connecting…" until the prices and the account are both here, not one in the header,
    one in a pill and one on the chart.
  */
  const signedOut = onboarding.step === "signin";
  // On a phone's browser, the Home Screen bar sits in the gap over the dock, and the chart gives up a little for it.
  const home = useHomeScreen();
  // Not while signed out: the blur covers it there, and its cross could not be reached.
  const homeBar = home.showing && !signedOut;
  const connecting = !signedOut && (!fresh || onboarding.step === "connecting");
  const [boardOpen, setBoardOpen] = useState(false);
  const board = useScoreboard();
  // The same Skech controls: nib size and the cost of a full dot.
  const controls = (
    <InkControls
      amount={paperOn ? PAPER_PER_DOT : state.perDot}
      className="w-full sm:w-auto"
      fixed={paperOn}
      onAmount={(n) => {
        if (n !== state.perDot) track("price_changed", { per_dot: n });
        setPractice({ perDot: n });
      }}
      onPen={(id) => {
        if (id !== state.brush) track("pen_changed", { pen: id });
        setPractice({ brush: id });
      }}
      pen={state.brush}
    />
  );

  /**
   * The round just over. A win is celebrated: card, chord, touch. A loss is said once, quietly, in the same
   * place and in muted ink, with no sound or touch, and gets out of the way sooner.
   */
  const over = result && !result.voided && result.cost > 0 ? result : null;
  const overNet = over ? cents(over.won - over.cost) : 0;
  const overWon = overNet > 0;
  const overBig = over ? overWon && (over.won >= over.cost * 3 || (over.best ?? 0) >= 10) : false;
  // What has been won, never what has been lost: this round's payouts while ink is in play, the session's
  // between rounds. The balance beside it is always the exact truth. A tap opens the scoreboard.
  const showingBatch = totals.batch;
  const displayedWon = forReal && !real ? 0 : showingBatch ? totals.returned : board.won;

  return (
    <section aria-label="Draw" className={cn(feedback.surface, "relative isolate min-h-0 flex-1 overflow-hidden bg-background")}>
      <div className={feedback.topShade} aria-hidden="true" />
      <div className={feedback.summary}>
        <div className={feedback.market}>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" aria-label="Change asset: Bitcoin" className={feedback.assetButton} />}>
              <TokenAvatar symbol="BTC" className="size-9 sm:size-10" />
              <span className={feedback.marketName}><span>Bitcoin <ChevronDownIcon className="size-3" strokeWidth={2.4} /></span><strong className="figures"><LivePrice feed={feed} /></strong></span>
            </PopoverTrigger>
            <PopoverPopup align="start" sideOffset={10} className="w-64">
              <PopoverTitle>Choose asset</PopoverTitle>
              <PopoverClose render={<Button variant="ghost" className="mt-3 h-14 w-full justify-start px-2" />} aria-label="Bitcoin, selected">
                <TokenAvatar symbol="BTC" className="size-8" /><span className="flex flex-col items-start"><span>Bitcoin</span><span className="text-xs text-muted-foreground">BTC / USD</span></span><CheckIcon className="ml-auto text-primary" />
              </PopoverClose>
            </PopoverPopup>
          </Popover>
        </div>
        {/* Signed out there is no balance to show, and connecting it is not known yet: $0.00 twice is noise. A paper run shows its own. */}
        {paperOn && !me.signedIn ? <PaperMoney gained={gained > 0} /> : forReal && (!me.ready || !me.signedIn || onboarding.step === "connecting") ? null : (
        <div className={feedback.accounts}>
          {/* The one balance on screen. Playing for real it opens the wallet: deposit, withdraw. */}
          {real ? (
            <WalletButton render={<button aria-label={`Balance ${money(chain.balance)}. Deposit or withdraw`} className={cn(feedback.balance, feedback.tappable)} type="button" />}>
              <span className={feedback.eyebrow}>Balance</span>
              <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}><RisingMoney format={money} value={chain.balance} /></span>
              <Ledger />
            </WalletButton>
          ) : (
            <div className={feedback.balance} aria-label={forReal ? "Balance" : "Practice balance"}>
              <span className={feedback.eyebrow}>Balance</span>
              <span className={cn(feedback.balanceValue, "figures", gained ? "text-success-foreground" : "text-foreground")}>{forReal ? <RisingMoney format={money} value={chain.balance} /> : <PracticeBalance crisp />}</span>
              <Ledger />
            </div>
          )}
          <div className={feedback.pnlColumn}>
            <button aria-label={`Won ${showingBatch ? "this round" : "this session"}: ${money(displayedWon)}. Open the scoreboard`} className={feedback.pnl} onClick={() => setBoardOpen(true)} type="button">
              <span className={feedback.eyebrow}>Won</span>
              <span className={cn(feedback.pnlValue, "figures", displayedWon > 0 ? "text-success-foreground" : "text-foreground")}>
                <CrispNumber value={displayedWon > 0 ? `+${money(displayedWon)}` : money(0)} />
              </span>
            </button>
          </div>
        </div>
        )}
      </div>

      <div className="absolute inset-0" onPointerDownCapture={onGate} style={homeBar ? { bottom: homeBarRoom(window.innerWidth) } : undefined}>
          {/* From the start, not once the paths are in: the price draws as soon as it comes, the tiles once there is a map. */}
          <HapticHost className="absolute inset-0">
            <Stage onViewport={onViewport} className="absolute inset-0 size-full" game={game} onPlace={onPlace} onPreview={onPreview} />
          </HapticHost>
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-3">
            <PresenceRail />
          </div>
          {owner === false ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm" role="status">
              <p className="text-sm text-muted-foreground">The game is open in another tab.</p>
              <Button onClick={() => takeOver.current?.()}>Play here</Button>
            </div>
          ) : null}
          {connecting && owner !== false ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
              <p className="flex items-center gap-2 font-semibold text-[15px] text-muted-foreground"><Spinner className="size-4" /> Connecting…</p>
            </div>
          ) : null}

          {paperOn && owner !== false ? <PaperClock /> : null}
          {previewing ? (
            <PreviewPill className={paperOn ? feedback.belowClock : undefined} preview={preview} />
          ) : paperOn ? (
            !state.taught && fresh && owner !== false && paperPhase === "running" ? <div className={cn(feedback.hintPill, feedback.belowClock)}>Draw to the right of the line</div> : null
          ) : signedOut || connecting ? null : onboarding.step && owner !== false ? (
            <Onboarding {...onboarding} />
          ) : !state.taught && fresh && owner !== false ? (
            <div className={feedback.hintPill}>Draw to the right of the line</div>
          ) : null}

          {/* The round just over: a win celebrated, a big one more so; a loss said once, quietly. */}
          {over && !previewing ? (
            <div className={cn(feedback.roundCard, overWon ? feedback.roundWin : feedback.roundLoss, overBig && feedback.roundBig)} key={over.key} role="status">
              {overWon && (over.streak ?? 0) >= 2 ? <span className={feedback.streak}>{over.streak} in a row</span> : null}
              <div>
                <span className={feedback.roundLabel}>{overWon ? (overBig ? "Big win" : "You won") : "Round over"}</span>
                <span className={cn(feedback.roundValue, overWon ? "text-success-foreground" : "text-muted-foreground")}>{signed(overNet)}</span>
                <span className={cn(feedback.roundDetail, "figures")}>
                  {over.points ? `${Math.round((100 * over.hits) / over.points)}% of your ink hit` : ""}
                  {over.best ? ` · best ${fmtMultiple(over.best)}` : ""}
                  {!overWon && sktNote?.line === over.key ? ` · +${sktAmount(sktNote.skt)} SKT` : ""}
                </span>
              </div>
            </div>
          ) : null}
      </div>

      {refused && !previewing && !over ? (
        <div key={`refused:${refused.id}`} role="status" className={feedback.bottomPill}>{refusalLine(refused)} · <span className="figures font-semibold text-foreground">{money(refused.back)} back</span></div>
      ) : sktNote?.lost && !previewing && !over ? (
        <div key={`skt:${sktNote.line}`} role="status" className={feedback.bottomPill}><span className="figures">+{sktAmount(sktNote.skt)} SKT</span></div>
      ) : returnedInk && !previewing && !over ? (
        <div key={returnedInk.id} role="status" className={feedback.bottomPill}>Unpriced ink · <span className="figures font-semibold text-foreground">{money(returnedInk.amount)} refunded</span></div>
      ) : null}
      <div className={feedback.bottomShade} aria-hidden="true" />
      {homeBar ? <HomeScreenBar dismiss={home.dismiss} install={home.install} /> : null}
      <UpdateReady busy={live > 0} />
      <HomeScreenSheet open={home.open} setOpen={home.setOpen} where={home.where} />
      <footer className={feedback.toolbar}>
        <Button aria-label="Settings" aria-haspopup="dialog" className={feedback.settingsButton} onClick={() => setSettingsOpen(true)} size="icon" variant="outline"><SlidersHorizontalIcon strokeWidth={1.8} /></Button>
        {controls}
      </footer>

      {/* Signed out: the game plays on behind, blurred. Signing in is the way to play; a tap anywhere opens it. Or
          thirty seconds on paper money first, to feel the game before signing in for it. */}
      {signedOut && owner !== false && !paperOn ? (
        <div className={cn(feedback.notice, "absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-background/30 backdrop-blur-md")} onClick={() => gate.openSignIn("overlay")}>
          <Button className="h-12 w-64 rounded-full px-6 font-semibold text-base sm:h-12">Sign in to play</Button>
          <Button
            className="h-12 w-64 rounded-full px-6 font-semibold text-base sm:h-12"
            onClick={(e) => {
              e.stopPropagation();
              startPaper(false);
            }}
            variant="secondary"
          >
            Try it free · 30 seconds
          </Button>
        </div>
      ) : null}
      {paperOn && owner !== false ? <PaperEnd onAgain={() => startPaper(true)} onSignIn={() => gate.openSignIn("paper")} /> : null}

      <Sheet onOpenChange={setSettingsOpen} open={settingsOpen}>
        <SheetPopup className="sm:max-w-sm" side="right" variant="inset">
          <SheetHeader className="px-4 pt-6 sm:px-6 sm:pt-8"><SheetTitle className="font-bold text-xl">Settings</SheetTitle><SheetDescription className="sr-only">Sound, haptics, your balance and your drawings</SheetDescription></SheetHeader>
          <SheetPanel className="flex flex-col gap-3.5 px-4 pb-10 sm:px-6">
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <ToggleRow checked={state.sound} detail="Pen, hits and round results" onChange={(on) => setPractice({ sound: on })} title="Sounds" />
              <ToggleRow checked={state.haptics} detail="A tap when ink goes in and when it hits" onChange={(on) => setPractice({ haptics: on })} title="Haptics" />
              <ToggleRow checked={dark} detail="Black paper, brighter ink" onChange={setDark} title="Dark mode" />
            </div>
            {forReal ? (
              <div className="flex min-h-[60px] items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2"><div className="flex flex-col"><span className="text-[13px] text-muted-foreground">Balance</span><span className="figures font-semibold text-[17px]">{money(chain.balance)}</span></div>{real ? <span className="text-right text-xs text-muted-foreground">Add or withdraw from your balance, top right</span> : <SignInButton />}</div>
            ) : (
              <div className="flex min-h-[60px] items-center justify-between gap-3 rounded-[14px] bg-muted px-4 py-2"><div className="flex flex-col"><span className="text-[13px] text-muted-foreground">Practice balance</span><span className="figures font-semibold text-[17px]"><PracticeBalance /></span></div><DepositButton className="bg-raised" onDeposit={amount => setPractice(st => ({ balance: cents(st.balance + amount) }))} /></div>
            )}
            <div className="divide-y divide-border overflow-hidden rounded-[14px] bg-muted">
              <button className={navRow} onClick={() => { setSettingsOpen(false); setBoardOpen(true); }} type="button">This session<span className={cn("figures ml-auto", board.won > 0 ? "text-success-foreground" : "text-muted-foreground")}>{board.won > 0 ? `+${money(board.won)} won` : ""}</span><ChevronRightIcon className="size-4 text-faint" /></button>
              <button className={cn(navRow, "max-sm:hidden")} onClick={() => void expand()} type="button">{fullscreen ? "Exit full screen" : "Full screen"}<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
              <button className={navRow} onClick={() => { setSettingsOpen(false); setHelp(true); }} type="button">How it works<ChevronRightIcon className="ml-auto size-4 text-faint" /></button>
            </div>
          </SheetPanel>
        </SheetPopup>
      </Sheet>

      <ScoreboardSheet onOpenChange={setBoardOpen} open={boardOpen} />


      <Sheet onOpenChange={setHelp} open={help}>
        <SheetPopup className="sm:max-w-md" side="right" variant="inset">
          <SheetHeader className="px-6 pt-8">
            <SheetTitle className="font-bold text-xl">How it works</SheetTitle>
            <SheetDescription>{howItWorksSummary({ mode: helpMode, network: chain.hello?.label ?? NETWORK.label })}</SheetDescription>
          </SheetHeader>
          <SheetPanel className="flex flex-col gap-6 px-6 pb-8 text-sm leading-relaxed">
            {howItWorks({ mode: helpMode, terms: chain.hello?.terms, difficulty: helpMode === "real" ? chain.hello?.difficulty ?? level : level, horizon: RULES.horizon, network: chain.hello?.label ?? NETWORK.label, testMoney: (chain.hello ? chain.hello.faucet : NETWORK.faucet) !== null, device: "browser" }).map((section) => (
              <section className="flex flex-col gap-1.5" key={section.title}>
                <h3 className="font-semibold text-[15px]">{section.title}</h3>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {section.lines.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </section>
            ))}
            {house && !forReal ? (
              <div className="flex flex-col gap-3 rounded-[14px] bg-muted p-4">
                <div className="flex items-baseline justify-between">
                  <p className="font-medium">Difficulty</p>
                  <p className="figures font-semibold text-lg">
                    {level}
                    {state.houseDifficulty === null ? <span className="font-normal text-muted-foreground text-xs"> default</span> : null}
                  </p>
                </div>
                <Slider aria-label="Difficulty" max={100} min={MIN_DIFFICULTY} onValueChange={(v) => setPractice({ houseDifficulty: Array.isArray(v) ? v[0] : v })} step={5} value={level} />
                <p className="figures text-muted-foreground text-xs">
                  Best ink {Math.round(difficulty(level).ladderBest * 100)}¢ a dollar · pays 1× to 128× · momentum margin {difficulty(level).momentumMargin}
                </p>
                <p className="text-muted-foreground text-xs">For the house, while it is practice money. Drawings already open keep what they opened on.</p>
                {state.houseDifficulty !== null ? (
                  <Button className="self-start" onClick={() => setPractice({ houseDifficulty: null })} size="sm" variant="ghost">
                    Back to the game&rsquo;s default, {DIFFICULTY}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </section>
  );
}

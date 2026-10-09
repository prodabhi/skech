/**
 * The relayer's side of the social service: a worker started beside the game (worker.ts), told each placement with
 * its stroke and each settlement, by message. Telling it is a postMessage, never awaited: the database never holds
 * up a drawing, and a worker that stops is forgotten while the game goes on.
 *
 * The worker gets only the settings it reads, not the relayer's environment: no key of the relayer's is in it.
 */
import type { Placement, Settlement } from "./store";
import type { IndexerConfig } from "./solana-indexer";

/** What the worker is given of process.env. */
const KEYS = ["SOCIAL_DATABASE_URL", "SOCIAL_ALLOWED_ORIGINS", "SOCIAL_PORT", "SOCIAL_HOST"] as const;

export type BridgePlaced = { betId: string; player: string; drawing: string; openAt: bigint; staked: bigint; unit?: bigint; stroke?: string; sections: { second: number; lo: bigint; hi: bigint; stake: bigint; rung: number }[]; tx: string };
export type BridgeSettled = { betId: string; player: string; hitMask: number; missMask: number; expiredMask?: number; paid: bigint; owed: bigint; tx: string };

/** SOCIAL_RPC_RPS and SOCIAL_BACKFILL_DAYS, read once: requests a second for the indexer, and how far back it reads. */
export function indexerLimits(env: Record<string, string | undefined> = process.env) {
  const rps = Number(env.SOCIAL_RPC_RPS ?? 2);
  const days = Number(env.SOCIAL_BACKFILL_DAYS ?? 30);
  return { rps: Number.isFinite(rps) && rps > 0 ? Math.min(rps, 20) : 2, backfillDays: Number.isFinite(days) && days >= 0 ? Math.min(days, 3650) : 30 };
}

export class SocialBridge {
  private worker: Worker | null;

  constructor(cfg: IndexerConfig, log: (message: string) => void) {
    const env: Record<string, string> = {};
    for (const key of KEYS) if (process.env[key]) env[key] = process.env[key]!;
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href, { env });
    this.worker = worker;
    worker.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data?.log === "string") log(`social: ${event.data.log}`);
    });
    const gone = (why: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      log(`social: the worker ${why}; the game goes on without it until the relayer restarts`);
    };
    worker.addEventListener("error", (e) => gone(`failed (${(e as ErrorEvent).message ?? "error"})`));
    worker.addEventListener("close", () => gone("stopped"));
    worker.postMessage({ type: "start", cfg });
  }

  placed(p: BridgePlaced) {
    // Only what the chain cannot say again: a piece's stroke. Without one it is the indexer's to count.
    if (!this.worker || p.unit === undefined || !p.stroke) return;
    const placement: Placement = { betId: p.betId, player: p.player, drawing: p.drawing, openAt: p.openAt, staked: p.staked, unit: p.unit, stroke: p.stroke, tx: p.tx, sections: p.sections.map((s) => ({ second: s.second, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString(), rung: s.rung })) };
    this.post({ type: "placed", placement });
  }

  settled(s: BridgeSettled) {
    if (!this.worker) return;
    const settlement: Settlement = { betId: s.betId, player: s.player, hitMask: s.hitMask, missMask: s.missMask, expiredMask: s.expiredMask ?? 0, paid: s.paid, owed: s.owed, tx: s.tx, at: Date.now() };
    this.post({ type: "settled", settlement });
  }

  private post(message: unknown) {
    try {
      this.worker?.postMessage(message);
    } catch {
      /* A worker going away: the indexer reads it from the chain when it is back. */
    }
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}

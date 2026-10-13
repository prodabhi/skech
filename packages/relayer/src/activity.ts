/**
 * How much of each player's play is on chain: every game transaction their
 * play was in (a batch of pieces, a settlement, a deposit, a withdrawal, a
 * session), and how many pieces they placed.
 *
 * Counted from the game's own logs rather than from this relayer's receipts,
 * so it holds whoever sent them and survives restarts: scanned once from the
 * block the game was deployed in, then followed a few blocks at a time. The
 * public RPC allows 100 blocks a query; the scan starts wider and narrows to
 * whatever the RPC says it allows, and paces itself so placing never waits on
 * it. Saved beside the settler's state.
 */
import { renameSync } from "node:fs";
import { type Address, type Hex, parseEventLogs } from "viem";
import { type ChainClient, GAME_ABI } from "./chain";
import { report } from "./sentry";
import { readState, writeAtomic } from "./state";

export type Tally = { txs: number; pieces: number; deposits: number; withdrawals: number; recent: Hex[] };
type Saved = { from: string; scannedTo: string; players: Record<string, Tally> };

/** How many of a player's latest transactions are kept, for links to the explorer. */
const RECENT = 12;
/** Blocks left behind the head: a block this new may still change. */
const BEHIND = 2n;
/** Between queries while catching up, and between looks once caught up. */
const PACE_MS = 150;
const FOLLOW_MS = 3_000;

export class Activity {
  private players = new Map<Address, Tally>();
  /** The last transaction counted for each player: one transaction can carry several of their logs. */
  private lastTx = new Map<Address, Hex>();
  private scannedTo: bigint;
  private head: bigint | null = null;
  private span = 2_000n;
  private dirty = false;

  constructor(
    private readonly chain: ChainClient,
    /** The block the game was deployed in: nothing of it is before. */
    private readonly from: bigint,
    private readonly path: string,
    private readonly log: (s: string) => void,
  ) {
    this.scannedTo = from - 1n;
    this.load();
  }

  start() {
    void this.run();
    setInterval(() => this.save(), 10_000);
  }

  /** A player's tally, and whether the history is still being read (it only goes up from here). */
  of(player: Address): Tally & { counting: boolean; progress: number } {
    const t = this.players.get(player.toLowerCase() as Address) ?? { txs: 0, pieces: 0, deposits: 0, withdrawals: 0, recent: [] };
    const head = this.head ?? this.scannedTo;
    const counting = head - this.scannedTo > 20n;
    const total = head - this.from + 1n;
    const progress = total > 0n ? Number(((this.scannedTo - this.from + 1n) * 1000n) / total) / 1000 : 1;
    return { ...t, counting, progress: Math.max(0, Math.min(1, progress)) };
  }

  private async run() {
    for (;;) {
      let caughtUp = false;
      try {
        // The block the base fee was last read with, a couple of seconds old at most, rather than a request of its own.
        this.head = (await this.chain.blockNumber()) - BEHIND;
        if (this.head > this.scannedTo) {
          const to = this.scannedTo + this.span < this.head ? this.scannedTo + this.span : this.head;
          await this.scan(this.scannedTo + 1n, to);
          this.scannedTo = to;
          this.dirty = true;
        }
        caughtUp = this.head - this.scannedTo <= 0n;
      } catch (e) {
        const text = String((e as Error).message ?? e);
        // "eth_getLogs is limited to a 100 range": take the RPC at its word and go again at that.
        const limit = /limited to a (\d+) range|block range.*?(\d+)|(\d+) block/i.exec(text);
        const allowed = limit ? BigInt(limit[1] ?? limit[2] ?? limit[3]) : null;
        if (allowed && allowed > 0n && allowed - 1n < this.span) {
          this.span = allowed - 1n;
          this.log(`activity: the RPC reads ${allowed} blocks of logs at a time`);
          continue;
        }
        if (this.span > 100n) {
          this.span /= 2n;
          continue;
        }
        this.log(`activity: ${text.split("\n")[0]}`);
        report("activity", e);
        caughtUp = true;
      }
      await Bun.sleep(caughtUp ? FOLLOW_MS : PACE_MS);
    }
  }

  private async scan(fromBlock: bigint, toBlock: bigint) {
    const logs = await this.chain.pub.getLogs({ address: this.chain.cfg.game, fromBlock, toBlock });
    for (const ev of parseEventLogs({ abi: GAME_ABI, logs, strict: false })) {
      const args = (ev.args ?? {}) as { player?: Address };
      if (!args.player || !ev.transactionHash) continue;
      const k = args.player.toLowerCase() as Address;
      let t = this.players.get(k);
      if (!t) this.players.set(k, (t = { txs: 0, pieces: 0, deposits: 0, withdrawals: 0, recent: [] }));
      if (this.lastTx.get(k) !== ev.transactionHash) {
        this.lastTx.set(k, ev.transactionHash);
        t.txs++;
        t.recent.unshift(ev.transactionHash);
        if (t.recent.length > RECENT) t.recent.length = RECENT;
      }
      const name = (ev as { eventName?: string }).eventName;
      if (name === "Placed") t.pieces++;
      else if (name === "Deposited") t.deposits++;
      else if (name === "Withdrawn") t.withdrawals++;
    }
  }

  /**
   * What was counted before. Unlike the settler's, nothing here is lost with the file: it is all on chain. So a file
   * that cannot be read is moved aside, loudly, and the count starts again, rather than stopping the relayer.
   */
  private load() {
    try {
      const s = readState<Saved>(this.path);
      if (!s) return;
      // Counted for another deployment: start again.
      if (BigInt(s.from) !== this.from) return;
      this.scannedTo = BigInt(s.scannedTo);
      for (const [k, t] of Object.entries(s.players)) this.players.set(k as Address, t);
      this.log(`activity: ${this.players.size} players, read to block ${this.scannedTo}`);
    } catch (e) {
      const aside = `${this.path}.unreadable-${Date.now()}`;
      this.players.clear();
      this.scannedTo = this.from - 1n;
      try {
        renameSync(this.path, aside);
      } catch {
        /* gone already */
      }
      this.log(`WARNING: activity: could not read ${this.path} (${String((e as Error).message ?? e)}); moved it to ${aside} and counting again`);
      report("state-read", e);
    }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const s: Saved = { from: this.from.toString(), scannedTo: this.scannedTo.toString(), players: Object.fromEntries(this.players) };
    try {
      writeAtomic(this.path, JSON.stringify(s));
    } catch (e) {
      this.log(`activity: could not write ${this.path}: ${String(e)}`);
    }
  }
}


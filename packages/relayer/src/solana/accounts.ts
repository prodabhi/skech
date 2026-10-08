/**
 * What the relayer knows of each player's accounts: their game account, the pool (for what they are owed), the
 * USDC in their wallet and their SKT (with SKT's own account, for what it has earned), read together in one `getMultipleAccounts`, and at most once a second for each player
 * however many ask. A settlement, the app asking, a piece arriving and a new socket watching each used to read for
 * themselves, three requests a time.
 *
 * Asked for something no older than `maxAgeMs`, the last read is given if it is that fresh, or the read in flight.
 * Asked for a fresh one (0, after something changed), a read is made that starts after the asking: at once if
 * none started in the last second, else a second after the last, shared by everyone who asks meanwhile.
 * Invalidated reads wait for a replacement; late replies never return an older snapshot than the latest one.
 */
import type { Address } from "@solana/kit";
import type { Holder, Player, Pool, Rewards } from "@skech/contracts/solana/sdk";
import type { Token } from "@solana-program/token";
import { remember } from "../limits";

/** `holder` is the player's SKT, null until a settlement first mints for them; `rewards` SKT's own, null until it starts. */
export type Snapshot = { player: Player | null; pool: Pool; token: Token | null; holder: Holder | null; rewards: Rewards | null; at: number };
type Entry = { last: Snapshot | null; stale: boolean; revision: number; started: number; running: Promise<Snapshot> | null; queued: Promise<Snapshot> | null };

/** Players remembered at once. */
const MOST = 20_000;

export class Accounts {
  private entries = new Map<Address, Entry>();
  reads = 0;

  constructor(
    private readonly fetch: (wallet: Address) => Promise<Omit<Snapshot, "at">>,
    /** The least time between two reads for one player. */
    private readonly gapMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The player's accounts, no older than `maxAgeMs` (0: read after now). `missingMs` lets an address with no game
   * account be answered from a read that long ago: an app watching an address nobody plays from costs a read in 30 s.
   */
  get(wallet: Address, maxAgeMs = 0, missingMs = maxAgeMs): Promise<Snapshot> {
    let e = this.entries.get(wallet);
    if (!e) remember(this.entries, wallet, (e = { last: null, stale: false, revision: 0, started: 0, running: null, queued: null }), MOST);
    if (maxAgeMs > 0) {
      const last = e.last;
      if (last && !e.stale && this.now() - last.at <= (last.player ? maxAgeMs : Math.max(maxAgeMs, missingMs))) return Promise.resolve(last);
      if (e.running && !e.stale) return e.running;
    }
    if (e.queued) return e.queued;
    const entry = e;
    const wait = Math.max(0, entry.started + this.gapMs - this.now());
    const queued = new Promise<Snapshot>((resolve, reject) => {
      setTimeout(() => {
        entry.queued = null;
        entry.stale = false;
        entry.started = this.now();
        this.reads++;
        const at = entry.started;
        const revision = entry.revision;
        // Done with before anyone hears of it: a read answered is `last`, never in flight.
        const settled = () => {
          if (entry.running === running) entry.running = null;
        };
        const running: Promise<Snapshot> = this.fetch(wallet).then(
          (s) => {
            settled();
            // A placement or payout was announced while this RPC was reading.
            // All callers must wait for its replacement, including callers
            // already awaiting this read when the transaction landed.
            if (revision !== entry.revision) return this.get(wallet, Infinity);
            const snap = { ...s, at };
            // A slow read never stands in for a later one that answered first.
            if (!entry.last || entry.last.at <= at) entry.last = snap;
            return entry.last;
          },
          (e) => {
            settled();
            throw e;
          },
        );
        entry.running = running;
        running.then(resolve, reject);
      }, wait);
    });
    entry.queued = queued;
    return queued;
  }

  /** Something changed on chain for `wallet` (a transaction of theirs landed): what was read before is not given again. */
  invalidate(wallet: Address) {
    const e = this.entries.get(wallet);
    if (e) {
      e.stale = true;
      e.revision++;
      e.last = null;
    }
  }
}

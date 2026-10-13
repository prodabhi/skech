/**
 * Nonces, kept here: asking the node before every transaction is a round
 * trip, and Monad's docs say not to.
 *
 * Every nonce handed out is accounted for: used (its transaction is on chain,
 * or at least took it) or lost (it never went out, or never landed). A lost
 * one is a gap no later transaction can pass, so after one nothing more is
 * handed out until every nonce still out is accounted for; then the node is
 * asked where it stands. Asking with nonces still out would hand one out twice.
 */
import type { PublicClient, Address } from "viem";

export class Nonces {
  private next: number | null = null;
  private syncing: Promise<void> | null = null;
  /** Handed out, not yet accounted for. */
  private out = new Set<number>();
  /** A nonce was lost: ask the node again once none is out. */
  private stale = false;
  private idle: (() => void)[] = [];

  constructor(private readonly client: Pick<PublicClient, "getTransactionCount">, private readonly account: Address) {}

  async take(): Promise<number> {
    while (this.next === null || this.stale) {
      if (this.out.size) await new Promise<void>((r) => this.idle.push(r));
      else await this.sync();
    }
    const n = this.next++;
    this.out.add(n);
    return n;
  }

  /** `n` is on chain, or taken there all the same. */
  used(n: number) {
    this.out.delete(n);
    this.wake();
  }

  /** `n` never went out, or cannot be known to have: what the node says goes, once nothing else is out. */
  lost(n: number) {
    this.out.delete(n);
    this.stale = true;
    this.wake();
  }

  private wake() {
    if (!this.out.size) for (const r of this.idle.splice(0)) r();
  }

  private sync(): Promise<void> {
    this.syncing ??= this.client
      .getTransactionCount({ address: this.account, blockTag: "pending" })
      .then((n) => {
        this.next = n;
        this.stale = false;
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }
}


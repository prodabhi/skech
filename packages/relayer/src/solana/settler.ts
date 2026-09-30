/**
 * Every second with ink in it, once it is over: its bar posted and every bet in it settled, in one transaction, or a
 * few when many bets have ink there (a transaction holds a dozen). Then, when nothing is about to be due: IOUs paid
 * off as the pool refills, USDC that landed in approving wallets swept in, and the fees moved to the treasury.
 */
import { AccountRole, type Address, getAddressEncoder, type Instruction } from "@solana/kit";
import { decodeToken, fetchMaybeToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, type Token } from "@solana-program/token";
import { CLOSE_AFTER_MS } from "@skech/core/bars";
import {
  decodePlayer,
  fetchBars,
  fetchMaybeRewards,
  fetchPool,
  getCollectFeesInstruction,
  getExpireInstruction,
  getPostBarAndSettleInstruction,
  getRedeemHouseInstruction,
  getRedeemInstruction,
  getSettleInstruction,
  getShareSurplusInstruction,
  getSkechErrorMessage,
  getSweepInstruction,
  holderAddress,
  pda,
  playerAddress,
  SKECH_ERROR__BAR_CONFLICT,
  SKECH_ERROR__BAR_DISCONTINUOUS,
  SKECH_ERROR__BAR_LATE,
  surplusE6,
} from "@skech/contracts/solana/sdk";
import type { Engine } from "../engine";
import { report } from "../sentry";
import { readState, writeAtomic } from "../state";
import { customCode, type Sent, type SolanaChain } from "./chain";
import { type BetLoad, chunksFor, MAX_CU, settleCompute } from "./compute";
import type { SolanaConfig } from "./config";
import type { Band } from "./sequencer";

/** `expiredMask`: bands given back, their second past posting; the refund is in `paid`. `minted`: SKT e6 its misses minted. */
export type Settled = { betId: Address; player: Address; hitMask: number; missMask: number; expiredMask: number; paid: bigint; owed: bigint; closed: boolean; minted: bigint; tx: string };
export type Notify = { settled: (s: Settled) => void; owed: (to: Address, value: bigint) => void; account: (player: Address) => void };

/** `count`: the bands the bet has on chain, each of which a settlement reads. */
type Live = { player: Address; unit: bigint; bands: Band[]; count: number };
type Bar = { prevClose: bigint; high: bigint; low: bigint; close: bigint };
type State = { bets: { bet: Address; player: Address; unit: string; bands: { second: number; lo: string; hi: string; stake: string; rung: number }[] }[]; holders: Address[]; approved: Address[]; posted: Record<string, string>; closing?: { bet: Address; player: Address }[] };

const jsonOf = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** Every share a holder has: redeem takes what the pool can pay of it. */
const ALL = (1n << 128n) - 1n;

const withBets = (ix: Instruction, extra: { address: Address; role: AccountRole }[]): Instruction => ({ ...ix, accounts: [...(ix.accounts ?? []), ...extra] });

export class SolanaSettler {
  private bets = new Map<Address, Live>();
  private watching = new Map<number, Set<Address>>();
  /** The close we posted for each second, so the next follows on from it exactly. */
  private closes = new Map<number, bigint>();
  /** Seconds the chain already has a different bar for: posted as the chain has them, so their bets settle. */
  private adopted = new Map<number, Bar>();
  /** Each second whose post failed: how many times in a row, and when to try it again. A revert that keeps coming is
   * not paid for every 100 ms, and it holds back no other second. */
  private failing = new Map<number, { failures: number; at: number }>();
  /** Players whose SKT account is known to be open (they have minted): a settlement of theirs opens nothing. */
  private opened = new Set<Address>();
  /** Each player's holder bump: opening their holder searches down from 255 for it, at a cost. */
  private bumps = new Map<Address, number>();
  private holders = new Set<Address>();
  /** Wallets that approved the game to sweep their USDC in. */
  private approved = new Set<Address>();
  private running = false;
  private sweeping = false;
  /** Wallets with a sweep in flight. */
  private sweepingIn = new Set<Address>();
  private lastSweep = 0;
  private told = new Map<Address, number>();
  /** What the state file was last written with. */
  private saved: string | null = null;
  /** Bets whose every band is decided but that the program keeps until their piece's placing window is over. */
  private closing = new Map<Address, { player: Address; due: number; tries: number }>();
  /** The smallest part of an IOU the program pays out (the game's minRedeem, USDC e6); set from the chain. */
  minRedeem = 0n;
  stats = { bars: 0, settled: 0, redeemed: 0n, swept: 0n, collected: 0n, surplus: 0n };
  /** How long after its opening second a piece may still be placed, from the game's config. */
  placeGraceMs = 3_000;

  constructor(
    private readonly cfg: SolanaConfig,
    private readonly engine: Engine,
    private readonly chain: SolanaChain,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
    private readonly statePath: string,
  ) {
    this.load();
  }

  watchers() {
    return this.watching.size;
  }
  posted(second: number) {
    return this.closes.has(second);
  }
  owed(holder: Address) {
    this.holders.add(holder);
  }
  /** A wallet approved the game: what is in it now is swept in now, not on the next full pass minutes away. */
  approve(wallet: Address) {
    this.approved.add(wallet);
    void this.sweepIn(wallet).catch((e) => this.log(`sweep ${wallet}: ${String((e as Error).message ?? e).split("\n")[0]}`));
  }

  watch(bet: Address, player: Address, unit: bigint, band: Band) {
    let b = this.bets.get(bet);
    if (!b) this.bets.set(bet, (b = { player, unit, bands: [], count: 0 }));
    b.bands.push(band);
    b.count++;
    let at = this.watching.get(band.second);
    if (!at) this.watching.set(band.second, (at = new Set()));
    at.add(bet);
  }

  /** A second is posted and its bets settled, but those in `keep`, whose settling failed: they go again. */
  private forget(second: number, keep = new Set<Address>()) {
    for (const bet of this.watching.get(second) ?? []) {
      if (keep.has(bet)) continue;
      const b = this.bets.get(bet);
      if (!b) continue;
      b.bands = b.bands.filter((x) => x.second !== second);
      if (!b.bands.length) this.bets.delete(bet);
    }
    if (keep.size) this.watching.set(second, keep);
    else this.watching.delete(second);
  }

  async start() {
    // The chain's own ring: what was posted before a restart, so the next bar follows on from it.
    const ring = await fetchBars(this.chain.rpc, this.cfg.deployment.bars).catch(() => null);
    for (const b of ring?.data.ring ?? []) if (b.second > 0n) this.closes.set(Number(b.second), b.close);
    setInterval(() => void this.tick(), 100);
    setInterval(() => this.save(), 5_000);
  }

  /** What a bet weighs in a settlement on `second` (null: a close, deciding nothing). */
  private loadOf(bet: Address, second: number | null): BetLoad {
    const b = this.bets.get(bet);
    const player = b?.player ?? this.closing.get(bet)?.player;
    const decided = b && second !== null ? b.bands.filter((x) => x.second === second).length : 0;
    // A bet whose bands the relayer no longer knows (a close) is budgeted at the most a bet has.
    const sections = b ? Math.max(b.count, b.bands.length) : 32;
    return { sections, decided, openBump: player && !this.opened.has(player) ? (this.bumps.get(player) ?? 248) : null };
  }

  /** Each player's holder bump, worked out once: before a settlement of theirs is budgeted. */
  private async bumpsFor(bets: Address[]) {
    const enc = getAddressEncoder();
    for (const bet of bets) {
      const player = this.bets.get(bet)?.player ?? this.closing.get(bet)?.player;
      if (!player || this.bumps.has(player)) continue;
      const [, bump] = await pda(["holder", enc.encode(player)], this.cfg.deployment.program);
      if (this.bumps.size > 50_000) this.bumps.clear();
      this.bumps.set(player, bump);
    }
  }

  private computeFor(bets: Address[], second: number | null, bar: boolean) {
    return settleCompute(this.cfg.compute, bar, bets.map((b) => this.loadOf(b, second)));
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.engine.now();
      // The oldest seconds due, but those waiting out a failure: one second that keeps failing holds back no other.
      const due = [...this.watching.keys()]
        .filter((s) => s + 1000 + CLOSE_AFTER_MS <= now && (this.failing.get(s)?.at ?? 0) <= Date.now())
        .sort((a, b) => a - b)
        .slice(0, 4);
      for (const second of due) {
        if (!this.engine.ready()) break;
        try {
          await this.post(second);
          this.failing.delete(second);
        } catch (e) {
          // Backing off, doubling up to thirty seconds, for this second alone.
          const failures = (this.failing.get(second)?.failures ?? 0) + 1;
          const wait = Math.min(30_000, 100 * 2 ** Math.min(failures, 9));
          this.failing.set(second, { failures, at: Date.now() + wait });
          this.log(`settle: ${String((e as Error).message ?? e).split("\n")[0]}; again in ${wait} ms`);
          report("settle", e);
        }
      }
      for (const s of this.failing.keys()) if (!this.watching.has(s)) this.failing.delete(s);
      await this.close();
      const soon = [...this.watching.keys()].some((s) => s + 1000 + CLOSE_AFTER_MS <= now + 1500);
      const since = Date.now() - this.lastSweep;
      if (since > this.cfg.sweepEveryMs && (!soon || since > 2 * this.cfg.sweepEveryMs)) {
        this.lastSweep = Date.now();
        void this.sweep();
      }
    } catch (e) {
      this.log(`settle: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("settle", e);
    } finally {
      this.running = false;
    }
  }

  /** Each bet's (bet, player, holder): the program opens a player's holder, at the relayer's cost, on their first settlement. */
  private async pairs(bets: Address[], playerOf = (bet: Address) => this.bets.get(bet)!.player) {
    const out: { address: Address; role: AccountRole }[] = [];
    const program = this.cfg.deployment.program;
    for (const bet of bets) {
      const wallet = playerOf(bet);
      out.push({ address: bet, role: AccountRole.WRITABLE }, { address: await playerAddress(wallet, program), role: AccountRole.WRITABLE }, { address: await holderAddress(wallet, program), role: AccountRole.WRITABLE });
    }
    return out;
  }

  /** What every settlement shares: the game, the ring, the pool, SKT's account, and the relayer taking back rent and paying a holder's. */
  private settleAccounts() {
    const d = this.cfg.deployment;
    return { game: d.game, bars: d.bars, pool: d.pool, rewards: this.chain.rewards, rentReceiver: this.chain.signer.address, payer: this.chain.signer, market: this.cfg.market };
  }

  /** Close the bets that were decided inside their placing window, now it is over: a settle with nothing to decide. */
  private async close() {
    const now = Date.now();
    const ready = [...this.closing].filter(([, c]) => c.due <= now).slice(0, this.chain.betsPerSettle);
    if (!ready.length) return;
    for (const [bet, c] of ready) {
      // Retried until its Settled says closed; given up on after a few (someone else closed it).
      c.due = now + 2_000;
      if (++c.tries > 5) this.closing.delete(bet);
    }
    const bets = ready.map(([bet]) => bet);
    await this.bumpsFor(bets);
    const ix = getSettleInstruction(this.settleAccounts());
    const s = await this.chain.send(`close ${bets.length}`, [withBets(ix, await this.pairs(bets, (b) => ready.find(([x]) => x === b)![1].player))], this.computeFor(bets, null, false));
    if (!s.err) void this.tell(s.signature);
  }

  private async post(second: number) {
    const b = this.engine.book.at(second);
    const theirs = this.adopted.get(second);
    if (!b && !theirs) {
      if (this.engine.book.bars[0] && this.engine.book.bars[0].t > second) {
        this.log(`settle: no bar for ${second}, before this relayer's history; dropping its watch`);
        this.forget(second);
      }
      return;
    }
    const bar = theirs
      ? { second: BigInt(second), ...theirs }
      : {
          second: BigInt(second),
          prevClose: this.closes.get(second - 1000) ?? BigInt(Math.round((this.engine.book.at(second - 1000)?.c ?? b!.c) * 1e8)),
          high: BigInt(Math.round(b!.h * 1e8)),
          low: BigInt(Math.round(b!.l * 1e8)),
          close: BigInt(Math.round(b!.c * 1e8)),
        };
    const bets = [...(this.watching.get(second) ?? [])].filter((x) => this.bets.has(x));
    const d = this.cfg.deployment;
    await this.bumpsFor(bets);
    // As many bets a settlement as its bytes hold and its compute allows, by the bands each has and decides here: one
    // second full of bands is several settlements, not one that runs out of compute.
    const chunks = chunksFor(this.cfg.compute, true, bets, (b) => this.loadOf(b, second), this.chain.betsPerSettle);
    // The bar with the first bets; the rest settle on it right after, in parallel: they meet only on the pool.
    const postIx = (with_: Address[]) => this.pairs(with_).then((extra) => withBets(getPostBarAndSettleInstruction({ ...this.settleAccounts(), oracle: this.chain.signer, marketAccount: d.market, bar }), extra));
    let sent = await this.chain.send(`bar ${second} + ${chunks[0].length} bets`, [await postIx(chunks[0])], this.computeFor(chunks[0], second, true));
    if (sent.err && customCode(sent.err) === SKECH_ERROR__BAR_LATE) {
      // Too long after its second to post: it never will be. Its bets' bands in it are given their stakes back.
      this.log(`settle: bar ${second} is too late to post; expiring its ${bets.length} bets`);
      const keep = new Set<Address>();
      const done = await Promise.all(chunksFor(this.cfg.compute, false, bets, (b) => this.loadOf(b, second), this.chain.betsPerSettle).filter((c) => c.length).map((c) => this.settleSplit("expire", second, c)));
      for (const r of done) for (const bet of r.failed) keep.add(bet);
      for (const r of done) for (const s of r.landed) void this.tell(s.signature);
      this.forget(second, keep);
      if (keep.size) throw new Error(`expire on ${second}: ${keep.size} bets did not settle, and go again`);
      return;
    }
    const code = sent.err ? customCode(sent.err) : null;
    if (sent.err && (code === SKECH_ERROR__BAR_CONFLICT || code === SKECH_ERROR__BAR_DISCONTINUOUS)) {
      // A bar the chain already has, different, or one that does not follow on from its second before, fails every
      // time: the chain's own are read instead, and posted as they are.
      await this.adopt(second);
      throw new Error(`bar ${second}: ${getSkechErrorMessage(code as Parameters<typeof getSkechErrorMessage>[0]) ?? `error ${code}`}`);
    }
    // Every bet still to settle on this second, in settlements of its own.
    let after = chunks.slice(1);
    if (sent.err && chunks[0].length) {
      // Anything else, a settlement that ran out of compute among it: the bar goes alone, which always fits, and its
      // bets settle on it after, split as far as they need. A second's bets never hold its bar back.
      this.log(`settle: bar ${second} with ${chunks[0].length} bets failed (${code !== null ? `error ${code}` : jsonOf(sent.err)}); posting it alone`);
      sent = await this.chain.send(`bar ${second}`, [await postIx([])], this.computeFor([], second, true));
      after = chunks;
    }
    if (sent.err) throw new Error(`bar ${second}: ${customCode(sent.err) !== null ? `error ${customCode(sent.err)}` : jsonOf(sent.err)}`);
    this.closes.set(second, bar.close);
    this.adopted.delete(second);
    if (this.closes.size > 4000) for (const k of [...this.closes.keys()].sort((a, c) => a - c).slice(0, 1000)) this.closes.delete(k);
    this.stats.bars++;
    const rest = await Promise.all(after.filter((c) => c.length).map((chunk) => this.settleSplit("settle", second, chunk)));
    // A bet whose settlement failed however small it was split, or was never seen to land, stays watched: it settles
    // on the next round, with the bar posted again as it is (the same bar twice is fine, and a bet settled already
    // is passed over).
    const keep = new Set<Address>();
    const landed: Sent[] = [sent];
    for (const r of rest) {
      landed.push(...r.landed);
      for (const bet of r.failed) keep.add(bet);
    }
    this.forget(second, keep);
    for (const s of landed) void this.tell(s.signature).catch((e) => this.log(`settle ${second}: ${String((e as Error).message ?? e).split("\n")[0]}`));
    if (keep.size) throw new Error(`settle on ${second}: ${keep.size} bets did not settle, and go again`);
  }

  /**
   * Settle (or expire) `bets` on a posted bar. A settlement that fails is split in two and each half sent again, down
   * to one bet, which goes at the most compute a transaction may have: whatever the budget missed, every bet that
   * can settle does, and one that cannot holds back only itself.
   */
  private async settleSplit(kind: "settle" | "expire", second: number, bets: Address[], max = false): Promise<{ landed: Sent[]; failed: Address[] }> {
    const ix = kind === "expire" ? getExpireInstruction(this.settleAccounts()) : getSettleInstruction(this.settleAccounts());
    let s: Sent;
    try {
      s = await this.chain.send(`${kind} ${bets.length} on ${second}`, [withBets(ix, await this.pairs(bets))], max ? MAX_CU : this.computeFor(bets, second, false));
    } catch (e) {
      // Not seen to land, or the RPC not answering: nothing about its size, so it is not split, only tried again later.
      this.log(`${kind} ${bets.length} on ${second}: ${String((e as Error).message ?? e).split("\n")[0]}`);
      return { landed: [], failed: bets };
    }
    if (!s.err) return { landed: [s], failed: [] };
    if (bets.length === 1) {
      if (max) return { landed: [], failed: bets };
      return this.settleSplit(kind, second, bets, true);
    }
    const half = Math.ceil(bets.length / 2);
    const parts = await Promise.all([this.settleSplit(kind, second, bets.slice(0, half)), this.settleSplit(kind, second, bets.slice(half))]);
    return { landed: parts.flatMap((p) => p.landed), failed: parts.flatMap((p) => p.failed) };
  }

  /** The chain's own bars, after it refused ours: its bar for `second` if it has one, and its close before. */
  private async adopt(second: number) {
    const ring = await fetchBars(this.chain.rpc, this.cfg.deployment.bars).catch(() => null);
    if (!ring) return;
    this.closes.delete(second - 1000);
    for (const b of ring.data.ring) {
      if (b.second === BigInt(second)) this.adopted.set(second, { prevClose: b.prevClose, high: b.high, low: b.low, close: b.close });
      if (b.second === BigInt(second - 1000)) this.closes.set(second - 1000, b.close);
    }
    this.log(`settle: the chain has other bars around ${second}; posting its own`);
  }

  /** Tell each player what their bets did, from the settlement's events. */
  private async tell(signature: Parameters<SolanaChain["events"]>[0]) {
    const touched = new Set<Address>();
    // A bet's misses mint as it settles: the program says Minted just before that bet's Settled.
    const minted = new Map<Address, bigint>();
    for (const ev of await this.chain.events(signature)) {
      if (ev.name === "Minted") {
        const a = ev.data as { player: Address; skt: bigint };
        minted.set(a.player, (minted.get(a.player) ?? 0n) + a.skt);
        touched.add(a.player);
        // It minted, so its SKT account is open: its settlements open nothing from now on.
        if (this.opened.size > 100_000) this.opened.clear();
        this.opened.add(a.player);
      } else if (ev.name === "Settled") {
        const a = ev.data as { bet: Address; player: Address; hitMask: number; missMask: number; expiredMask?: number; paid: bigint; owed: bigint; closed: boolean };
        if (a.closed) this.closing.delete(a.bet);
        else if (!this.bets.has(a.bet)) this.closing.set(a.bet, { player: a.player, due: Date.now() + this.placeGraceMs + 1_000, tries: 0 });
        // A close with nothing left to decide still tells the app the bet is done.
        if (a.hitMask || a.missMask) this.stats.settled++;
        if (a.paid > 0n || a.owed > 0n || Date.now() - (this.told.get(a.player) ?? 0) > 5_000) touched.add(a.player);
        const skt = minted.get(a.player) ?? 0n;
        minted.delete(a.player);
        this.notify.settled({ betId: a.bet, player: a.player, hitMask: a.hitMask, missMask: a.missMask, expiredMask: a.expiredMask ?? 0, paid: a.paid, owed: a.owed, closed: a.closed, minted: skt, tx: signature });
      } else if (ev.name === "Owed") {
        const a = ev.data as { to: Address; value: bigint };
        if (a.to !== "11111111111111111111111111111111") this.holders.add(a.to);
        this.notify.owed(a.to, a.value);
      }
    }
    for (const p of touched) {
      this.told.set(p, Date.now());
      this.notify.account(p);
    }
  }

  /**
   * Pay off what is owed as far as the pool goes, the house behind the players; sweep deposits in; move fees out.
   * Read in a few requests whatever the number of holders and wallets: the pool once, then holders' and wallets'
   * accounts a hundred to a request, at the lowest priority (budget.ts).
   */
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    const d = this.cfg.deployment;
    const rpc = this.chain.sweepRpc;
    try {
      const pool = (await fetchPool(rpc, d.pool)).data;
      // What the pool has left, followed down from each redemption's due rather than read again after it: the
      // program pays what it can, and an overestimate costs one redemption that pays less.
      let left = pool.pool;
      if (left > 0n && this.holders.size) {
        const holders = [...this.holders];
        const players = await this.chain.many(await Promise.all(holders.map((h) => playerAddress(h, d.program))), (a) => decodePlayer(a).data, rpc);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const index = pool.iouIndexAt + pool.iouRate * (now - pool.iouTimeAt > 0n ? now - pool.iouTimeAt : 0n);
        for (const [i, holder] of holders.entries()) {
          const p = players[i];
          if (!p || p.iouShares === 0n) {
            this.holders.delete(holder);
            continue;
          }
          if (left === 0n) continue;
          // The program pays part of an IOU only if that part is at least minRedeem: below it, and short of the
          // whole, it refuses (NothingToRedeem), and asking again each sweep only spends fees.
          const owed = (p.iouShares * index) / 10n ** 18n;
          if (left < owed && left < this.minRedeem) continue;
          // The redeemer's cut goes to the relayer's own account in the game.
          const ix = getRedeemInstruction({ caller: this.chain.signer, game: d.game, pool: d.pool, holder: await playerAddress(holder, d.program), callerPlayer: await playerAddress(this.chain.signer.address, d.program), shares: ALL });
          const s = await this.chain.send(`redeem ${holder}`, [ix], 30_000);
          if (!s.err) this.notify.account(holder);
          left = owed < left ? left - owed : 0n;
        }
      }
      if (pool.houseShares > 0n && left > 0n) await this.chain.send("redeem house", [getRedeemHouseInstruction({ game: d.game, pool: d.pool })], 30_000);
      // The pool's surplus over its reserve and what live bets could pay, to SKT holders: never while anything is owed
      // (the program checks again), and only once it is worth a transaction.
      const skt = await fetchMaybeRewards(rpc, this.chain.rewards).catch(() => null);
      if (skt?.exists) {
        const fresh = await fetchPool(rpc, d.pool);
        const surplus = surplusE6(fresh.data, skt.data, BigInt(Math.floor(Date.now() / 1000)));
        if (surplus >= this.cfg.surplusAboveE6) {
          const s = await this.chain.send(`share ${surplus} surplus`, [getShareSurplusInstruction({ game: d.game, pool: d.pool, rewards: this.chain.rewards })], 30_000);
          if (!s.err) this.stats.surplus += surplus;
        }
      }
      if (this.approved.size) {
        const wallets = [...this.approved];
        const atas = await Promise.all(wallets.map((w) => findAssociatedTokenPda({ mint: d.usdcMint, owner: w, tokenProgram: TOKEN_PROGRAM_ADDRESS }).then(([a]) => a)));
        const tokens = await this.chain.many(atas, (a) => decodeToken(a).data, rpc);
        for (const [i, wallet] of wallets.entries()) await this.sweepFrom(wallet, atas[i], tokens[i]);
      }
      // Fees from the read at the start: what came in since is collected next time.
      if (pool.fees >= this.cfg.collectAboveE6) {
        const ix = getCollectFeesInstruction({ game: d.game, pool: d.pool, vault: d.vault, treasury: d.treasury, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const s = await this.chain.send(`collect ${pool.fees} fees`, [ix], 40_000);
        if (!s.err) this.stats.collected += pool.fees;
      }
    } catch (e) {
      this.log(`sweep: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("sweep", e);
    } finally {
      this.sweeping = false;
    }
  }

  /** Move what landed in `wallet` into its balance, on the approval it gave: when its app asks, or it just gave it. */
  async sweepIn(wallet: Address): Promise<bigint> {
    const d = this.cfg.deployment;
    const [ata] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const t = await fetchMaybeToken(this.chain.rpc, ata);
    return this.sweepFrom(wallet, ata, t.exists ? t.data : null);
  }

  /** Sweep `wallet`'s token account `t`, as just read, if it still approves the game. One at a time for a wallet. */
  private async sweepFrom(wallet: Address, ata: Address, t: Token | null): Promise<bigint> {
    const d = this.cfg.deployment;
    if (!t || t.delegate.__option !== "Some" || t.delegate.value !== d.game) {
      this.approved.delete(wallet);
      return 0n;
    }
    this.approved.add(wallet);
    const amount = t.amount < t.delegatedAmount ? t.amount : t.delegatedAmount;
    // Swept already, or being swept: the same USDC twice would fail on chain, its fee paid for nothing.
    if (amount === 0n || this.sweepingIn.has(wallet)) return 0n;
    this.sweepingIn.add(wallet);
    try {
      const ix = getSweepInstruction({ game: d.game, player: await playerAddress(wallet, d.program), from: ata, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const s = await this.chain.send(`sweep ${amount} for ${wallet}`, [ix], 40_000);
      if (s.err) return 0n;
      this.stats.swept += amount;
      this.notify.account(wallet);
      return amount;
    } finally {
      this.sweepingIn.delete(wallet);
    }
  }

  /* ---- what survives a restart ---- */

  /** A file that is there but cannot be read stops the relayer here (state.ts): nothing owed is written over. */
  private load() {
    const s = readState<State>(this.statePath);
    if (!s) return;
    try {
      for (const b of s.bets) for (const band of b.bands) this.watch(b.bet, b.player, BigInt(b.unit), { second: band.second, lo: BigInt(band.lo), hi: BigInt(band.hi), stake: BigInt(band.stake), rung: band.rung });
      for (const h of s.holders) this.holders.add(h);
      for (const a of s.approved ?? []) this.approved.add(a);
      for (const c of s.closing ?? []) this.closing.set(c.bet, { player: c.player, due: 0, tries: 0 });
      for (const [second, close] of Object.entries(s.posted)) this.closes.set(Number(second), BigInt(close));
      this.log(`settle: restored ${this.watching.size} seconds to settle, ${this.holders.size} IOU holders, ${this.approved.size} approvals`);
    } catch (e) {
      throw new Error(`${this.statePath} is not state this relayer can restore (${String((e as Error).message ?? e)}): restore it, or move it aside to start without it`);
    }
  }

  save() {
    const s: State = { bets: [], holders: [...this.holders], approved: [...this.approved], posted: {}, closing: [...this.closing].map(([bet, c]) => ({ bet, player: c.player })) };
    for (const [bet, b] of this.bets) s.bets.push({ bet, player: b.player, unit: b.unit.toString(), bands: b.bands.map((x) => ({ second: x.second, lo: x.lo.toString(), hi: x.hi.toString(), stake: x.stake.toString(), rung: x.rung })) });
    for (const [second, close] of [...this.closes].slice(-600)) s.posted[second] = close.toString();
    // Written only when it changed: an idle relayer does not fsync the same file every five seconds.
    const text = JSON.stringify(s);
    if (text === this.saved) return;
    try {
      writeAtomic(this.statePath, text);
      this.saved = text;
    } catch (e) {
      this.log(`settle: could not write ${this.statePath}: ${String(e)}`);
      report("state-write", e);
    }
  }
}

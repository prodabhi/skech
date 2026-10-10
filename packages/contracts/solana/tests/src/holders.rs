//! What holding SKT does over time, on chain: it decays with a half-life, the pool's surplus over a reserve is shared
//! with holders, and no wallet's mints take it past its cap.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AnchorDeserialize;
use anchor_lang::Discriminator;
use base64::Engine;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;
use skech::piece::QuoteArgs;
use skech::state::{Config, RewardsConfig};

const PRICE: u64 = 83_000 * E8;
const AT: u32 = 415_000;
const FAR: u32 = AT + 5000;
const HALF: u32 = 500_000_000;
const LONG: u32 = 10_000_000;
const WEEK: i64 = 7 * 86_400;

fn events<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        .filter(|b| b.starts_with(E::DISCRIMINATOR))
        .map(|b| E::deserialize(&mut &b[8..]).unwrap())
        .collect()
}

fn key(p: &Player) -> Pubkey {
    p.wallet.pubkey()
}

struct T {
    g: Game,
    drawing: u64,
}

impl T {
    fn new() -> T {
        T { g: Game::new(), drawing: 0 }
    }
    fn open(&mut self) -> i64 {
        let t = self.g.now + 10;
        self.g.set_time(t);
        (t + 1) * 1000
    }
    /// (second, lo, stake, chance) bands.
    fn place(&mut self, p: &Player, open_at: i64, bands: &[(u8, u32, u32, u32)]) -> Pubkey {
        self.drawing += 1;
        let sections: Vec<(u8, u32, u16, u32)> = bands.iter().map(|&(s, lo, stake, _)| (s, lo, 5, stake)).collect();
        let mut piece = self.g.piece(p, self.drawing, 0, open_at, &sections);
        piece.per_dot = 1_000_000;
        let quote = QuoteArgs { price: PRICE, momentum: 0, received_at: open_at - 300, chances: bands.iter().map(|b| b.3).collect() };
        self.g.place(p, &piece, &quote).unwrap_or_else(|f| panic!("place {:?} {:?}", f.err, f.meta.logs));
        bet_pda(&key(p), self.drawing, 0).0
    }
    fn play(&mut self, p: &Player, lo: u32, stake: u32, chance: u32) -> litesvm::types::TransactionMetadata {
        let open_at = self.open();
        let bet = self.place(p, open_at, &[(1, lo, stake, chance)]);
        self.g.set_time(open_at / 1000 + 4);
        self.g.post_and_settle(open_at + 1000, PRICE, PRICE, PRICE, PRICE, &[(bet, key(p))]).unwrap_or_else(|f| panic!("settle {:?} {:?}", f.err, f.meta.logs))
    }
    /// A fresh session for each of `players`: a session lasts a day at most.
    fn sessions(&mut self, players: &[&Player]) {
        for p in players {
            let w = p.wallet.insecure_clone();
            let ix = self.g.session_ix(p, p.session.pubkey(), self.g.now + 86_400, 100 * E6);
            self.g.send(&[ix], &[&w]).unwrap();
        }
    }
    fn rewards_config(&mut self, r: RewardsConfig) {
        let admin = self.g.admin.insecure_clone();
        let ix = self.g.set_rewards_config_ix(r);
        self.g.send(&[ix], &[&admin]).expect("rewards config");
    }
}

/// A: SKT halves every half-life, so an early loss earns less and less unless its player keeps playing; holders are paid
/// by shares, which is by today's balance.
#[test]
fn skt_decays_and_a_later_loss_weighs_more() {
    let mut t = T::new();
    let (early, late, payer) = (t.g.player(100 * E6, 100 * E6), t.g.player(100 * E6, 100 * E6), t.g.player(500 * E6, 500 * E6));
    t.play(&early, FAR, 10_000_000, HALF);
    let skt = t.g.skt_now(&key(&early));
    assert!(t.g.holder(&key(&early)).minted - skt <= 1, "worth what it minted, at once, to the rounding");
    // 26 weeks on: half. 52: a quarter.
    let start = t.g.now;
    t.g.set_time(start + 26 * WEEK);
    let half = t.g.skt_now(&key(&early));
    assert!((half as f64 / skt as f64 - 0.5).abs() < 1e-6, "{half} of {skt}");
    t.g.set_time(start + 52 * WEEK);
    assert!((t.g.skt_now(&key(&early)) as f64 / skt as f64 - 0.25).abs() < 1e-6);
    t.sessions(&[&early, &late, &payer]);
    // The late player loses the same now: it mints a little less (the curve has moved on), but holds four times the
    // early player's SKT now, and takes four fifths of the holders' share of the fees that follow.
    t.play(&late, FAR, 10_000_000, HALF);
    let (e, l) = (t.g.skt_now(&key(&early)) as f64, t.g.skt_now(&key(&late)) as f64);
    assert!(l / e > 3.9 && l / e < 4.0, "{e} {l}");
    let claim = |t: &mut T, p: &Player| -> u64 {
        let before = t.g.player_state(p).balance;
        let w = p.wallet.insecure_clone();
        let _ = t.g.send(&[t.g.claim_ix(p)], &[&w]);
        t.g.player_state(p).balance - before
    };
    claim(&mut t, &early);
    claim(&mut t, &late);
    for _ in 0..20 {
        t.play(&payer, AT, 1_000_000, HALF);
    }
    let (ce, cl) = (claim(&mut t, &early) as f64, claim(&mut t, &late) as f64);
    assert!((cl / (ce + cl) - l / (e + l)).abs() < 0.01, "paid by today's balance: {ce} {cl}");
}

/// A, the long run: sixty years on, eras and all, a settlement mints, everything earned is claimed, and the books still
/// balance; the early loss is worth nothing beside a recent one.
#[test]
fn sixty_years_on_the_books_still_balance() {
    let mut t = T::new();
    let (early, late, payer) = (t.g.player(100 * E6, 100 * E6), t.g.player(100 * E6, 100 * E6), t.g.player(500 * E6, 500 * E6));
    t.play(&early, FAR, 10_000_000, HALF);
    t.play(&payer, AT, 1_000_000, HALF);
    let start = t.g.now;
    t.g.set_time(start + 60 * 52 * WEEK);
    t.sessions(&[&early, &late, &payer]);
    t.play(&late, FAR, 1_000_000, HALF);
    let r = t.g.rewards();
    assert_eq!(r.era, (60 * 52 / 26 / skech::state::ERA_HALVINGS) as u32, "seven eras on");
    assert!(t.g.skt_now(&key(&early)) == 0 && t.g.skt_now(&key(&late)) > 0);
    t.play(&payer, AT, 1_000_000, HALF);
    for p in [&early, &late] {
        let w = p.wallet.insecure_clone();
        let _ = t.g.send(&[t.g.claim_ix(p)], &[&w]);
    }
    let (pool, rewards) = (t.g.pool(), t.g.rewards());
    let balances: u64 = [&early, &late, &payer].iter().map(|p| t.g.player_state(p).balance).sum();
    assert_eq!(token_balance(&t.g.svm, &t.g.vault()), balances + pool.pool + pool.fees + rewards.holder_funds);
    assert!(rewards.claimed_total <= rewards.accrued_total);
}

/// Terms small enough that a pool of a few hundred dollars has a surplus: a piece at most $1, so one piece pays at most
/// $1 at 128x, $128, and the reserve that (the least it may be).
fn small_terms(t: &mut T) -> u64 {
    let admin = t.g.admin.insecure_clone();
    let config = Config { max_piece_stake: 1_000_000, ..t.g.game().config };
    let reserve = skech::state::max_piece_payout(&config);
    assert_eq!(reserve, 128 * 1_000_000);
    let r = RewardsConfig { surplus_reserve: reserve, ..t.g.rewards().config };
    t.g.send(&[t.g.set_config_ix(config), t.g.set_rewards_config_ix(r)], &[&admin]).expect("small terms");
    reserve
}

/// B: the pool's surplus over the reserve and what live bets could pay goes to holders; never while anything is owed,
/// never soon after SKT starts, never below the reserve; and afterwards the pool still pays every live band hitting.
#[test]
fn the_pool_shares_its_surplus_and_can_still_pay_every_live_band() {
    let mut t = T::new();
    let reserve = small_terms(&mut t);
    let losers: Vec<Player> = (0..6).map(|_| t.g.player(100 * E6, 100 * E6)).collect();
    // Too soon after SKT started: bets placed before it are not counted.
    assert_eq!(custom_error(&t.g.send(&[t.g.share_surplus_ix()], &[])), Some(code(SkechError::NoSurplus)));
    t.g.set_time(t.g.now + skech::state::BAR_RING as i64);
    // Losses fill the pool well past the reserve.
    for p in &losers {
        for _ in 0..40 {
            t.play(p, FAR, 1_000_000, HALF);
        }
    }
    // Live bets: a long shot that pays $48 if it hits, and ink at 50%.
    let winner = t.g.player(100 * E6, 100 * E6);
    let open_at = t.open();
    let live = [t.place(&winner, open_at, &[(1, AT, 500_000, LONG)]), t.place(&winner, open_at, &[(2, AT, 900_000, HALF)])];
    let r = t.g.rewards();
    assert_eq!(r.liability, 500_000 * 96 + 900_000 * 150 / 100, "what they could pay, gross");
    let (pool, fees) = (t.g.pool().pool, t.g.pool().fees);
    let m = t.g.send(&[t.g.share_surplus_ix()], &[]).expect("shared");
    println!("share_surplus: {} CU", m.compute_units_consumed);
    let shared: Vec<skech::events::SurplusShared> = events(&m.logs);
    // 75% of the surplus to holders, rounded down; the treasury the rest, the rounding with it.
    let surplus = pool - reserve - r.liability;
    assert_eq!(shared[0].amount, surplus * 7_500 / 10_000);
    assert_eq!(shared[0].treasury, surplus - surplus * 7_500 / 10_000);
    assert_eq!(t.g.pool().fees - fees, shared[0].treasury);
    assert_eq!(t.g.pool().pool, reserve + r.liability, "the pool keeps the reserve and every live bet's most");
    assert_eq!(t.g.rewards().holder_funds - r.holder_funds, shared[0].amount);
    // Nothing more to share.
    assert_eq!(custom_error(&t.g.send(&[t.g.share_surplus_ix()], &[])), Some(code(SkechError::NoSurplus)));
    // Both live bets hit: paid in full, nothing owed; the liability is released.
    t.g.set_time(open_at / 1000 + 5);
    t.g.post_and_settle(open_at + 1000, PRICE, PRICE, PRICE, PRICE, &[(live[0], key(&winner))]).unwrap();
    t.g.post_and_settle(open_at + 2000, PRICE, PRICE, PRICE, PRICE, &[(live[1], key(&winner))]).unwrap();
    assert_eq!((t.g.pool().iou_shares, t.g.player_state(&winner).iou_shares), (0, 0), "every winner paid");
    assert_eq!(t.g.rewards().liability, 0);
    assert!(t.g.pool().pool >= reserve, "the reserve untouched");
}

/// B: never while an IOU is owed.
#[test]
fn no_surplus_is_shared_while_anything_is_owed() {
    let mut t = T::new();
    let reserve = small_terms(&mut t);
    t.g.set_time(t.g.now + skech::state::BAR_RING as i64);
    let (loser, winner) = (t.g.player(500 * E6, 500 * E6), t.g.player(100 * E6, 100 * E6));
    t.play(&loser, FAR, 1_000_000, HALF);
    // A long shot the pool cannot pay: owed.
    t.play(&winner, AT, 900_000, LONG);
    assert!(t.g.pool().iou_shares > 0);
    // Losses refill the pool far past the reserve, but nobody has redeemed yet: nothing is shared.
    for _ in 0..400 {
        t.play(&loser, FAR, 1_000_000, HALF);
    }
    assert!(t.g.pool().pool > 2 * reserve);
    assert_eq!(custom_error(&t.g.send(&[t.g.share_surplus_ix()], &[])), Some(code(SkechError::NoSurplus)));
}

/// C: no wallet's mints take it past 10% of all SKT (or past 10% of the floor while there is little). What would pass
/// it is not minted; the tracked gain still moves on.
#[test]
fn no_wallet_mints_past_its_cap() {
    let mut t = T::new();
    // The default cap, 10%, on a floor of 100 SKT, so a few dollars reach it.
    let r = RewardsConfig { wallet_cap_bps: 1_000, cap_floor: 100 * E6, ..t.g.rewards().config };
    t.rewards_config(r);
    let (whale, others) = (t.g.player(1_000 * E6, 1_000 * E6), (0..3).map(|_| t.g.player(100 * E6, 100 * E6)).collect::<Vec<_>>());
    // Alone: 10 SKT, 10% of the floor, however much it loses.
    let m = t.play(&whale, FAR, 2_000_000, HALF);
    let minted: Vec<skech::events::Minted> = events(&m.logs);
    assert!(minted[0].capped > 0, "capped");
    assert!(t.g.skt_now(&key(&whale)) <= 10 * E6);
    let gain = t.g.rewards().gain;
    assert_eq!(gain, 1_100_000, "the whole basis moved the curve on");
    // Others lose; the whale loses far more; it never holds more than 10% of the shares.
    for i in 0..12 {
        t.play(&others[i % 3], FAR, 1_000_000, HALF);
        t.play(&whale, FAR, 5_000_000, HALF);
        let r = t.g.rewards();
        let (h, total, floor) = (t.g.holder(&key(&whale)).shares, r.total_shares, r.floor_shares());
        assert!(h * 10 <= total.max(floor) + 10, "{h} of {total}");
    }
}

/// B: the split is exactly the configured share to holders, rounded down, and the rest to the treasury; a share over
/// 10,000 bps is refused; and the wallet cap still holds on the holders' part (the floor's part going to the treasury).
#[test]
fn the_surplus_splits_three_quarters_to_holders_and_the_cap_holds_on_their_part() {
    let mut t = T::new();
    let reserve = small_terms(&mut t);
    let admin = t.g.admin.insecure_clone();
    assert_eq!(t.g.rewards().config.surplus_holder_bps, 7_500, "the default");
    // Over 10,000 bps: refused. 10,000 and 0 are fine.
    for (bps, ok) in [(10_001u16, false), (u16::MAX, false), (10_000, true), (0, true), (7_500, true)] {
        let r = RewardsConfig { surplus_holder_bps: bps, ..t.g.rewards().config };
        let res = t.g.send(&[t.g.set_rewards_config_ix(r)], &[&admin]);
        if ok {
            res.expect("accepted");
        } else {
            assert_eq!(custom_error(&res), Some(code(SkechError::BadConfig)), "{bps} bps");
        }
    }
    // The cap on, its floor 1M SKT as by default: one loser holds every share there is, a sliver of the floor.
    let r = RewardsConfig { wallet_cap_bps: 1_000, ..t.g.rewards().config };
    t.rewards_config(r);
    t.g.set_time(t.g.now + skech::state::BAR_RING as i64);
    let loser = t.g.player(300 * E6, 300 * E6);
    for _ in 0..200 {
        t.play(&loser, FAR, 1_000_000, HALF);
    }
    let (rw, pool, fees) = (t.g.rewards(), t.g.pool().pool, t.g.pool().fees);
    let floor = rw.floor_shares();
    assert!(rw.total_shares < floor, "fewer shares than the floor");
    let surplus = pool - reserve - rw.liability;
    let m = t.g.send(&[t.g.share_surplus_ix()], &[]).expect("shared");
    let e: Vec<skech::events::SurplusShared> = events(&m.logs);
    let to_holders = surplus * 7_500 / 10_000;
    // Of the holders' 75%, only total / floor is shared (rounded up): the loser, holding all of it, is paid at most a
    // tenth of the holders' part. The treasury takes its 25% and the floor's part.
    let shared = ((to_holders as u128 * rw.total_shares).div_ceil(floor)) as u64;
    assert_eq!(e[0].amount, shared);
    assert_eq!(e[0].treasury, surplus - shared);
    assert_eq!(t.g.pool().fees - fees, surplus - shared);
    assert_eq!(t.g.pool().pool, reserve + rw.liability);
    let before = t.g.player_state(&loser).balance;
    let w = loser.wallet.insecure_clone();
    let _ = t.g.send(&[t.g.claim_ix(&loser)], &[&w]);
    let paid = t.g.player_state(&loser).balance - before;
    assert!(paid <= to_holders / 10 + 1, "paid {paid} of the holders' {to_holders}");
}

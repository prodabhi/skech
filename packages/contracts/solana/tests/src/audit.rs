//! The SKT audits' proofs of concept, turned round: each test runs the attack and asserts it now fails.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AnchorDeserialize;
use anchor_lang::Discriminator;
use base64::Engine;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;
use skech::piece::QuoteArgs;

const PRICE: u64 = 83_000 * E8;
const AT: u32 = 415_000;
const FAR: u32 = AT + 5000;
const HIT_AT: u64 = PRICE;
const HALF: u32 = 500_000_000;

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

/// A game, and the next drawing number: each `play` a piece of one-second bands, settled on a flat bar at `price`.
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
    /// A piece of (lo, width, stake, chance) bands, all in second 1.
    fn piece_at(&mut self, p: &Player, open_at: i64, bands: &[(u32, u16, u32, u32)]) -> (Pubkey, Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>) {
        self.drawing += 1;
        let sections: Vec<(u8, u32, u16, u32)> = bands.iter().map(|&(lo, w, stake, _)| (1, lo, w, stake)).collect();
        let piece = self.g.piece(p, self.drawing, 0, open_at, &sections);
        let quote = QuoteArgs { price: PRICE, momentum: 0, received_at: open_at - 300, chances: bands.iter().map(|b| b.3).collect() };
        let r = self.g.place(p, &piece, &quote);
        (bet_pda(&key(p), self.drawing, 0).0, r)
    }
    fn place(&mut self, p: &Player, open_at: i64, bands: &[(u32, u32, u32)]) -> Pubkey {
        let b: Vec<(u32, u16, u32, u32)> = bands.iter().map(|&(lo, stake, chance)| (lo, 5, stake, chance)).collect();
        let (bet, r) = self.piece_at(p, open_at, &b);
        r.unwrap_or_else(|f| panic!("place {:?} {:?}", f.err, f.meta.logs));
        bet
    }
    fn settle(&mut self, open_at: i64, price: u64, bets: &[(Pubkey, Pubkey)]) -> litesvm::types::TransactionMetadata {
        self.g.set_time(open_at / 1000 + 4);
        self.g.post_and_settle(open_at + 1000, price, price, price, price, bets).unwrap_or_else(|f| panic!("settle {:?} {:?}", f.err, f.meta.logs))
    }
    fn play(&mut self, p: &Player, bands: &[(u32, u32, u32)], price: u64) -> litesvm::types::TransactionMetadata {
        let open_at = self.open();
        let bet = self.place(p, open_at, bands);
        self.settle(open_at, price, &[(bet, key(p))])
    }
}

/// Economic C1: certain ink (a band over the whole map, or many steps either side of the price, at second 1) was quoted
/// at all but certain and paid 1x: the player risked nothing while the stake fee's holder share came out of the pool.
/// Now a band taller than the widest pen is refused, and one returning more than the stake fee leaves is not offered.
#[test]
fn certain_ink_is_refused() {
    let mut t = T::new();
    let p = t.g.player(100 * E6, 100 * E6);
    let pool = t.g.pool().pool;
    // A band over the whole map: 2,000 units (40 market steps) tall. Refused, whatever its chance.
    let open_at = t.open();
    let (_, r) = t.piece_at(&p, open_at, &[(AT - 1000, 2000, 1_000_000, 999_999_000)]);
    assert_eq!(custom_error(&r), Some(code(SkechError::Sections)), "a band over the whole map");
    // One unit over the widest pen: refused. At it: placed, as a pen draws it.
    let (_, r) = t.piece_at(&p, open_at, &[(AT - 32, skech::state::MAX_SECTION_WIDTH + 1, 1_000_000, 500_000_000)]);
    assert_eq!(custom_error(&r), Some(code(SkechError::Sections)));
    // ±8 market steps would be 800 units: the widest pen's band at the price, quoted all but certain, pays 1x and is not
    // offered; nor ink 99% likely, nor anything with chance x rung over 0.96.
    for chance in [999_900_000u32, 990_000_000, 961_000_000] {
        let (_, r) = t.piece_at(&p, open_at, &[(AT - 32, skech::state::MAX_SECTION_WIDTH, 1_000_000, chance)]);
        assert_eq!(custom_error(&r), Some(code(SkechError::NotOffered)), "chance {chance}");
    }
    // Nothing was taken from the player, nor put through the pool.
    assert_eq!((t.g.player_state(&p).balance, t.g.pool().pool), (100 * E6, pool));
    // In a piece with other ink, the certain band is dropped and its stake handed back; the rest goes in.
    let (bet, r) = t.piece_at(&p, open_at, &[(AT - 32, 64, 1_000_000, 999_900_000), (AT, 5, 50_000, 480_000_000)]);
    let r = r.expect("placed");
    let placed: Vec<skech::events::Placed> = events(&r.logs);
    assert_eq!((placed[0].staked, placed[0].refunded, placed[0].sections.len()), (50_000, 1_000_000, 1));
    let b: skech::state::Bet = t.g.account(&bet).unwrap();
    assert_eq!(b.sections[0].rung, 200, "48% at d = 51 earns 2x: p·m = 0.96, the most a band may");
}

/// SOUND (security audit), kept: claim with another player's holder is refused; a holder-shaped fake is impossible.
#[test]
fn claim_only_pays_the_signers_own_holder() {
    let mut t = T::new();
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    t.play(&b, &[(FAR, 1_000_000, HALF)], HIT_AT);
    t.play(&a, &[(AT, 100_000, HALF)], HIT_AT);
    let mut ix = t.g.claim_ix(&a);
    ix.accounts[4].pubkey = holder_pda(&key(&b));
    let w = a.wallet.insecure_clone();
    assert!(t.g.send(&[ix], &[&w]).is_err());
    let mut real = t.g.svm.get_account(&rewards_pda()).unwrap();
    let fake = Pubkey::new_unique();
    real.owner = anchor_lang::system_program::ID;
    t.g.svm.set_account(fake, real).unwrap();
    let mut ix = t.g.claim_ix(&b);
    ix.accounts[2].pubkey = fake;
    let w = b.wallet.insecure_clone();
    assert!(t.g.send(&[ix], &[&w]).is_err());
    let before = t.g.player_state(&b).balance;
    t.g.send(&[t.g.claim_ix(&b)], &[&w]).unwrap();
    assert!(t.g.player_state(&b).balance > before);
}

/// SOUND (security audit), kept: a mismatched triple never mints to another player's holder.
#[test]
fn a_mismatched_triple_never_mints_to_another_holder() {
    let mut t = T::new();
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    t.play(&b, &[(FAR, 1_000_000, HALF)], HIT_AT);
    let hb = t.g.holder(&key(&b));
    let open_at = t.open();
    let bet = t.place(&a, open_at, &[(FAR, 1_000_000, HALF)]);
    t.g.set_time(open_at / 1000 + 4);
    let mut ix = t.g.post_and_settle_ix(open_at + 1000, HIT_AT, HIT_AT, HIT_AT, HIT_AT, &[(bet, key(&a))]);
    let n = ix.accounts.len();
    ix.accounts[n - 1].pubkey = holder_pda(&key(&b));
    assert!(t.g.send(&[ix], &[]).is_err());
    assert_eq!(t.g.holder(&key(&b)), hb);
}

const LONG: u32 = 10_000_000;

/// A game at S = $1 where the funder's loss has moved the tracked gain to 3S, then a long shot the pool pays all but a
/// fraction of a cent of: a dust IOU outstanding.
fn with_a_dust_iou() -> T {
    let mut t = T::new();
    let admin = t.g.admin.insecure_clone();
    let ix = t.g.set_rewards_config_ix(skech::state::RewardsConfig { mint_scale: E6, ..t.g.rewards().config });
    t.g.send(&[ix], &[&admin]).unwrap();
    let funder = t.g.player(100 * E6, 100 * E6);
    // $6 at 50%/1.5x with the 10% profit fee: a basis of $3.30, so G = 3.3S.
    t.play(&funder, &[(FAR, 6_000_000, HALF)], HIT_AT);
    assert_eq!(t.g.rewards().gain, 3_300_000);
    let small = t.g.player(10 * E6, 10 * E6);
    let m = t.play(&small, &[(AT, 67_400, LONG)], HIT_AT);
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert!(s[0].owed > 0 && s[0].owed < 10_000, "a dust IOU: {}", s[0].owed);
    assert!(t.g.pool().iou_shares > 0);
    t
}

/// Economic C2 / security M-1: while any IOU was outstanding, every loss minted from a tracked gain of 0, on its whole
/// basis: a dust IOU let a whale mint its loss at the top rate, many times the curve. Now the mint is the curve's
/// exact integral from where the gain is, whatever is owed.
#[test]
fn a_dust_iou_changes_nothing_about_what_a_whale_mints() {
    let mut t = with_a_dust_iou();
    let whale = t.g.player(100 * E6, 100 * E6);
    let open_at = t.open();
    let bet = t.place(&whale, open_at, &[(FAR, 10_000_000, HALF)]);
    assert!(t.g.pool().iou_shares > 0, "still outstanding at settlement");
    let from = t.g.rewards().gain;
    let m = t.settle(open_at, HIT_AT, &[(bet, key(&whale))]);
    let minted: Vec<skech::events::Minted> = events(&m.logs);
    assert_eq!(minted[0].basis, 5_500_000);
    assert_eq!(minted[0].skt as u128, skech::skt::mint_amount(E6, from, 5_500_000), "exactly the curve");
    assert!((minted[0].skt as u128) < skech::skt::mint_amount(E6, 0, 5_500_000) / 5, "nowhere near the top rate");
}

/// With an IOU outstanding, a basis minted in one settlement or in several mints the same, to a unit a piece: no
/// splitting advantage inside the old window.
#[test]
fn with_an_iou_outstanding_splitting_a_loss_mints_no_more() {
    let mint = |pieces: usize| -> u64 {
        let mut t = with_a_dust_iou();
        let whale = t.g.player(100 * E6, 100 * E6);
        let open_at = t.open();
        let mut bets = vec![];
        let each = 10_000_000 / pieces as u32;
        for _ in 0..pieces {
            bets.push((t.place(&whale, open_at, &[(FAR, each, HALF)]), key(&whale)));
        }
        // Each bet its own settlement.
        t.g.set_time(open_at / 1000 + 4);
        t.g.post_and_settle(open_at + 1000, HIT_AT, HIT_AT, HIT_AT, HIT_AT, &bets[..1]).unwrap();
        for b in &bets[1..] {
            t.g.settle_on(false, &[*b]).unwrap();
        }
        assert!(t.g.pool().iou_shares > 0);
        t.g.holder(&key(&whale)).minted
    };
    let one = mint(1);
    for pieces in [2usize, 5, 10] {
        let split = mint(pieces);
        assert!(split <= one && one - split <= pieces as u64, "{pieces} pieces: {split} against {one} in one");
    }
}

/// Security L-1: every player with a live bet in a settlement had a Holder opened at the settler's cost, even if
/// nothing of theirs could mint (a hit, a refund), and its rent was never returned. Now a Holder is opened only for a
/// player whose bet mints here: sybils with hit-only or refunded bets cost the relayer no Holder rent.
#[test]
fn a_holder_is_opened_only_for_a_player_whose_bet_mints() {
    let mut t = T::new();
    let funder = t.g.player(100 * E6, 100 * E6);
    t.play(&funder, &[(FAR, 1_000_000, HALF)], HIT_AT);
    // A winner: its band hits. The relayer gets the bet's rent back and pays the fee, and nothing else.
    let winner = t.g.player(10 * E6, 10 * E6);
    let open_at = t.open();
    let bet = t.place(&winner, open_at, &[(AT, 50_000, HALF)]);
    let before = t.g.svm.get_balance(&t.g.relayer.pubkey()).unwrap();
    let bet_rent = t.g.svm.get_balance(&bet).unwrap();
    let m = t.settle(open_at, HIT_AT, &[(bet, key(&winner))]);
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert_eq!((s[0].hit_mask, s[0].closed), (1, true));
    assert!(t.g.svm.get_account(&holder_pda(&key(&winner))).map_or(true, |a| a.data.is_empty()), "no holder for a winner");
    let after = t.g.svm.get_balance(&t.g.relayer.pubkey()).unwrap();
    assert_eq!(after, before + bet_rent - 5_000, "the relayer paid the fee and got the bet's rent back, no holder rent");
    // A refund: a band whose second is never posted, given back by expire. No holder either.
    let refunded = t.g.player(10 * E6, 10 * E6);
    let open_at = t.open();
    let bet = t.place(&refunded, open_at, &[(FAR, 50_000, HALF)]);
    t.g.set_time(open_at / 1000 + skech::state::BAR_LATE + 5);
    let m = t.g.settle_on(true, &[(bet, key(&refunded))]).unwrap();
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert_eq!((s[0].expired_mask, s[0].refunded), (1, 50_000));
    assert!(t.g.svm.get_account(&holder_pda(&key(&refunded))).map_or(true, |a| a.data.is_empty()), "no holder for a refund");
    // A loser: its miss mints, and its holder is opened then.
    let loser = t.g.player(10 * E6, 10 * E6);
    t.play(&loser, &[(FAR, 50_000, HALF)], HIT_AT);
    assert!(t.g.holder(&key(&loser)).minted > 0);
    // In one settlement, a hit and a miss of different players: only the loser's holder opens.
    let (w2, l2) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    let open_at = t.open();
    let (bw, bl) = (t.place(&w2, open_at, &[(AT, 50_000, HALF)]), t.place(&l2, open_at, &[(FAR, 50_000, HALF)]));
    t.settle(open_at, HIT_AT, &[(bw, key(&w2)), (bl, key(&l2))]);
    assert!(t.g.svm.get_account(&holder_pda(&key(&w2))).map_or(true, |a| a.data.is_empty()));
    assert!(t.g.holder(&key(&l2)).minted > 0);
}

/// Security L-2: until `init_rewards` ran after the upgrade, `expire` (and settle) could not run at all, so a live
/// bet's stake waited on the admin. Now both run without SKT's account: the stake comes back, nothing mints, no holder
/// opens, and the holders' share of a profit's fee goes to the treasury, as before SKT.
#[test]
fn before_init_rewards_bets_settle_and_expire() {
    let mut t = T::new();
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    t.play(&b, &[(FAR, 2_000_000, HALF)], HIT_AT);
    let open_at = t.open();
    let lose = t.place(&a, open_at, &[(FAR, 1_000_000, HALF)]);
    let win = t.place(&b, open_at, &[(AT, 100_000, HALF)]);
    // A band in second 5, whose bar never comes.
    t.drawing += 1;
    let piece = t.g.piece(&a, t.drawing, 0, open_at, &[(5, FAR, 5, 300_000)]);
    t.g.place(&a, &piece, &QuoteArgs { price: PRICE, momentum: 0, received_at: open_at - 300, chances: vec![HALF] }).unwrap();
    let stuck = bet_pda(&key(&a), t.drawing, 0).0;
    // As if these bets were live at the upgrade, before `init_rewards`: no Rewards account.
    t.g.svm.set_account(rewards_pda(), solana_account::Account::default()).unwrap();
    let fees = t.g.pool().fees;
    // Settled: the miss mints nothing and opens no holder; the hit's whole profit fee is the treasury's.
    let m = t.settle(open_at, HIT_AT, &[(lose, key(&a)), (win, key(&b))]);
    assert!(events::<skech::events::Minted>(&m.logs).is_empty());
    assert!(t.g.svm.get_account(&holder_pda(&key(&a))).map_or(true, |x| x.data.is_empty()));
    // 0.1 · 0.05 of profit (100,000 at 1.5x): 5,000 to the treasury, rounded up.
    assert_eq!(t.g.pool().fees - fees, 5_000);
    // Expired, its second never posted: the stake comes back.
    let before = t.g.player_state(&a).balance;
    t.g.set_time((open_at + 6_000) / 1000 + skech::state::BAR_LATE + 5);
    let m = t.g.settle_on(true, &[(stuck, key(&a))]).expect("expire without Rewards");
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert_eq!((s[0].expired_mask, s[0].refunded, s[0].closed), (1, 300_000, true));
    assert_eq!(t.g.player_state(&a).balance - before, 300_000);
    // Nobody can settle without SKT's account by passing another empty one in its place once it exists, or before.
    let open_at = t.open();
    t.g.svm.set_account(rewards_pda(), solana_account::Account::default()).unwrap();
    let mut ix = t.g.post_and_settle_ix(open_at + 1000, HIT_AT, HIT_AT, HIT_AT, HIT_AT, &[]);
    ix.accounts[5].pubkey = Pubkey::new_unique();
    t.g.set_time(open_at / 1000 + 4);
    assert_eq!(custom_error(&t.g.send(&[ix], &[])), Some(code(SkechError::BadSettleAccounts)));
}

/// Info items. A claim works while the game is paused, as a withdrawal does; a claim with nothing to pay is refused
/// rather than paid for; and SKT's mint scale cannot be changed once anything has minted.
#[test]
fn claims_while_paused_empty_claims_and_the_mint_scale() {
    let mut t = T::new();
    let admin = t.g.admin.insecure_clone();
    // The scale may be set before anything mints.
    let ix = t.g.set_rewards_config_ix(skech::state::RewardsConfig { mint_scale: 2 * E6, ..t.g.rewards().config });
    t.g.send(&[ix], &[&admin]).expect("set before any SKT");
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    t.play(&b, &[(FAR, 1_000_000, HALF)], HIT_AT);
    t.play(&a, &[(AT, 100_000, HALF)], HIT_AT);
    // Once SKT exists, no longer: the rest of the terms still may be.
    let ix = t.g.set_rewards_config_ix(skech::state::RewardsConfig { mint_scale: 3 * E6, ..t.g.rewards().config });
    assert_eq!(custom_error(&t.g.send(&[ix], &[&admin])), Some(code(SkechError::MintScaleFixed)));
    let ix = t.g.set_rewards_config_ix(skech::state::RewardsConfig { mint_scale: 2 * E6, holder_fee_bps: 200, ..t.g.rewards().config });
    t.g.send(&[ix], &[&admin]).expect("the split may change");
    // Paused: B still claims what its SKT earned.
    let pause = t.g.ix(skech::accounts::Admin { admin: admin.pubkey(), game: game_pda() }, skech::instruction::SetPaused { paused: true });
    t.g.send(&[pause], &[&admin]).unwrap();
    let w = b.wallet.insecure_clone();
    let before = t.g.player_state(&b).balance;
    t.g.send(&[t.g.claim_ix(&b)], &[&w]).expect("claimed while paused");
    assert!(t.g.player_state(&b).balance > before);
    // A second claim has nothing to pay: refused, so nobody pays a fee to move nothing.
    let r = t.g.send(&[t.g.claim_ix(&b)], &[&w]);
    assert_eq!(custom_error(&r), Some(code(SkechError::NothingToClaim)));
}

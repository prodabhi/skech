//! The game end to end, and every way a piece is refused.

use anchor_lang::prelude::Pubkey;
use anchor_lang::AnchorSerialize;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;

const S: i64 = 1_790_000_000;

/// A band right at the price, and one well above it: (second, lo in units, width, stake).
const AT: (u8, u32, u16, u32) = (1, 415_000, 5, 50_000);
const ABOVE: (u8, u32, u16, u32) = (2, 416_000, 5, 50_000);
const HALF: u32 = 500_000_000;

fn open_at() -> i64 {
    (S + 1) * 1000
}

#[test]
fn only_the_upgrade_authority_initializes() {
    let mut g = Game::deployed();
    let stranger = Keypair::new();
    g.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let r = g.send(&[g.initialize_ix(&stranger.pubkey())], &[&stranger]);
    assert_eq!(custom_error(&r), Some(code(SkechError::NotUpgradeAuthority)));
    let admin = g.admin.insecure_clone();
    g.send(&[g.initialize_ix(&admin.pubkey())], &[&admin]).unwrap();
    assert_eq!(g.game().admin, admin.pubkey());
    // Once only.
    assert!(g.send(&[g.initialize_ix(&admin.pubkey())], &[&admin]).is_err());
}

#[test]
fn a_piece_is_placed_hit_missed_and_closed() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let relayer_before = g.svm.get_balance(&g.relayer.pubkey()).unwrap();
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, ABOVE]);
    let quote = g.quote(&piece, HALF);
    let r = g.place(&p, &piece, &quote).expect("placed");
    println!("place, 2 sections: {} CU", r.compute_units_consumed);

    // 50% at difficulty 51 pays 1.5x: two bands of 5 cents, 4% of it to the house, the rest into the pool.
    assert_eq!(g.player_state(&p).balance, 10 * E6 - 100_000);
    assert_eq!(g.player_state(&p).session.allowance, 5 * E6 - 100_000);
    assert_eq!(g.pool().pool, 96_000);
    assert_eq!(g.pool().fees, 4_000);
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    let b: skech::state::Bet = g.account(&bet).unwrap();
    assert_eq!(b.sections.len(), 2);
    assert_eq!(b.sections[0].rung, 150);
    assert_eq!(b.live_mask, 0b11);

    // Second 1 runs through the band at the price: a hit, 7.5 cents less 10% of the profit.
    g.set_time(S + 3);
    let second = open_at() + 1000;
    g.post_and_settle(second, 83_000 * E8, 83_000 * E8 + 50_000_000, 82_999 * E8 + 80_000_000, 83_000 * E8 + 10_000_000, &[(bet, p.wallet.pubkey())]).expect("settled");
    assert_eq!(g.player_state(&p).balance, 10 * E6 - 100_000 + 72_500);
    let b: skech::state::Bet = g.account(&bet).unwrap();
    assert_eq!((b.live_mask, b.hit_mask), (0b10, 0b01));
    assert_eq!(g.pool().pool, 96_000 - 75_000);
    assert_eq!(g.pool().fees, 4_000 + 2_500);

    // Second 2 stays far below the other band: a miss, and the bet is done (its piece past its placing window), its
    // rent back with the relayer.
    g.set_time(S + 5);
    let r = g.post_and_settle(second + 1000, 83_000 * E8 + 10_000_000, 83_000 * E8 + 20_000_000, 82_999 * E8, 83_000 * E8, &[(bet, p.wallet.pubkey())]).expect("settled");
    println!("post and settle, 1 bet closed: {} CU", r.compute_units_consumed);
    assert!(g.account::<skech::state::Bet>(&bet).is_none());
    assert_eq!(g.player_state(&p).balance, 10 * E6 - 100_000 + 72_500);
    let fees_paid = relayer_before - g.svm.get_balance(&g.relayer.pubkey()).unwrap();
    // And the player's SKT account, opened by the first settlement that mints for them, is the relayer's rent to pay, once.
    let holder_rent = g.svm.minimum_balance_for_rent_exemption(skech::state::Holder::SPACE);
    assert!(fees_paid < 50_000 + holder_rent && fees_paid >= holder_rent, "the bet's rent came back: only fees and the holder's rent spent, {fees_paid} lamports");

    // The vault holds exactly the balances, the pool and the fees.
    let pool = g.pool();
    assert_eq!(token_balance(&g.svm, &g.vault()), g.player_state(&p).balance + pool.pool + pool.fees);
}

#[test]
fn refusals() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    let expect = |g: &mut Game, piece: &skech::piece::PieceMessage, quote: &skech::piece::QuoteArgs, signer: &Keypair, e: SkechError| {
        let r = g.place_signed(piece, quote, signer);
        assert_eq!(custom_error(&r), Some(code(e)), "{e:?}: {:?}", r.err().map(|f| f.meta.logs));
    };
    let session = p.session.insecure_clone();

    // Signed by anything but the session key.
    expect(&mut g, &piece, &quote, &Keypair::new(), SkechError::SessionSig);
    // The difficulty the player was shown has changed.
    let mut other = piece.clone();
    other.difficulty = 60;
    expect(&mut g, &other, &quote, &session, SkechError::Difficulty);
    // Received after its second opened, past the allowance for the network.
    let late = skech::piece::QuoteArgs { received_at: piece.open_at + 201, ..quote.clone() };
    expect(&mut g, &piece, &late, &session, SkechError::Late);
    // The price the player saw was too old when the piece was received.
    let mut stale = piece.clone();
    stale.price_time = quote.received_at - 15_001;
    expect(&mut g, &stale, &quote, &session, SkechError::StalePrice);
    // A band beyond the horizon.
    let mut far = piece.clone();
    far.sections[0].second = 31;
    expect(&mut g, &far, &quote, &session, SkechError::Sections);
    // Signed for another cluster or deployment.
    let mut elsewhere = piece.clone();
    elsewhere.domain = [9; 32];
    expect(&mut g, &elsewhere, &quote, &session, SkechError::Mismatch);
    // No chance, no rung: nothing offered.
    let none = skech::piece::QuoteArgs { chances: vec![0], ..quote.clone() };
    expect(&mut g, &piece, &none, &session, SkechError::NotOffered);
    // More than the session may stake.
    let mut big = g.piece(&p, 1, 1, open_at(), &[(1, 415_000, 5, 11_000_000)]);
    big.per_dot = 1_000_000;
    let big_quote = g.quote(&big, HALF);
    expect(&mut g, &big, &big_quote, &session, SkechError::Allowance);
    // Placed; then sent again, it is a replay.
    g.place(&p, &piece, &quote).expect("placed");
    expect(&mut g, &piece, &quote, &session, SkechError::Replay);
    // Outside the window: the chain's clock is well past the second it opens on.
    g.set_time(S + 10);
    let mut old = g.piece(&p, 2, 0, open_at(), &[AT]);
    old.price_time = old.open_at - 1_500;
    let old_quote = g.quote(&old, HALF);
    expect(&mut g, &old, &old_quote, &session, SkechError::Window);
}

#[test]
fn the_signature_must_cover_the_piece_itself() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    let bytes = piece.try_to_vec().unwrap();
    let place = g.place_ix(&piece, &quote);
    // A valid signature by the session key, but over a shorter stretch of the instruction: refused.
    let short = Game::ed25519_ix(&p.session, &bytes[..bytes.len() - 11], 1, 8, (bytes.len() - 11) as u16);
    let r = g.send(&[short, place.clone()], &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::SessionSig)));
    // Over the right bytes, but carried in the precompile's own data rather than read from the placement.
    let sig = p.session.sign_message(&bytes);
    let mut data = vec![1u8, 0];
    for v in [48u16, u16::MAX, 16, u16::MAX, 112, bytes.len() as u16, u16::MAX] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(p.session.pubkey().as_ref());
    data.extend_from_slice(sig.as_ref());
    data.extend_from_slice(&bytes);
    let inline = anchor_lang::solana_program::instruction::Instruction { program_id: skech::piece::ED25519_PROGRAM, accounts: vec![], data };
    let r = g.send(&[inline, place.clone()], &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::SessionSig)));
    // With no signature at all.
    let r = g.send(&[place], &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::SessionSig)));
}

#[test]
fn a_session_places_nothing_once_it_expires_or_is_revoked() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    let revoke = g.ix(skech::accounts::RevokeSession { authority: p.wallet.pubkey(), player: player_pda(&p.wallet.pubkey()) }, skech::instruction::RevokeSession {});
    g.send(&[revoke], &[&p.wallet]).unwrap();
    assert_eq!(custom_error(&g.place(&p, &piece, &quote)), Some(code(SkechError::Session)));
}

#[test]
fn a_win_the_pool_cannot_pay_is_owed_and_paid_off_later() {
    let mut g = Game::new();
    let winner = g.player(10 * E6, 5 * E6);
    // A 1% chance pays 96x at difficulty 51.
    let piece = g.piece(&winner, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, 10_000_000);
    g.place(&winner, &piece, &quote).unwrap();
    let (bet, _) = bet_pda(&winner.wallet.pubkey(), 1, 0);
    assert_eq!(g.account::<skech::state::Bet>(&bet).unwrap().sections[0].rung, 9600);
    g.set_time(S + 3);
    g.post_and_settle(open_at() + 1000, 83_000 * E8, 83_000 * E8 + 50_000_000, 83_000 * E8, 83_000 * E8, &[(bet, winner.wallet.pubkey())]).unwrap();
    // 4.80 gross, 0.475 the house's cut; the pool held 4.8 cents of it, all the player's.
    let due = 4_800_000 - 475_000;
    let w = g.player_state(&winner);
    assert_eq!(w.balance, 10 * E6 - 50_000 + 48_000);
    assert_eq!(w.iou_basis, due - 48_000);
    assert!(w.iou_shares > 0);
    assert_eq!(g.pool().pool, 0);
    // The house's cut comes after the player, from what the pool has left: nothing, and it is not owed.
    assert_eq!((g.pool().house_shares, g.pool().house_basis), (0, 0));

    // Someone else loses $20; a day later the winner redeems, and is paid what was owed and its growth.
    let loser = g.player(30 * E6, 25 * E6);
    g.set_time(S + 5);
    let lose = g.piece(&loser, 7, 0, (S + 6) * 1000, &[(1, 420_000, 5, 20_000_000)]);
    let mut lose = lose;
    lose.per_dot = 1_000_000;
    lose.price_time = lose.open_at - 1_500;
    let lq = skech::piece::QuoteArgs { received_at: lose.open_at - 300, ..g.quote(&lose, 850_000_000) };
    g.place(&loser, &lose, &lq).unwrap();
    g.set_time(S + 86_400);
    let redeem = g.ix(
        skech::accounts::Redeem { caller: winner.wallet.pubkey(), game: game_pda(), pool: pool_pda(), holder: player_pda(&winner.wallet.pubkey()), caller_player: None, system_program: anchor_lang::system_program::ID },
        skech::instruction::Redeem { shares: u128::MAX },
    );
    g.send(&[redeem], &[&winner.wallet]).unwrap();
    let w = g.player_state(&winner);
    assert_eq!((w.iou_shares, w.iou_basis), (0, 0));
    let owed = due - 48_000;
    let paid = w.balance - (10 * E6 - 50_000 + 48_000);
    // 0.1% a day, and nothing cut: the holder redeemed their own.
    assert!(paid >= owed + owed / 1000 - 2 && paid <= owed + owed / 1000 + 2, "paid {paid} for {owed} owed a day");

    // The house was never owed: nothing of its to redeem.
    let house = g.ix(skech::accounts::RedeemHouse { game: game_pda(), pool: pool_pda() }, skech::instruction::RedeemHouse {});
    assert_eq!(custom_error(&g.send(&[house], &[])), Some(code(SkechError::NothingToRedeem)));
    assert_eq!(g.pool().iou_shares, 0);
}

#[test]
fn usdc_in_the_wallet_is_swept_in_on_its_approval_and_nothing_else_is() {
    let mut g = Game::new();
    let p = g.player(0, 5 * E6);
    let game = game_pda();
    token_account(&mut g.svm, p.usdc, g.mint, p.wallet.pubkey(), 7 * E6, Some((game, 5 * E6)));
    let sweep = |g: &Game, from: Pubkey, player: Pubkey| {
        g.ix(skech::accounts::Sweep { game, player, from, vault: g.vault(), usdc_mint: g.mint, token_program: anchor_spl::token::spl_token::ID }, skech::instruction::Sweep {})
    };
    g.send(&[sweep(&g, p.usdc, player_pda(&p.wallet.pubkey()))], &[]).unwrap();
    assert_eq!(g.player_state(&p).balance, 5 * E6);
    assert_eq!(token_balance(&g.svm, &p.usdc), 2 * E6);
    // Someone else's approved tokens cannot be swept into this player's balance.
    let other = g.player(0, 0);
    let theirs = Pubkey::new_unique();
    token_account(&mut g.svm, theirs, g.mint, other.wallet.pubkey(), 3 * E6, Some((game, 3 * E6)));
    assert!(g.send(&[sweep(&g, theirs, player_pda(&p.wallet.pubkey()))], &[]).is_err());
}

#[test]
fn paused_nothing_is_placed_but_withdrawals_still_go() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let admin = g.admin.insecure_clone();
    let pause = g.ix(skech::accounts::Admin { admin: admin.pubkey(), game: game_pda() }, skech::instruction::SetPaused { paused: true });
    g.send(&[pause], &[&admin]).unwrap();
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    assert_eq!(custom_error(&g.place(&p, &piece, &quote)), Some(code(SkechError::Paused)));
    let w = g.withdraw_ix(&p, 4 * E6, p.usdc);
    g.send(&[w], &[&p.wallet]).unwrap();
    assert_eq!(g.player_state(&p).balance, 6 * E6);
    assert_eq!(token_balance(&g.svm, &p.usdc), 994 * E6);
    // Not more than the balance, and only by the wallet.
    let w = g.withdraw_ix(&p, 7 * E6, p.usdc);
    assert_eq!(custom_error(&g.send(&[w], &[&p.wallet])), Some(code(SkechError::Insufficient)));
}

#[test]
fn fees_go_to_the_treasury() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, ABOVE]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).unwrap();
    let collect = g.ix(
        skech::accounts::CollectFees { game: game_pda(), pool: pool_pda(), vault: g.vault(), treasury: g.treasury, usdc_mint: g.mint, token_program: anchor_spl::token::spl_token::ID },
        skech::instruction::CollectFees {},
    );
    g.send(&[collect], &[]).unwrap();
    assert_eq!(token_balance(&g.svm, &g.treasury), 4_000);
    assert_eq!(g.pool().fees, 0);
}

#[test]
fn bars_follow_on_and_are_never_early_or_rewritten() {
    let mut g = Game::new();
    g.set_time(S + 3);
    let second = (S + 2) * 1000;
    g.post_and_settle(second, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).unwrap();
    // The same bar again is fine; a different one is not.
    g.post_and_settle(second, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).unwrap();
    assert_eq!(custom_error(&g.post_and_settle(second, 83_000 * E8, 83_002 * E8, 82_999 * E8, 83_000 * E8, &[])), Some(code(SkechError::BarConflict)));
    // The next must open where this one closed.
    assert_eq!(custom_error(&g.post_and_settle(second + 1000, 83_005 * E8, 83_006 * E8, 83_004 * E8, 83_005 * E8, &[])), Some(code(SkechError::BarDiscontinuous)));
    // A second that is not over yet.
    assert_eq!(custom_error(&g.post_and_settle((S + 10) * 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[])), Some(code(SkechError::BadBar)));
    // Only the oracle posts.
    let stranger = Keypair::new();
    let ix = g.ix(
        skech::accounts::PostBar { oracle: stranger.pubkey(), game: game_pda(), market_account: market_pda(0), bars: bars_pda(0) },
        skech::instruction::PostBar { market: 0, bar: skech::instructions::BarInput { second: second + 1000, prev_close: 83_000 * E8, high: 83_000 * E8, low: 83_000 * E8, close: 83_000 * E8 } },
    );
    assert_eq!(custom_error(&g.send(&[ix], &[&stranger])), Some(code(SkechError::NotOracle)));
}

#[test]
fn a_band_in_a_second_already_posted_is_not_offered() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    g.set_time(S + 1);
    g.post_and_settle(open_at() + 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).unwrap();
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, ABOVE]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).unwrap();
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    let b: skech::state::Bet = g.account(&bet).unwrap();
    assert_eq!(b.sections.len(), 1);
    assert_eq!(b.sections[0].second, 2);
    assert_eq!(g.player_state(&p).balance, 10 * E6 - 50_000);
}

#[test]
fn the_admin_is_handed_over_in_two_steps_and_the_config_is_checked() {
    let mut g = Game::new();
    let admin = g.admin.insecure_clone();
    let next = Keypair::new();
    let mut bad = g.game().config;
    bad.fee_bps = 2001;
    let set = g.set_config_ix(bad);
    assert_eq!(custom_error(&g.send(&[set], &[&admin])), Some(code(SkechError::BadConfig)));
    let propose = g.ix(skech::accounts::Admin { admin: admin.pubkey(), game: game_pda() }, skech::instruction::ProposeAdmin { admin: next.pubkey() });
    let r = g.send(&[propose], &[&admin]).unwrap();
    assert!(r.logs.iter().any(|l| l.starts_with("Program data: ")), "said so in an event");
    assert_eq!(g.game().admin, admin.pubkey());
    // Only the one proposed may take over.
    let stranger = Keypair::new();
    let accept = g.ix(skech::accounts::AcceptAdmin { new_admin: stranger.pubkey(), game: game_pda() }, skech::instruction::AcceptAdmin {});
    assert_eq!(custom_error(&g.send(&[accept], &[&stranger])), Some(code(SkechError::NotPendingAdmin)));
    // What is owed grows by 1% a day at most.
    let rate = |g: &Game, r: u64| g.ix(skech::accounts::SetIouRate { admin: admin.pubkey(), game: game_pda(), pool: pool_pda() }, skech::instruction::SetIouRate { rate: r });
    let too_fast = rate(&g, skech::state::MAX_IOU_RATE + 1);
    assert_eq!(custom_error(&g.send(&[too_fast], &[&admin])), Some(code(SkechError::BadConfig)));
    let fastest = rate(&g, skech::state::MAX_IOU_RATE);
    g.send(&[fastest], &[&admin]).unwrap();
    let accept = g.ix(skech::accounts::AcceptAdmin { new_admin: next.pubkey(), game: game_pda() }, skech::instruction::AcceptAdmin {});
    g.send(&[accept], &[&next]).unwrap();
    assert_eq!(g.game().admin, next.pubkey());
    // The old admin can do nothing now.
    let set = g.ix(skech::accounts::Admin { admin: admin.pubkey(), game: game_pda() }, skech::instruction::SetPaused { paused: true });
    assert_eq!(custom_error(&g.send(&[set], &[&admin])), Some(code(SkechError::NotAdmin)));
}

#[test]
fn a_band_never_posted_is_given_back_once_it_never_can_be() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let relayer_before = g.svm.get_balance(&g.relayer.pubkey()).unwrap();
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, ABOVE]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).unwrap();
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    let fee = g.pool().fees;
    let staked = 100_000;

    // Second 1 is posted and misses; second 2 never is. Expiring decides what has a bar, and waits on the rest.
    g.set_time(S + 3);
    g.post_and_settle(open_at() + 1000, 82_990 * E8, 82_995 * E8, 82_990 * E8, 82_995 * E8, &[]).unwrap();
    g.settle_on(true, &[(bet, p.wallet.pubkey())]).unwrap();
    let b: skech::state::Bet = g.account(&bet).unwrap();
    assert_eq!((b.live_mask, b.hit_mask), (0b10, 0));

    // Once second 2 is too late to post, settling still waits; expiring gives all its stake back, as on Monad.
    let second_two = open_at() + 2000;
    g.set_time((second_two + 1000) / 1000 + skech::state::BAR_LATE);
    g.settle_on(true, &[(bet, p.wallet.pubkey())]).unwrap();
    assert!(g.account::<skech::state::Bet>(&bet).is_some(), "not late yet: it could still be posted");
    g.set_time(g.now + 1);
    g.settle_on(false, &[(bet, p.wallet.pubkey())]).unwrap();
    assert!(g.account::<skech::state::Bet>(&bet).is_some(), "settle never gives stakes back");
    g.settle_on(true, &[(bet, p.wallet.pubkey())]).unwrap();
    assert!(g.account::<skech::state::Bet>(&bet).is_none(), "closed");
    let back = 50_000;
    assert_eq!(g.player_state(&p).balance, 10 * E6 - staked + back);
    assert_eq!(g.pool().pool, staked - fee - back);
    assert_eq!(g.pool().fees, fee);
    let pool = g.pool();
    assert_eq!(token_balance(&g.svm, &g.vault()), g.player_state(&p).balance + pool.pool + pool.fees);
    let holder_rent = g.svm.minimum_balance_for_rent_exemption(skech::state::Holder::SPACE);
    assert!(relayer_before - g.svm.get_balance(&g.relayer.pubkey()).unwrap() < 50_000 + holder_rent, "the rent came back");
}

#[test]
fn an_oracle_that_stops_leaves_every_stake_to_come_back() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, ABOVE]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).unwrap();
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    let fee = g.pool().fees;
    // Nothing is posted, ever: once the last band's second is too late, anyone gives it all back but the fee.
    g.set_time(S + 10 + skech::state::BAR_LATE);
    let anyone = Keypair::new();
    g.svm.airdrop(&anyone.pubkey(), 1_000_000_000).unwrap();
    let accounts = skech::accounts::Settle { payer: anyone.pubkey(), ..g.settle_accounts(g.relayer.pubkey()) };
    let ix = Game::with_bets(g.ix(accounts, skech::instruction::Expire { market: 0 }), &[(bet, p.wallet.pubkey())]);
    let msg = solana_message::Message::new(&[ix], Some(&anyone.pubkey()));
    let tx = solana_transaction::Transaction::new(&[&anyone], msg, g.svm.latest_blockhash());
    g.svm.send_transaction(tx).expect("expired");
    assert!(g.account::<skech::state::Bet>(&bet).is_none());
    assert_eq!(g.player_state(&p).balance, 10 * E6 - fee);
    assert_eq!((g.pool().pool, g.pool().fees), (0, fee));
}

#[test]
fn a_market_closed_to_new_pieces_still_settles_the_ones_in_it() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    g.place(&p, &piece, &g.quote(&piece, HALF)).unwrap();
    let admin = g.admin.insecure_clone();
    let close = g.ix(skech::accounts::SetMarket { admin: admin.pubkey(), game: game_pda(), market: market_pda(0) }, skech::instruction::SetMarket { active: false, difficulty: 51 });
    g.send(&[close], &[&admin]).unwrap();
    let next = g.piece(&p, 2, 0, open_at(), &[AT]);
    assert_eq!(custom_error(&g.place(&p, &next, &g.quote(&next, HALF))), Some(code(SkechError::MarketInactive)));
    g.set_time(S + 5);
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    g.post_and_settle(open_at() + 1000, 83_000 * E8, 83_000 * E8 + 50_000_000, 82_999 * E8 + 80_000_000, 83_000 * E8, &[(bet, p.wallet.pubkey())]).expect("settled");
    assert!(g.account::<skech::state::Bet>(&bet).is_none());
    // A hit: 7.25 cents, what the pool held of it paid and the rest owed.
    let ps = g.player_state(&p);
    assert_eq!(ps.balance + ps.iou_basis, 10 * E6 - 50_000 + 72_500);
}

#[test]
fn a_bet_someone_else_paid_the_rent_of_is_settled_and_left_for_them_to_close() {
    let mut g = Game::new();
    let (a, b) = (g.player(10 * E6, 5 * E6), g.player(10 * E6, 5 * E6));
    let piece = g.piece(&a, 1, 0, open_at(), &[AT]);
    g.place(&a, &piece, &g.quote(&piece, HALF)).unwrap();
    // B's piece is sent, and its rent paid, by another relayer.
    let other = Keypair::new();
    g.svm.airdrop(&other.pubkey(), 10_000_000_000).unwrap();
    let theirs = g.piece(&b, 1, 0, open_at(), &[AT]);
    let bytes = theirs.try_to_vec().unwrap();
    let ed = Game::ed25519_ix(&b.session, &bytes, 1, 8, bytes.len() as u16);
    let mut place = g.place_ix(&theirs, &g.quote(&theirs, HALF));
    place.accounts[0].pubkey = other.pubkey();
    g.send(&[ed, place], &[&other]).unwrap();
    let (bet_a, bet_b) = (bet_pda(&a.wallet.pubkey(), 1, 0).0, bet_pda(&b.wallet.pubkey(), 1, 0).0);

    // Both settle in one batch; only the bet whose rent the receiver paid is closed.
    g.set_time(S + 5);
    let pairs = [(bet_a, a.wallet.pubkey()), (bet_b, b.wallet.pubkey())];
    g.post_and_settle(open_at() + 1000, 83_000 * E8, 83_000 * E8 + 50_000_000, 82_999 * E8 + 80_000_000, 83_000 * E8, &pairs).expect("the batch goes through");
    assert!(g.account::<skech::state::Bet>(&bet_a).is_none());
    assert_eq!(g.account::<skech::state::Bet>(&bet_b).unwrap().live_mask, 0);
    // Both hit, and both are paid the same (B partly owed: the pool ran out on A).
    let (pa, pb) = (g.player_state(&a), g.player_state(&b));
    assert_eq!(pa.balance, pb.balance + pb.iou_basis, "both paid");
    // Whoever paid it closes it, and has the rent back.
    let before = g.svm.get_balance(&other.pubkey()).unwrap();
    let ix = Game::with_bets(g.ix(g.settle_accounts(other.pubkey()), skech::instruction::Settle { market: 0 }), &[(bet_b, b.wallet.pubkey())]);
    g.send(&[ix], &[]).unwrap();
    assert!(g.account::<skech::state::Bet>(&bet_b).is_none());
    assert!(g.svm.get_balance(&other.pubkey()).unwrap() > before);
}

/// A player owed an IOU, the pool refilled, and a day gone by: what the IOU is worth has grown.
fn owed_a_day(g: &mut Game) -> Player {
    let winner = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&winner, 1, 0, open_at(), &[AT]);
    g.place(&winner, &piece, &g.quote(&piece, 10_000_000)).unwrap();
    g.set_time(S + 5);
    let (bet, _) = bet_pda(&winner.wallet.pubkey(), 1, 0);
    g.post_and_settle(open_at() + 1000, 83_000 * E8, 83_000 * E8 + 50_000_000, 83_000 * E8, 83_000 * E8, &[(bet, winner.wallet.pubkey())]).unwrap();
    let loser = g.player(30 * E6, 25 * E6);
    let mut lose = g.piece(&loser, 7, 0, (S + 6) * 1000, &[(1, 420_000, 5, 20_000_000)]);
    lose.per_dot = 1_000_000;
    lose.price_time = lose.open_at - 1_500;
    let lq = skech::piece::QuoteArgs { received_at: lose.open_at - 300, ..g.quote(&lose, 850_000_000) };
    g.place(&loser, &lose, &lq).unwrap();
    g.set_time(S + 86_400);
    winner
}

fn redeem_ix(g: &Game, caller: &Keypair, holder: &Player, caller_player: Option<Pubkey>) -> anchor_lang::solana_program::instruction::Instruction {
    g.ix(
        skech::accounts::Redeem { caller: caller.pubkey(), game: game_pda(), pool: pool_pda(), holder: player_pda(&holder.wallet.pubkey()), caller_player, system_program: anchor_lang::system_program::ID },
        skech::instruction::Redeem { shares: u128::MAX },
    )
}

#[test]
fn whoever_redeems_someone_elses_iou_is_paid_the_cut_as_on_monad() {
    let mut g = Game::new();
    let holder = owed_a_day(&mut g);
    let (owed, before) = (g.player_state(&holder).iou_basis, g.player_state(&holder).balance);
    let fees = g.pool().fees;
    // The relayer redeems it, into an account of its own opened on the way.
    let relayer = g.relayer.insecure_clone();
    g.send(&[redeem_ix(&g, &relayer, &holder, Some(player_pda(&relayer.pubkey())))], &[]).unwrap();
    let value = g.player_state(&holder).balance - before;
    let mine: skech::state::Player = g.account(&player_pda(&relayer.pubkey())).unwrap();
    let growth = value + mine.balance - owed;
    assert!(growth > 0);
    assert_eq!(mine.balance, growth * 1000 / 10_000, "a tenth of the growth");
    assert_eq!(mine.authority, relayer.pubkey());
    assert_eq!(g.pool().fees, fees, "none of it to the house");
    let pool = g.pool();
    let players: u64 = [holder.wallet.pubkey(), relayer.pubkey()].iter().map(|w| g.account::<skech::state::Player>(&player_pda(w)).unwrap().balance).sum();
    assert!(token_balance(&g.svm, &g.vault()) >= players + pool.pool + pool.fees);
}

#[test]
fn a_redeemer_with_no_account_takes_no_cut_and_a_holder_none_of_their_own() {
    let mut g = Game::new();
    let holder = owed_a_day(&mut g);
    let wallet = holder.wallet.insecure_clone();
    // Their own, with their own account as the caller's: refused, and no cut however it is sent.
    let own = redeem_ix(&g, &wallet, &holder, Some(player_pda(&wallet.pubkey())));
    assert_eq!(custom_error(&g.send(&[own], &[&wallet])), Some(code(SkechError::OwnRedeem)));
    let relayer = g.relayer.insecure_clone();
    let before = g.player_state(&holder).balance;
    let owed = g.player_state(&holder).iou_basis;
    g.send(&[redeem_ix(&g, &relayer, &holder, None)], &[]).unwrap();
    assert!(g.player_state(&holder).balance - before > owed, "all of it, growth and all");
    assert!(g.account::<skech::state::Player>(&player_pda(&relayer.pubkey())).is_none());
}

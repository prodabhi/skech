//! Every way found to cheat the game, each refused: the attack as it was first shown to work, and what stops it.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::AnchorSerialize;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;
use skech::state::BET_SEED;

const S: i64 = 1_790_000_000;
const AT: (u8, u32, u16, u32) = (1, 415_000, 5, 50_000);
const HALF: u32 = 500_000_000;

fn open_at() -> i64 {
    (S + 1) * 1000
}

/// A bet's address at every bump but the canonical one: about half of them are valid PDAs.
fn other_bet_addresses(wallet: &Pubkey, drawing: u64, index: u32) -> Vec<Pubkey> {
    let (_, canonical) = bet_pda(wallet, drawing, index);
    let (d, i) = (drawing.to_le_bytes(), index.to_le_bytes());
    (0..canonical).rev().filter_map(|bump| Pubkey::create_program_address(&[BET_SEED, wallet.as_ref(), &d, &i, &[bump]], &skech::ID).ok()).collect()
}

#[test]
fn a_piece_is_placed_once_not_again_at_another_bump() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, open_at(), &[AT]);
    let quote = g.quote(&piece, HALF);
    g.place(&p, &piece, &quote).expect("placed");
    let balance = g.player_state(&p).balance;
    let others = other_bet_addresses(&p.wallet.pubkey(), 1, 0);
    assert!(others.len() >= 3);
    // The same signed piece, sent again with its bet at another valid address: refused every time.
    for bet in others.into_iter().take(3) {
        let bytes = piece.try_to_vec().unwrap();
        let ed = Game::ed25519_ix(&p.session, &bytes, 1, 8, bytes.len() as u16);
        let mut place = g.place_ix(&piece, &quote);
        place.accounts[8].pubkey = bet;
        assert_eq!(custom_error(&g.send(&[ed, place], &[])), Some(code(SkechError::Mismatch)));
    }
    assert_eq!(g.player_state(&p).balance, balance, "charged once");
}

#[test]
fn a_posted_bar_is_never_replaced_through_its_slot() {
    let mut g = Game::new();
    g.set_time(S + 3);
    let x = (S + 2) * 1000;
    g.post_and_settle(x, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).unwrap();
    // The second 240 before shares its slot: posting it would wipe this one, so it is too late to post.
    let r = g.post_and_settle(x - 240_000, E8, E8, E8, E8, &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::BarLate)));
    // So this second is still what was posted, and a different bar for it is refused.
    let r = g.post_and_settle(x, 83_000 * E8, 90_000 * E8, 82_999 * E8, 83_000 * E8, &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::BarConflict)));
}

#[test]
fn a_bar_may_be_posted_up_to_bar_late_seconds_after_its_second() {
    let mut g = Game::new();
    let late = skech::state::BAR_LATE;
    let x = (S + 2) * 1000;
    // Its second is over at S + 3: BAR_LATE seconds after, it still goes in; a second more, and it is too late.
    g.set_time(S + 3 + late);
    g.post_and_settle(x, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]).expect("just in time");
    g.set_time(S + 4 + late + 1);
    let r = g.post_and_settle(x + 1000, 83_000 * E8, 83_001 * E8, 82_999 * E8, 83_000 * E8, &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::BarLate)));
}

#[test]
fn a_vault_made_first_by_someone_else_does_not_stop_the_game_being_set_up() {
    let mut g = Game::deployed();
    // Anyone may create the game's associated token account before the admin initializes.
    let (vault, mint) = (g.vault(), g.mint);
    token_account(&mut g.svm, vault, mint, game_pda(), 0, None);
    let admin = g.admin.insecure_clone();
    g.send(&[g.initialize_ix(&admin.pubkey())], &[&admin]).expect("initialized");
    assert_eq!(g.game().vault, vault);
}

#[test]
fn usdc_under_token_2022_is_refused() {
    let mut g = Game::deployed();
    let token_2022 = anchor_lang::prelude::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    let mut mint = g.svm.get_account(&g.mint).unwrap();
    mint.owner = token_2022;
    g.svm.set_account(g.mint, mint).unwrap();
    let admin = g.admin.insecure_clone();
    let mut ix = g.initialize_ix(&admin.pubkey());
    ix.accounts[4].pubkey = anchor_spl::associated_token::get_associated_token_address_with_program_id(&game_pda(), &g.mint, &token_2022);
    ix.accounts[8].pubkey = token_2022;
    assert_eq!(custom_error(&g.send(&[ix], &[&admin])), Some(code(SkechError::NotSplToken)));
}

#[test]
fn a_band_past_any_price_is_refused_not_a_crash() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    let mut piece = g.piece(&p, 1, 0, open_at(), &[(1, 4_000_000_000, 5, 50_000)]);
    piece.unit = 1_000_000_000_000;
    let mut quote = g.quote(&piece, HALF);
    quote.price = 2_000_000_000_000_000;
    assert_eq!(custom_error(&g.place(&p, &piece, &quote)), Some(code(SkechError::Sections)));
}

/// The probe program (`tests/cpi-probe`), built on first use.
fn probe() -> Vec<u8> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy");
    let so = format!("{dir}/cpi_probe.so");
    if !std::path::Path::new(&so).exists() {
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/cpi-probe/Cargo.toml");
        let ok = std::process::Command::new("cargo").args(["build-sbf", "--manifest-path", manifest, "--sbf-out-dir", dir]).status().map(|s| s.success()).unwrap_or(false);
        assert!(ok, "could not build tests/cpi-probe: cargo build-sbf --manifest-path {manifest} --sbf-out-dir {dir}");
    }
    std::fs::read(so).unwrap()
}

#[test]
fn a_signature_for_one_piece_places_no_other_from_inside_another_program() {
    let mut g = Game::new();
    let probe_id = Pubkey::new_unique();
    g.svm.add_program(probe_id, &probe()).unwrap();
    let p = g.player(10 * E6, 5 * E6);
    // What the player signed: a nickel on one band.
    let signed = g.piece(&p, 1, 0, open_at(), &[AT]);
    let signed_bytes = signed.try_to_vec().unwrap();
    // What is placed instead, the same length: a dollar a dot on another drawing.
    let mut forged = g.piece(&p, 2, 0, open_at(), &[(1, 415_000, 5, 1_000_000)]);
    forged.per_dot = 1_000_000;
    let quote = g.quote(&forged, HALF);
    assert_eq!(forged.try_to_vec().unwrap().len(), signed_bytes.len());
    // The probe's data carries the signed piece from byte 8, where the Ed25519 instruction verifies it; the placement
    // it passes on carries the forged one.
    let place = g.place_ix(&forged, &quote);
    let mut data = (signed_bytes.len() as u16).to_le_bytes().to_vec();
    data.resize(8, 0);
    data.extend_from_slice(&signed_bytes);
    data.extend_from_slice(&place.data);
    let mut accounts = vec![AccountMeta::new_readonly(skech::ID, false)];
    accounts.extend(place.accounts);
    let outer = Instruction { program_id: probe_id, accounts, data };
    let ed = Game::ed25519_ix(&p.session, &signed_bytes, 1, 8, signed_bytes.len() as u16);
    let r = g.send(&[ed, outer], &[]);
    assert_eq!(custom_error(&r), Some(code(SkechError::SessionSig)), "{:?}", r.as_ref().map(|m| &m.logs));
    assert_eq!(g.player_state(&p).balance, 10 * E6);
}

#[test]
fn a_bet_decided_while_its_piece_could_still_be_placed_stays_until_it_cannot() {
    let mut g = Game::new();
    let p = g.player(10 * E6, 5 * E6);
    // Two bands; the oracle offers only the first (no chance, no rung for the second).
    let piece = g.piece(&p, 1, 0, open_at(), &[AT, (5, 416_000, 5, 50_000)]);
    let mut quote = g.quote(&piece, HALF);
    quote.chances[1] = 0;
    g.place(&p, &piece, &quote).unwrap();
    let (bet, _) = bet_pda(&p.wallet.pubkey(), 1, 0);
    let balance = g.player_state(&p).balance;
    // Its one band is decided inside the placing window: the bet stays, so the piece cannot go in again, now
    // offering the band it was not offered before.
    g.set_time(S + 3);
    g.post_and_settle(open_at() + 1000, 82_990 * E8, 82_995 * E8, 82_990 * E8, 82_995 * E8, &[(bet, p.wallet.pubkey())]).unwrap();
    assert_eq!(g.account::<skech::state::Bet>(&bet).unwrap().live_mask, 0);
    let again = g.quote(&piece, HALF);
    assert_eq!(custom_error(&g.place(&p, &piece, &again)), Some(code(SkechError::Replay)));
    assert_eq!(g.player_state(&p).balance, balance);
    // Past the window it closes on the next settle, with nothing more to decide; placing it again is too late.
    g.set_time(S + 5);
    g.settle_on(false, &[(bet, p.wallet.pubkey())]).unwrap();
    assert!(g.account::<skech::state::Bet>(&bet).is_none());
    assert_eq!(custom_error(&g.place(&p, &piece, &again)), Some(code(SkechError::Window)));
}

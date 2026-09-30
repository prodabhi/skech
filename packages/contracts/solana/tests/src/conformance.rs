//! Replays the conformance cases (`packages/contracts/conformance/vectors.json`) against the Solana program. The
//! EVM game replays the same file (`evm/test/Conformance.t.sol`): both chains must give the same rungs, stakes,
//! fees, hits, payouts, IOUs and balances, step for step.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, Discriminator};
use base64::Engine;
use serde::Deserialize;
use solana_signer::Signer;
use std::collections::HashMap;

use crate::harness::*;
use skech::error::SkechError;
use skech::piece::{PieceMessage, QuoteArgs, SectionArg};

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    players: HashMap<String, PlayerIn>,
    difficulty: u8,
    fee_bps: u16,
    profit_fee_bps: u16,
    price: u64,
    unit: u64,
    skt: Option<SktIn>,
    steps: Vec<Step>,
    expect: Vec<StepOut>,
    /// What Solana does where it differs from the EVM game (it does not offer ink that returns more than the stake fee
    /// leaves, nor a band taller than the widest pen): `expect` otherwise.
    expect_solana: Option<Vec<StepOut>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SktIn {
    holder_fee_bps: u16,
    holder_profit_fee_bps: u16,
    mint_scale: u64,
    wallet_cap_bps: Option<u16>,
    cap_floor: Option<u64>,
}
#[derive(Deserialize)]
struct PlayerIn {
    deposit: u64,
    allowance: u64,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Step {
    Place { place: PlaceIn },
    Bar { bar: BarIn },
    Difficulty { difficulty: u8 },
    Claim { claim: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceIn {
    id: String,
    player: Option<String>,
    per_dot: Option<u32>,
    difficulty: Option<u8>,
    momentum: Option<i64>,
    sections: Vec<SectionIn>,
    received: Option<i64>,
    price_age: Option<i64>,
}
#[derive(Deserialize)]
struct SectionIn {
    second: u8,
    lo: u32,
    width: u16,
    stake: u32,
    chance: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BarIn {
    second: i64,
    prev_close: u64,
    high: u64,
    low: u64,
    close: u64,
    settle: Vec<String>,
}
#[derive(Deserialize)]
struct StepOut {
    place: Option<PlaceOut>,
    settled: Option<Vec<SettledOut>>,
    difficulty: Option<DifficultyOut>,
    claimed: Option<u64>,
    state: State,
}
#[derive(Deserialize)]
struct DifficultyOut {
    ok: bool,
}
#[derive(Deserialize)]
struct PlaceOut {
    ok: bool,
    refused: Option<String>,
    sections: Option<Vec<BandOut>>,
    staked: Option<u64>,
    fee: Option<u64>,
}
#[derive(Deserialize)]
struct BandOut {
    second: u8,
    lo: u64,
    hi: u64,
    stake: u64,
    rung: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettledOut {
    id: String,
    hit_mask: u32,
    miss_mask: u32,
    paid: u64,
    owed: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    balance: HashMap<String, u64>,
    allowance: HashMap<String, u64>,
    pool: u64,
    fees: u64,
    owed: HashMap<String, u64>,
    house_owed: u64,
    skt: Option<SktState>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SktState {
    supply: String,
    total_shares: String,
    acc: String,
    holder_funds: u64,
    gain: u64,
    holders: HashMap<String, HolderState>,
}
#[derive(Deserialize)]
struct HolderState {
    shares: String,
    basis: u64,
    claimable: u64,
}

const S: i64 = 1_790_000_000;

fn refusal(name: &str) -> SkechError {
    match name {
        "Mismatch" => SkechError::Mismatch,
        "Replay" => SkechError::Replay,
        "Difficulty" => SkechError::Difficulty,
        "Late" => SkechError::Late,
        "StalePrice" => SkechError::StalePrice,
        "PerDot" => SkechError::PerDot,
        "Sections" => SkechError::Sections,
        "Session" => SkechError::Session,
        "SessionSig" => SkechError::SessionSig,
        "NotOffered" => SkechError::NotOffered,
        "Allowance" => SkechError::Allowance,
        "Balance" => SkechError::Balance,
        other => panic!("a refusal the program has no name for: {other}"),
    }
}

/// The program's events of one kind in a transaction's logs.
fn events<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        .filter(|b| b.starts_with(E::DISCRIMINATOR))
        .map(|b| E::deserialize(&mut &b[8..]).unwrap())
        .collect()
}

fn drawing_of(id: &str) -> u64 {
    u64::from_le_bytes(solana_sha256_hasher::hash(id.as_bytes()).to_bytes()[..8].try_into().unwrap())
}

fn run(c: &Case) {
    let mut g = Game::new();
    g.set_time(S);
    let admin = g.admin.insecure_clone();
    let mut config = g.game().config;
    config.fee_bps = c.fee_bps;
    config.profit_fee_bps = c.profit_fee_bps;
    config.late_ms = 200;
    config.place_grace_ms = 3000;
    config.max_price_age_ms = 15_000;
    config.min_per_dot = 10_000;
    config.max_per_dot = 10_000_000;
    config.max_piece_stake = 1_000_000_000;
    // SKT's split first, so the case's fees (2%, which the default 3% split does not fit in) pass.
    let split = c.skt.as_ref().map(|s| skech::state::RewardsConfig { holder_fee_bps: s.holder_fee_bps, holder_profit_fee_bps: s.holder_profit_fee_bps, mint_scale: s.mint_scale, wallet_cap_bps: s.wallet_cap_bps.unwrap_or(10_000), cap_floor: s.cap_floor.unwrap_or(0), ..skech::state::RewardsConfig::DEFAULT }).unwrap_or(skech::state::RewardsConfig { holder_fee_bps: 0, holder_profit_fee_bps: 0, ..skech::state::RewardsConfig::DEFAULT });
    let zero = skech::state::RewardsConfig { holder_fee_bps: 0, holder_profit_fee_bps: 0, ..split };
    g.send(&[g.set_rewards_config_ix(zero), g.set_config_ix(config), g.set_rewards_config_ix(split)], &[&admin]).expect("config");
    let market = g.ix(skech::accounts::SetMarket { admin: admin.pubkey(), game: game_pda(), market: market_pda(0) }, skech::instruction::SetMarket { active: true, difficulty: c.difficulty });
    g.send(&[market], &[&admin]).expect("difficulty");
    let mut names: Vec<&String> = c.players.keys().collect();
    names.sort();
    let players: HashMap<String, Player> = names.iter().map(|n| ((*n).clone(), g.player(c.players[*n].deposit, c.players[*n].allowance))).collect();
    let open_at = (S + 1) * 1000;
    let mut bets: HashMap<String, (Pubkey, Pubkey)> = HashMap::new();

    for (i, (step, want)) in c.steps.iter().zip(c.expect_solana.as_ref().unwrap_or(&c.expect)).enumerate() {
        let at = format!("{} · step {}", c.name, i + 1);
        match step {
            Step::Claim { claim } => {
                let who = &players[claim];
                let before = g.player_state(who).balance;
                let w = who.wallet.insecure_clone();
                let r = g.send(&[g.claim_ix(who)], &[&w]);
                let want = want.claimed.expect("a claim step's expectation");
                // Nothing to claim is refused, so a claim is never paid for to move nothing; with no SKT account at all,
                // there is nothing to claim from.
                if want == 0 {
                    let e = custom_error(&r);
                    assert!(e == Some(code(SkechError::NothingToClaim)) || e == Some(anchor_lang::error::ErrorCode::AccountNotInitialized as u32), "{at}: an empty claim: {e:?}");
                } else {
                    r.unwrap_or_else(|f| panic!("{at}: claim refused ({:?}) {:?}", f.err, f.meta.logs));
                }
                assert_eq!(g.player_state(who).balance - before, want, "{at}: claimed");
            }
            Step::Difficulty { difficulty } => {
                let ok = want.difficulty.as_ref().expect("a difficulty step's expectation").ok;
                let market = |g: &Game| g.account::<skech::state::Market>(&market_pda(0)).unwrap().difficulty;
                let before = market(&g);
                let set = g.ix(skech::accounts::SetMarket { admin: admin.pubkey(), game: game_pda(), market: market_pda(0) }, skech::instruction::SetMarket { active: true, difficulty: *difficulty });
                let r = g.send(&[set], &[&admin]);
                if ok {
                    r.unwrap_or_else(|f| panic!("{at}: difficulty {difficulty} refused ({:?})", f.err));
                    assert_eq!(market(&g), *difficulty, "{at}: difficulty");
                } else {
                    assert_eq!(custom_error(&r), Some(code(SkechError::BadDifficulty)), "{at}: difficulty {difficulty} refused");
                    assert_eq!(market(&g), before, "{at}: difficulty unchanged");
                }
            }
            Step::Place { place: s } => {
                let who = &players[s.player.as_deref().unwrap_or("a")];
                let received = open_at + s.received.unwrap_or(-400);
                let piece = PieceMessage {
                    domain: g.domain,
                    player: who.wallet.pubkey(),
                    drawing: drawing_of(&s.id),
                    index: 0,
                    market: 0,
                    difficulty: s.difficulty.unwrap_or(c.difficulty),
                    open_at,
                    per_dot: s.per_dot.unwrap_or(100_000),
                    unit: c.unit,
                    price_seen: c.price,
                    price_time: received - s.price_age.unwrap_or(100),
                    stroke_hash: [7; 32],
                    sections: s.sections.iter().map(|x| SectionArg { second: x.second, lo: x.lo, width: x.width, stake: x.stake }).collect(),
                };
                let quote = QuoteArgs { price: c.price, momentum: s.momentum.unwrap_or(0), received_at: received, chances: s.sections.iter().map(|x| x.chance).collect() };
                let r = g.place(who, &piece, &quote);
                let w = want.place.as_ref().expect("a place step's expectation");
                if w.ok {
                    let meta = r.unwrap_or_else(|f| panic!("{at}: refused ({:?}) {:?}", f.err, f.meta.logs));
                    let (bet, _) = bet_pda(&who.wallet.pubkey(), piece.drawing, 0);
                    bets.insert(s.id.clone(), (bet, who.wallet.pubkey()));
                    let b: skech::state::Bet = g.account(&bet).expect("the bet");
                    let placed: Vec<skech::events::Placed> = events(&meta.logs);
                    assert_eq!(b.stake, w.staked.unwrap(), "{at}: staked");
                    assert_eq!(placed[0].fee, w.fee.unwrap(), "{at}: fee");
                    let bands = w.sections.as_ref().unwrap();
                    assert_eq!(b.sections.len(), bands.len(), "{at}: bands offered");
                    for (got, e) in b.sections.iter().zip(bands) {
                        assert_eq!((got.second, got.lo, got.hi, got.stake, got.rung), (e.second, e.lo, e.hi, e.stake, e.rung), "{at}: band");
                    }
                } else {
                    let name = w.refused.as_deref().unwrap();
                    assert_eq!(custom_error(&r), Some(code(refusal(name))), "{at}: refused as {name}");
                }
            }
            Step::Bar { bar } => {
                let second = open_at + bar.second * 1000;
                // A second is posted once it is over, give or take the grace: move the clock on if it is not yet.
                let needed = (second + 1000 - 3000 + 999).div_euclid(1000);
                if g.now < needed {
                    g.set_time(needed);
                }
                let list: Vec<(Pubkey, Pubkey)> = bar.settle.iter().filter_map(|id| bets.get(id).copied()).collect();
                let meta = g.post_and_settle(second, bar.prev_close, bar.high, bar.low, bar.close, &list).unwrap_or_else(|f| panic!("{at}: bar {:?} {:?}", f.err, f.meta.logs));
                let settled: Vec<skech::events::Settled> = events(&meta.logs);
                let wanted = want.settled.as_ref().unwrap();
                assert_eq!(settled.len(), wanted.len(), "{at}: bets settled");
                for (got, e) in settled.iter().zip(wanted) {
                    assert_eq!(got.bet, bets[&e.id].0, "{at}: settled bet");
                    assert_eq!((got.hit_mask, got.miss_mask, got.paid, got.owed), (e.hit_mask, e.miss_mask, e.paid, e.owed), "{at}: {} settled", e.id);
                }
            }
        }
        let st = &want.state;
        let pool = g.pool();
        assert_eq!(pool.pool, st.pool, "{at}: pool");
        assert_eq!(pool.fees, st.fees, "{at}: fees");
        assert_eq!(pool.house_basis, st.house_owed, "{at}: owed the house");
        let mut balances = 0;
        for (name, p) in &players {
            let ps = g.player_state(p);
            assert_eq!(ps.balance, st.balance[name], "{at}: balance {name}");
            assert_eq!(ps.session.allowance, st.allowance[name], "{at}: allowance {name}");
            assert_eq!(ps.iou_basis, st.owed[name], "{at}: owed {name}");
            balances += ps.balance;
        }
        let rewards = g.rewards();
        assert_eq!(token_balance(&g.svm, &g.vault()), balances + pool.pool + pool.fees + rewards.holder_funds, "{at}: every USDC accounted for");
        if let Some(k) = &st.skt {
            assert_eq!(rewards.supply.to_string(), k.supply, "{at}: SKT supply");
            assert_eq!(rewards.total_shares.to_string(), k.total_shares, "{at}: SKT shares");
            assert_eq!(rewards.acc.to_string(), k.acc, "{at}: the holders' accumulator");
            assert_eq!((rewards.holder_funds, rewards.gain), (k.holder_funds, k.gain), "{at}: holder funds, tracked gain");
            for (name, p) in &players {
                let h = g.holder(&p.wallet.pubkey());
                let e = &k.holders[name];
                // What a claim would count now.
                let mut counted = h.clone();
                counted.settle_rewards(&rewards).unwrap();
                assert_eq!((h.shares.to_string(), h.basis, counted.unclaimed), (e.shares.clone(), e.basis, e.claimable), "{at}: {name}'s SKT");
            }
        }
    }
}

#[test]
fn the_same_game_as_monad() {
    let v: Vectors = serde_json::from_str(include_str!("../../../conformance/vectors.json")).unwrap();
    assert!(v.cases.len() >= 10);
    for c in &v.cases {
        run(c);
    }
}

/// `SkechGame.initialize`'s config, as written in the Solidity: `name: value` pairs inside `Config({ ... })`.
fn evm_defaults() -> HashMap<String, u64> {
    let sol = include_str!("../../../evm/src/SkechGame.sol");
    let init = &sol[sol.find("function initialize(").expect("SkechGame.initialize")..];
    let body = &init[init.find("Config({").expect("its Config") + 8..];
    let body = &body[..body.find("})").unwrap()];
    body.lines()
        .map(|l| l.split("//").next().unwrap().trim().trim_end_matches(','))
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (k, v) = l.split_once(':').expect("name: value");
            (k.trim().to_string(), v.trim().replace('_', "").parse().expect("a number"))
        })
        .collect()
}

#[test]
fn the_defaults_are_monads() {
    let evm = evm_defaults();
    let c = skech::state::Config::DEFAULT;
    let ours: [(&str, u64); 10] = [
        ("feeBps", c.fee_bps as u64),
        ("profitFeeBps", c.profit_fee_bps as u64),
        ("sweepBps", c.sweep_bps as u64),
        ("lateMs", c.late_ms as u64),
        ("placeGraceMs", c.place_grace_ms as u64),
        ("maxPriceAgeMs", c.max_price_age_ms as u64),
        ("minPerDot", c.min_per_dot),
        ("maxPerDot", c.max_per_dot),
        ("maxPieceStake", c.max_piece_stake),
        ("minRedeem", c.min_redeem),
    ];
    assert_eq!(evm.len(), ours.len(), "SkechGame's Config has fields this test does not know: {evm:?}");
    for (name, value) in ours {
        assert_eq!(evm.get(name), Some(&value), "{name}: Config::DEFAULT has {value}, SkechGame.initialize {:?}", evm.get(name));
    }
    // And it is what a new game starts with.
    assert_eq!(Game::new().game().config, c);
}

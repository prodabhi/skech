//! The price, a second at a time, and settling on it. The oracle posts each second once it is over; every band in
//! that second is then decided by one rule, hit or miss. A bet whose last band is decided is closed, once its piece
//! can no longer be placed, and its rent goes back to whoever paid it. A band whose second was never posted, and now
//! never can be, is given back by `expire`.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{BarPosted, Owed, Settled};
use crate::ladder;
use crate::skt;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;
use crate::instructions::place::create_pda_at;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct BarInput {
    pub second: i64,
    pub prev_close: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct PostBar<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = oracle @ SkechError::NotOracle)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [MARKET_SEED, &[market]], bump = market_account.bump)]
    pub market_account: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct PostBarAndSettle<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = oracle @ SkechError::NotOracle)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [MARKET_SEED, &[market]], bump = market_account.bump)]
    pub market_account: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// SKT's `Rewards`, or, before `init_rewards` has made it, its empty address: see `load_rewards`.
    /// CHECK: read by `load_rewards`, written back by `store_rewards`.
    #[account(mut)]
    pub rewards: UncheckedAccount<'info>,
    /// Gets back the rent of the bets closed here: only those it paid for are closed.
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// Pays the rent of a player's `Holder` the first time a settlement mints SKT for them. The oracle, usually.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct Settle<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// SKT's `Rewards`, or, before `init_rewards` has made it, its empty address: see `load_rewards`.
    /// CHECK: read by `load_rewards`, written back by `store_rewards`.
    #[account(mut)]
    pub rewards: UncheckedAccount<'info>,
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// Pays the rent of a player's `Holder` the first time a settlement mints SKT for them: whoever settles.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// SKT's account, if `init_rewards` has made it. Not re-derived from its seeds when it is there (1,500 CU): only
/// `init_rewards` makes a `Rewards`, once, at its seeds, so the one account with its owner and discriminator is the
/// one. Before it is made (bets live across the upgrade that brought SKT, until the admin sends `init_rewards`),
/// settling and expiring go on without it: nothing mints, no holder is opened, and the holders' share of a profit's
/// fee goes to the treasury, as before SKT. Then the address passed must be its own, so nobody can settle without it
/// once it exists by passing some other empty account.
pub fn load_rewards(info: &AccountInfo, program_id: &Pubkey) -> Result<Option<Rewards>> {
    if info.owner == program_id && !info.data_is_empty() {
        require!(info.is_writable, SkechError::BadSettleAccounts);
        return Ok(Some(Rewards::try_deserialize(&mut &info.try_borrow_data()?[..])?));
    }
    let (address, _) = Pubkey::find_program_address(&[REWARDS_SEED], program_id);
    require_keys_eq!(address, info.key(), SkechError::BadSettleAccounts);
    Ok(None)
}

pub fn store_rewards(info: &AccountInfo, rewards: &Option<Rewards>) -> Result<()> {
    if let Some(r) = rewards {
        r.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}

/// What every bet in a settlement shares.
struct Batch<'a, 'info> {
    program_id: &'a Pubkey,
    game: &'a Game,
    bars: &'a Bars,
    pool: &'a mut Pool,
    /// None before `init_rewards`: see `load_rewards`.
    rewards: Option<Rewards>,
    rent_receiver: &'a UncheckedAccount<'info>,
    payer: &'a Signer<'info>,
    system_program: &'a Program<'info, System>,
    market: u8,
    now: i64,
    expire: bool,
}
fn post(game: &Game, bars: &mut Bars, market: u8, bar: &BarInput) -> Result<()> {
    require!(bar.second > 0 && bar.second % 1000 == 0 && bar.low > 0 && bar.prev_close > 0, SkechError::BadBar);
    require!(bar.low <= bar.high && bar.close >= bar.low && bar.close <= bar.high, SkechError::BadBar);
    // A second is posted once it is over, by this chain's clock, give or take the grace: never ahead of the ink in it.
    let now_ms = Clock::get()?.unix_timestamp * 1000;
    require!(bar.second + 1000 <= now_ms + game.config.place_grace_ms as i64, SkechError::BadBar);
    let new = Bar { second: bar.second, prev_close: bar.prev_close, high: bar.high, low: bar.low, close: bar.close };
    if let Some(existing) = bars.at(bar.second) {
        // Posting the same bar twice is fine; a different one for the same second is not.
        require!(*existing == new, SkechError::BarConflict);
        return Ok(());
    }
    // Not so late that a bet in it may have been given its stake back, or that its slot may hold a newer second.
    require!(!Bars::too_late(bar.second, now_ms), SkechError::BarLate);
    // One second follows from the last: the previous bar's close is this one's opening price.
    if let Some(prev) = bars.at(bar.second - 1000) {
        require!(prev.close == bar.prev_close, SkechError::BarDiscontinuous);
    }
    require!(bars.put(new), SkechError::BarLate);
    emit!(BarPosted { market, second: bar.second, prev_close: bar.prev_close, high: bar.high, low: bar.low, close: bar.close });
    Ok(())
}

/// Post a second's bar. A market closed to new pieces is still posted, so the bets already in it are decided.
pub fn post_bar(ctx: Context<PostBar>, market: u8, bar: BarInput) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let mut bars = ctx.accounts.bars.load_mut()?;
    post(&ctx.accounts.game, &mut bars, market, &bar)
}

/// The relayer's one transaction a second: the bar, then every bet with ink in it, as (bet, player, holder) triples
/// in the remaining accounts.
pub fn post_bar_and_settle<'info>(ctx: Context<'_, '_, 'info, 'info, PostBarAndSettle<'info>>, market: u8, bar: BarInput) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    {
        let mut bars = a.bars.load_mut()?;
        post(&a.game, &mut bars, market, &bar)?;
    }
    let bars = a.bars.load()?;
    let rewards = load_rewards(&a.rewards, ctx.program_id)?;
    let mut b = Batch { program_id: ctx.program_id, game: &a.game, bars: &bars, pool: &mut a.pool, rewards, rent_receiver: &a.rent_receiver, payer: &a.payer, system_program: &a.system_program, market, now: Clock::get()?.unix_timestamp, expire: false };
    settle_all(&mut b, ctx.remaining_accounts)?;
    store_rewards(&a.rewards, &b.rewards)
}

/// Settle bets on the bars already posted: bands in a posted second are hit or missed; the rest wait. Anyone may.
pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
    settle_or_expire(ctx, market, false)
}

/// Settle bets as `settle` does, and give back the stake of every band whose second was never posted and is now too
/// late to be (`BAR_LATE`), all of it, as Monad's `expire` does. Anyone may, so a player's stake never waits on an
/// oracle that has stopped.
pub fn expire<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
    settle_or_expire(ctx, market, true)
}

fn settle_or_expire<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8, expire: bool) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    let bars = a.bars.load()?;
    let rewards = load_rewards(&a.rewards, ctx.program_id)?;
    let mut b = Batch { program_id: ctx.program_id, game: &a.game, bars: &bars, pool: &mut a.pool, rewards, rent_receiver: &a.rent_receiver, payer: &a.payer, system_program: &a.system_program, market, now: Clock::get()?.unix_timestamp, expire };
    settle_all(&mut b, ctx.remaining_accounts)?;
    store_rewards(&a.rewards, &b.rewards)
}

fn settle_all<'info>(b: &mut Batch<'_, 'info>, accounts: &'info [AccountInfo<'info>]) -> Result<()> {
    require!(accounts.len() % 3 == 0, SkechError::BadSettleAccounts);
    // Every bet is decided first, and a Holder opened only for a player whose bet mints here: a hit, a refund or a bet
    // that only closes costs nobody a Holder's rent. All of them before anything is settled: a call to the system
    // program after a closed bet's rent has been moved by hand would leave this instruction's lamports out of balance,
    // which the runtime refuses.
    let mut outcomes = Vec::with_capacity(accounts.len() / 3);
    for t in accounts.chunks(3) {
        let o = decide(b, &t[0])?;
        if let Some(o) = &o {
            if o.basis > 0 && b.rewards.is_some() {
                open_holder(b, o.bet.player, &t[2])?;
            }
        }
        outcomes.push(o);
    }
    for (t, o) in accounts.chunks(3).zip(outcomes) {
        if let Some(o) = o {
            settle_one(b, o, &t[0], &t[1], &t[2])?;
        }
    }
    Ok(())
}

/// What settling one bet does: which bands hit, miss or are given back, what it pays, what it mints on.
struct Outcome {
    bet: Bet,
    hits: u32,
    decided: u32,
    expired: u32,
    gross_pay: u64,
    stake_hit: u64,
    stake_back: u64,
    basis: u64,
    /// What the decided bands could have paid, every one hitting: no longer kept for them (bets placed since SKT only,
    /// whose liability was counted).
    released: u64,
    closable: bool,
}

/// Decide a bet on the bars posted, writing nothing. None: already closed (settled in an earlier transaction, so a
/// retry is harmless), or nothing to do yet.
fn decide(b: &Batch, bet_info: &AccountInfo) -> Result<Option<Outcome>> {
    let now = b.now;
    if bet_info.owner != b.program_id || bet_info.data_is_empty() {
        return Ok(None);
    }
    let (bet, chances) = {
        let data = bet_info.try_borrow_data()?;
        let bet = Bet::try_deserialize(&mut &data[..])?;
        // Each band's chance, kept after the bet; none for a bet placed before SKT, whose misses mint nothing.
        let chances = Bet::chances(&data, bet.sections.len());
        (bet, chances)
    };
    require!(bet.market == b.market, SkechError::BadSettleAccounts);
    let live = bet.live_mask;
    let (mut hits, mut decided, mut expired) = (0u32, 0u32, 0u32);
    let (mut gross_pay, mut stake_hit, mut stake_back, mut basis, mut released) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for (i, s) in bet.sections.iter().enumerate() {
        let bit = 1u32 << i;
        if live & bit == 0 {
            continue;
        }
        let second = bet.open_at + s.second as i64 * 1000;
        let Some(bar) = b.bars.at(second) else {
            if b.expire && Bars::too_late(second, now * 1000) {
                decided |= bit;
                expired |= bit;
                stake_back += s.stake;
                if chances.is_some() {
                    released = released.saturating_add(ladder::gross(s.stake, s.rung));
                }
            }
            continue;
        };
        decided |= bit;
        if chances.is_some() {
            released = released.saturating_add(ladder::gross(s.stake, s.rung));
        }
        if ladder::crosses(bar.prev_close, bar.high, bar.low, s.lo, s.hi, bet.unit) {
            hits |= bit;
            stake_hit += s.stake;
            gross_pay += ladder::gross(s.stake, s.rung);
        } else if let Some(c) = &chances {
            // A miss counts its odds-weighted loss toward SKT; a hit, or a band given back, nothing.
            basis += skt::miss_basis(s.stake, c[i], s.rung, b.game.config.profit_fee_bps);
        }
    }
    // A bet is not closed while its piece could still be placed: that would let the same piece go in again. Nor
    // here if someone else paid its rent: it waits for them, and the rest of the batch goes on.
    let closable = now * 1000 > bet.open_at + b.game.config.place_grace_ms as i64 && b.rent_receiver.key() == bet.rent_payer;
    if decided == 0 && !(live == 0 && closable) {
        return Ok(None);
    }
    Ok(Some(Outcome { bet, hits, decided, expired, gross_pay, stake_hit, stake_back, basis, released, closable }))
}

fn settle_one<'info>(b: &mut Batch<'_, 'info>, o: Outcome, bet_info: &AccountInfo<'info>, player_info: &AccountInfo<'info>, holder_info: &AccountInfo<'info>) -> Result<()> {
    let now = b.now;
    require!(bet_info.is_writable && player_info.is_writable && player_info.owner == b.program_id, SkechError::BadSettleAccounts);
    let Outcome { mut bet, hits, decided, expired, gross_pay, stake_hit, stake_back, basis, released, closable } = o;
    if let Some(r) = b.rewards.as_mut() {
        r.liability = r.liability.saturating_sub(released);
    }
    let mut player = Player::try_deserialize(&mut &player_info.try_borrow_data()?[..])?;
    require_keys_eq!(player.authority, bet.player, SkechError::BadSettleAccounts);
    bet.live_mask &= !decided;
    bet.hit_mask |= hits;
    let (mut paid, mut owed) = (0, 0);
    if gross_pay > 0 {
        let c = &b.game.config;
        let profit = gross_pay - stake_hit;
        // Rounded up, as on Monad: a small profit never slips under the fee.
        let profit_fee = (profit * c.profit_fee_bps as u64).div_ceil(BPS);
        (paid, owed) = pay(b.pool, &mut player, gross_pay - profit_fee, now);
        // The player is paid first. The house's cut comes after, out of what the pool has left, and is never owed: a
        // shortfall is never made worse by a debt growing to the house. The holders' share is taken the same way;
        // before SKT has started, it is the treasury's.
        let to_holders = b.rewards.as_ref().map_or(0, |r| skt::holder_part(profit, r.config.holder_profit_fee_bps, c.profit_fee_bps));
        let cut = (profit_fee - to_holders).min(b.pool.pool);
        b.pool.pool -= cut;
        b.pool.fees += cut;
        if let Some(r) = b.rewards.as_mut() {
            r.share_profit_fee(b.pool, to_holders, now)?;
        }
    }
    let mut refunded = 0;
    if stake_back > 0 {
        // All of it, as on Monad: a band its bar never came for never ran. The pool gives back the fee as well.
        refunded = stake_back;
        let (p, o) = pay(b.pool, &mut player, refunded, now);
        paid += p;
        owed += o;
    }
    if decided != 0 {
        player.try_serialize(&mut &mut player_info.try_borrow_mut_data()?[..])?;
        if let (true, Some(r)) = (basis > 0, b.rewards.as_mut()) {
            let mut holder = holder_of(b.program_id, holder_info, bet.player)?;
            r.mint(&mut holder, basis, now)?;
            holder.try_serialize(&mut &mut holder_info.try_borrow_mut_data()?[..])?;
        }
    }
    let closed = bet.live_mask == 0 && closable;
    if closed {
        // Every band decided: the bet is done. Its rent goes back to whoever paid it.
        let lamports = bet_info.lamports();
        **b.rent_receiver.to_account_info().try_borrow_mut_lamports()? += lamports;
        **bet_info.try_borrow_mut_lamports()? = 0;
        bet_info.assign(&anchor_lang::system_program::ID);
        bet_info.resize(0)?;
    } else {
        // Only the masks changed: written in place, not the whole bet and its sections again.
        let mut data = bet_info.try_borrow_mut_data()?;
        data[Bet::LIVE_MASK_AT..Bet::LIVE_MASK_AT + 4].copy_from_slice(&bet.live_mask.to_le_bytes());
        data[Bet::LIVE_MASK_AT + 4..Bet::LIVE_MASK_AT + 8].copy_from_slice(&bet.hit_mask.to_le_bytes());
    }
    emit!(Settled { bet: bet_info.key(), player: bet.player, hit_mask: hits, miss_mask: decided & !hits & !expired, paid, owed, closed, expired_mask: expired, refunded });
    Ok(())
}

/// Open `player`'s `Holder` at the payer's cost, if it is not there yet: at its address only, for that player only.
fn open_holder<'info>(b: &Batch<'_, 'info>, player: Pubkey, info: &AccountInfo<'info>) -> Result<()> {
    if info.owner == b.program_id && !info.data_is_empty() {
        return Ok(());
    }
    let (address, bump) = Pubkey::find_program_address(&[HOLDER_SEED, player.as_ref()], b.program_id);
    require!(address == info.key() && info.is_writable, SkechError::BadSettleAccounts);
    create_pda_at(b.payer, info, b.system_program, Holder::SPACE, b.program_id, &[HOLDER_SEED, player.as_ref(), &[bump]])?;
    let (era, acc) = b.rewards.as_ref().map_or((0, 0), |r| (r.era, r.acc));
    let holder = Holder { player, era, acc_at: acc, bump, ..Default::default() };
    holder.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])
}

/// The player's `Holder`. Only the program makes an account with a Holder's discriminator, and only at the player's
/// own address: one that names this player is theirs.
fn holder_of(program_id: &Pubkey, info: &AccountInfo, player: Pubkey) -> Result<Holder> {
    require!(info.is_writable && info.owner == program_id, SkechError::BadSettleAccounts);
    let h = Holder::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(h.player, player, SkechError::BadSettleAccounts);
    Ok(h)
}

/// Pay `due` from the pool: in USDC into the player's balance as far as it goes, the rest as IOU shares.
pub fn pay(pool: &mut Pool, player: &mut Player, due: u64, now: i64) -> (u64, u64) {
    let paid = due.min(pool.pool);
    pool.pool -= paid;
    player.balance += paid;
    let owed = due - paid;
    if owed > 0 {
        let shares = pool.shares_for(owed, now);
        pool.iou_shares += shares;
        player.iou_shares += shares;
        player.iou_basis += owed;
        emit!(Owed { to: player.authority, value: owed, shares });
    }
    (paid, owed)
}

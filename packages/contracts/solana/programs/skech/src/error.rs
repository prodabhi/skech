use anchor_lang::prelude::*;

/// Why something was refused. A piece's refusals come first, in the order the EVM game names them
/// (`SkechGame.Refusal`), so the relayer tells a player the same reason on either chain.
#[error_code]
pub enum SkechError {
    // A piece.
    #[msg("Mismatch")]
    Mismatch,
    #[msg("Replay")]
    Replay,
    #[msg("Difficulty")]
    Difficulty,
    #[msg("Late")]
    Late,
    #[msg("StalePrice")]
    StalePrice,
    #[msg("PerDot")]
    PerDot,
    #[msg("Sections")]
    Sections,
    #[msg("Session")]
    Session,
    #[msg("SessionSig")]
    SessionSig,
    #[msg("NotOffered")]
    NotOffered,
    #[msg("Allowance")]
    Allowance,
    #[msg("Balance")]
    Balance,
    // Everything else.
    #[msg("The game is paused")]
    Paused,
    #[msg("The market is not active")]
    MarketInactive,
    #[msg("The quote is malformed")]
    BadQuote,
    #[msg("Outside the placing window")]
    Window,
    #[msg("Not the oracle")]
    NotOracle,
    #[msg("Not the admin")]
    NotAdmin,
    #[msg("The bar is malformed or early")]
    BadBar,
    #[msg("A different bar is already posted for that second")]
    BarConflict,
    #[msg("The bar does not follow on from the second before")]
    BarDiscontinuous,
    #[msg("Not enough")]
    Insufficient,
    #[msg("Nothing to redeem")]
    NothingToRedeem,
    #[msg("Bad config")]
    BadConfig,
    #[msg("Bad difficulty")]
    BadDifficulty,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Bad session")]
    BadSession,
    #[msg("Wrong token account")]
    BadTokenAccount,
    #[msg("Settle accounts must come in (bet, player, holder) triples")]
    BadSettleAccounts,
    #[msg("Only the program's upgrade authority may initialize")]
    NotUpgradeAuthority,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The bar is too late to post")]
    BarLate,
    #[msg("USDC must be an SPL Token mint")]
    NotSplToken,
    #[msg("A holder redeeming their own takes no cut: send no caller_player")]
    OwnRedeem,
    #[msg("Not the proposed admin")]
    NotPendingAdmin,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("SKT's mint scale is fixed once anything has minted")]
    MintScaleFixed,
    #[msg("No surplus to share: something is owed, the pool is under its reserve and what live bets could pay, there is no SKT, or SKT started too recently")]
    NoSurplus,
}

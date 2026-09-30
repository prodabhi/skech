//! A whole game in LiteSVM: the program as the upgradeable loader lays it out (so `initialize` can check its upgrade
//! authority), USDC as an SPL Token mint, a relayer that is also the oracle, and players with session keys.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use solana_instruction::error::InstructionError;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{system_program, AccountDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::spl_token;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use skech::piece::{PieceMessage, QuoteArgs, SectionArg};
use skech::state::*;

pub const LOADER_V3: Pubkey = anchor_lang::prelude::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const E6: u64 = 1_000_000;
pub const E8: u64 = 100_000_000;

pub struct Game {
    pub svm: LiteSVM,
    pub admin: Keypair,
    /// Pays every fee and every rent, and signs as the oracle.
    pub relayer: Keypair,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub domain: [u8; 32],
    /// The chain's clock, unix seconds.
    pub now: i64,
}

pub struct Player {
    pub wallet: Keypair,
    pub session: Keypair,
    pub usdc: Pubkey,
}

pub fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &skech::ID)
}
pub fn game_pda() -> Pubkey {
    pda(&[GAME_SEED]).0
}
pub fn pool_pda() -> Pubkey {
    pda(&[POOL_SEED]).0
}
pub fn market_pda(id: u8) -> Pubkey {
    pda(&[MARKET_SEED, &[id]]).0
}
pub fn bars_pda(id: u8) -> Pubkey {
    pda(&[BARS_SEED, &[id]]).0
}
pub fn player_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[PLAYER_SEED, wallet.as_ref()]).0
}
pub fn bet_pda(wallet: &Pubkey, drawing: u64, index: u32) -> (Pubkey, u8) {
    pda(&[BET_SEED, wallet.as_ref(), &drawing.to_le_bytes(), &index.to_le_bytes()])
}
pub fn rewards_pda() -> Pubkey {
    pda(&[REWARDS_SEED]).0
}
pub fn holder_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[HOLDER_SEED, wallet.as_ref()]).0
}

/// The code a custom program error carries: Anchor's offset plus its place in the enum.
pub fn code(e: skech::error::SkechError) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

pub fn custom_error(r: &Result<TransactionMetadata, FailedTransactionMetadata>) -> Option<u32> {
    match r {
        Err(f) => match &f.err {
            solana_transaction_error::TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

fn program_accounts(authority: &Pubkey, elf: &[u8]) -> (Pubkey, Account, Account) {
    let programdata = Pubkey::find_program_address(&[skech::ID.as_ref()], &LOADER_V3).0;
    // UpgradeableLoaderState::Program { programdata_address }
    let mut program = vec![2, 0, 0, 0];
    program.extend_from_slice(programdata.as_ref());
    // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address: Some(authority) }, then the ELF.
    let mut data = vec![3, 0, 0, 0];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(1);
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(elf);
    let rent = 10_000_000_000;
    (
        programdata,
        Account { lamports: rent, data: program, owner: LOADER_V3, executable: true, rent_epoch: 0 },
        Account { lamports: rent, data, owner: LOADER_V3, executable: false, rent_epoch: 0 },
    )
}

pub fn token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64, delegate: Option<(Pubkey, u64)>) {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: delegate.map(|d| d.0).into(),
        state: spl_token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: delegate.map(|d| d.1).unwrap_or(0),
        close_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    svm.set_account(address, Account { lamports: 2_039_280, data, owner: spl_token::ID, executable: false, rent_epoch: 0 }).unwrap();
}

pub fn token_balance(svm: &LiteSVM, address: &Pubkey) -> u64 {
    spl_token::state::Account::unpack(&svm.get_account(address).unwrap().data).unwrap().amount
}

impl Game {
    /// A deployed program and nothing else: `initialize` not sent.
    pub fn deployed() -> Game {
        let mut svm = LiteSVM::new();
        let admin = Keypair::new();
        let relayer = Keypair::new();
        let elf = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/skech.so")).expect("run anchor build first");
        let (programdata, program, data) = program_accounts(&admin.pubkey(), &elf);
        svm.set_account(programdata, data).unwrap();
        svm.set_account(skech::ID, program).unwrap();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&relayer.pubkey(), 100_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        let mut m = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint { mint_authority: COption::Some(admin.pubkey()), supply: 1_000_000 * E6, decimals: 6, is_initialized: true, freeze_authority: COption::None }.pack_into_slice(&mut m);
        svm.set_account(mint, Account { lamports: 1_461_600, data: m, owner: spl_token::ID, executable: false, rent_epoch: 0 }).unwrap();
        let treasury = Pubkey::new_unique();
        token_account(&mut svm, treasury, mint, admin.pubkey(), 0, None);
        let mut g = Game { svm, admin, relayer, mint, treasury, domain: [0; 32], now: 1_790_000_000 };
        g.set_time(g.now);
        g
    }

    /// Initialized, with BTC-USD open at difficulty 51.
    pub fn new() -> Game {
        let mut g = Game::deployed();
        let admin = g.admin.insecure_clone();
        g.send(&[g.initialize_ix(&admin.pubkey())], &[&admin]).expect("initialize");
        g.send(&[g.ix(skech::accounts::InitMarket { admin: admin.pubkey(), game: game_pda(), market: market_pda(0), bars: bars_pda(0), system_program: system_program::ID }, skech::instruction::InitMarket { id: 0, name: "BTC-USD".into(), difficulty: 51 })], &[&admin])
            .expect("init market");
        // SKT's default terms but the wallet cap, which `holders.rs` and the conformance cases try where they mean to:
        // the rest of the tests count every holder's part exactly.
        g.send(&[g.init_rewards_ix(Config::DEFAULT, RewardsConfig { wallet_cap_bps: 10_000, ..RewardsConfig::DEFAULT })], &[&admin]).expect("init rewards");
        g.domain = g.game().domain;
        g
    }

    pub fn init_rewards_ix(&self, config: Config, rewards: RewardsConfig) -> Instruction {
        self.ix(
            skech::accounts::InitRewards { admin: self.admin.pubkey(), game: game_pda(), rewards: rewards_pda(), system_program: system_program::ID },
            skech::instruction::InitRewards { config, rewards_config: rewards },
        )
    }

    pub fn set_config_ix(&self, config: Config) -> Instruction {
        self.ix(skech::accounts::SetConfig { admin: self.admin.pubkey(), game: game_pda(), rewards: rewards_pda() }, skech::instruction::SetConfig { config })
    }

    pub fn set_rewards_config_ix(&self, rewards: RewardsConfig) -> Instruction {
        self.ix(skech::accounts::SetRewardsConfig { admin: self.admin.pubkey(), game: game_pda(), rewards: rewards_pda() }, skech::instruction::SetRewardsConfig { rewards_config: rewards })
    }

    pub fn share_surplus_ix(&self) -> Instruction {
        self.ix(skech::accounts::ShareSurplus { game: game_pda(), pool: pool_pda(), rewards: rewards_pda() }, skech::instruction::ShareSurplus {})
    }

    /// What `wallet`'s SKT is worth now: its shares over today's weight.
    pub fn skt_now(&self, wallet: &Pubkey) -> u64 {
        let h = self.holder(wallet);
        self.rewards().balance_of(h.shares, h.era, self.now)
    }

    pub fn claim_ix(&self, p: &Player) -> Instruction {
        let w = p.wallet.pubkey();
        self.ix(skech::accounts::Claim { authority: w, game: game_pda(), rewards: rewards_pda(), player: player_pda(&w), holder: holder_pda(&w) }, skech::instruction::Claim {})
    }

    pub fn initialize_ix(&self, authority: &Pubkey) -> Instruction {
        let vault = get_associated_token_address_with_program_id(&game_pda(), &self.mint, &spl_token::ID);
        let programdata = Pubkey::find_program_address(&[skech::ID.as_ref()], &LOADER_V3).0;
        self.ix(
            skech::accounts::Initialize {
                authority: *authority,
                game: game_pda(),
                pool: pool_pda(),
                usdc_mint: self.mint,
                vault,
                treasury: self.treasury,
                program: skech::ID,
                program_data: programdata,
                token_program: spl_token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: system_program::ID,
            },
            skech::instruction::Initialize { cluster: "localnet".into(), oracle: self.relayer.pubkey(), iou_rate: 11_574_074_074 },
        )
    }

    pub fn ix(&self, accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
        Instruction { program_id: skech::ID, accounts: accounts.to_account_metas(None), data: data.data() }
    }

    pub fn set_time(&mut self, unix: i64) {
        self.now = unix;
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    /// Send with the relayer paying; `signers` beyond it.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let relayer = self.relayer.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&relayer];
        for s in signers {
            if s.pubkey() != relayer.pubkey() {
                all.push(s);
            }
        }
        let msg = Message::new(ixs, Some(&relayer.pubkey()));
        let tx = Transaction::new(&all, msg, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn account<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let a = self.svm.get_account(address)?;
        if a.data.is_empty() {
            return None;
        }
        T::try_deserialize(&mut &a.data[..]).ok()
    }
    pub fn game(&self) -> skech::state::Game {
        self.account(&game_pda()).unwrap()
    }
    pub fn pool(&self) -> skech::state::Pool {
        self.account(&pool_pda()).unwrap()
    }
    pub fn player_state(&self, p: &Player) -> skech::state::Player {
        self.account(&player_pda(&p.wallet.pubkey())).unwrap()
    }
    pub fn rewards(&self) -> skech::state::Rewards {
        self.account(&rewards_pda()).unwrap()
    }
    /// The player's SKT account, or an empty one if no settlement has opened it yet.
    pub fn holder(&self, wallet: &Pubkey) -> skech::state::Holder {
        self.account(&holder_pda(wallet)).unwrap_or_default()
    }
    pub fn vault(&self) -> Pubkey {
        get_associated_token_address_with_program_id(&game_pda(), &self.mint, &spl_token::ID)
    }

    /// A player with `usdc` in their wallet, deposited, with a session allowing `allowance`.
    pub fn player(&mut self, deposit: u64, allowance: u64) -> Player {
        let wallet = Keypair::new();
        let session = Keypair::new();
        let usdc = Pubkey::new_unique();
        token_account(&mut self.svm, usdc, self.mint, wallet.pubkey(), 1_000 * E6, None);
        let p = Player { wallet, session, usdc };
        if deposit > 0 {
            self.send(&[self.deposit_ix(&p, deposit)], &[&p.wallet]).expect("deposit");
        }
        let until = self.now + 86_400;
        self.send(&[self.session_ix(&p, p.session.pubkey(), until, allowance)], &[&p.wallet]).expect("session");
        p
    }

    pub fn deposit_ix(&self, p: &Player, amount: u64) -> Instruction {
        self.ix(
            skech::accounts::Deposit {
                payer: self.relayer.pubkey(),
                authority: p.wallet.pubkey(),
                game: game_pda(),
                player: player_pda(&p.wallet.pubkey()),
                from: p.usdc,
                vault: self.vault(),
                usdc_mint: self.mint,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            },
            skech::instruction::Deposit { amount },
        )
    }

    pub fn session_ix(&self, p: &Player, key: Pubkey, valid_until: i64, allowance: u64) -> Instruction {
        self.ix(
            skech::accounts::SetSession { payer: self.relayer.pubkey(), authority: p.wallet.pubkey(), game: game_pda(), player: player_pda(&p.wallet.pubkey()), system_program: system_program::ID },
            skech::instruction::SetSession { key, valid_until, allowance },
        )
    }

    pub fn withdraw_ix(&self, p: &Player, amount: u64, to: Pubkey) -> Instruction {
        self.ix(
            skech::accounts::Withdraw { authority: p.wallet.pubkey(), game: game_pda(), player: player_pda(&p.wallet.pubkey()), to, vault: self.vault(), usdc_mint: self.mint, token_program: spl_token::ID },
            skech::instruction::Withdraw { amount },
        )
    }

    /// A piece opening on `open_at` (ms), with the market at `price` (e8) and one band per `(second, lo, width, stake)`.
    pub fn piece(&self, p: &Player, drawing: u64, index: u32, open_at: i64, sections: &[(u8, u32, u16, u32)]) -> PieceMessage {
        PieceMessage {
            domain: self.domain,
            player: p.wallet.pubkey(),
            drawing,
            index,
            market: 0,
            difficulty: 51,
            open_at,
            per_dot: 100_000,
            unit: 20_000_000,
            price_seen: 83_000 * E8,
            price_time: open_at - 1_500,
            stroke_hash: [7; 32],
            sections: sections.iter().map(|&(second, lo, width, stake)| SectionArg { second, lo, width, stake }).collect(),
        }
    }

    pub fn quote(&self, piece: &PieceMessage, chance: u32) -> QuoteArgs {
        QuoteArgs { price: 83_000 * E8, momentum: 0, received_at: piece.open_at - 300, chances: vec![chance; piece.sections.len()] }
    }

    /// The Ed25519 instruction verifying `signer`'s signature over the piece as it sits in the instruction at
    /// `place_index`, from byte 8, for `len` bytes.
    pub fn ed25519_ix(signer: &Keypair, message: &[u8], place_index: u16, offset: u16, len: u16) -> Instruction {
        let sig = signer.sign_message(message);
        let mut data = vec![1u8, 0];
        let (pk_off, sig_off) = (16u16, 48u16);
        for v in [sig_off, u16::MAX, pk_off, u16::MAX, offset, len, place_index] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        data.extend_from_slice(signer.pubkey().as_ref());
        data.extend_from_slice(sig.as_ref());
        Instruction { program_id: skech::piece::ED25519_PROGRAM, accounts: vec![], data }
    }

    pub fn place_ix(&self, piece: &PieceMessage, quote: &QuoteArgs) -> Instruction {
        let (bet, _) = bet_pda(&piece.player, piece.drawing, piece.index);
        self.ix(
            skech::accounts::Place {
                payer: self.relayer.pubkey(),
                oracle: self.relayer.pubkey(),
                game: game_pda(),
                market: market_pda(piece.market),
                bars: bars_pda(piece.market),
                pool: pool_pda(),
                rewards: rewards_pda(),
                player: player_pda(&piece.player),
                bet,
                instructions: anchor_lang::solana_program::sysvar::instructions::ID,
                system_program: system_program::ID,
            },
            skech::instruction::Place { piece: piece.clone(), quote: quote.clone() },
        )
    }

    /// Place a piece signed by `signer` (the session key, normally), the way the relayer sends it.
    pub fn place_signed(&mut self, piece: &PieceMessage, quote: &QuoteArgs, signer: &Keypair) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let bytes = piece.try_to_vec().unwrap();
        let ed = Game::ed25519_ix(signer, &bytes, 1, 8, bytes.len() as u16);
        let place = self.place_ix(piece, quote);
        self.send(&[ed, place], &[])
    }

    pub fn place(&mut self, p: &Player, piece: &PieceMessage, quote: &QuoteArgs) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let s = p.session.insecure_clone();
        self.place_signed(piece, quote, &s)
    }

    /// The `Settle` accounts, with `rent_receiver` taking back the rent and the relayer paying any holder's.
    pub fn settle_accounts(&self, rent_receiver: Pubkey) -> skech::accounts::Settle {
        skech::accounts::Settle { game: game_pda(), bars: bars_pda(0), pool: pool_pda(), rewards: rewards_pda(), rent_receiver, payer: self.relayer.pubkey(), system_program: system_program::ID }
    }

    /// (bet, player, holder) for each (bet, wallet), as settling takes them.
    pub fn with_bets(mut ix: Instruction, bets: &[(Pubkey, Pubkey)]) -> Instruction {
        for (bet, wallet) in bets {
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new(*bet, false));
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new(player_pda(wallet), false));
            ix.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new(holder_pda(wallet), false));
        }
        ix
    }

    /// `settle`, or `expire`, on (bet, wallet) pairs, with the relayer taking back the rent.
    pub fn settle_on(&mut self, expire: bool, bets: &[(Pubkey, Pubkey)]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = self.settle_accounts(self.relayer.pubkey());
        let ix = if expire { self.ix(accounts, skech::instruction::Expire { market: 0 }) } else { self.ix(accounts, skech::instruction::Settle { market: 0 }) };
        self.send(&[Game::with_bets(ix, bets)], &[])
    }

    pub fn post_and_settle_ix(&self, second: i64, prev_close: u64, high: u64, low: u64, close: u64, bets: &[(Pubkey, Pubkey)]) -> Instruction {
        let ix = self.ix(
            skech::accounts::PostBarAndSettle {
                oracle: self.relayer.pubkey(),
                game: game_pda(),
                market_account: market_pda(0),
                bars: bars_pda(0),
                pool: pool_pda(),
                rewards: rewards_pda(),
                rent_receiver: self.relayer.pubkey(),
                payer: self.relayer.pubkey(),
                system_program: system_program::ID,
            },
            skech::instruction::PostBarAndSettle { market: 0, bar: skech::instructions::BarInput { second, prev_close, high, low, close } },
        );
        Game::with_bets(ix, bets)
    }

    pub fn post_and_settle(&mut self, second: i64, prev_close: u64, high: u64, low: u64, close: u64, bets: &[(Pubkey, Pubkey)]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.post_and_settle_ix(second, prev_close, high, low, close, bets);
        self.send(&[ix], &[])
    }
}

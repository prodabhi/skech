// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISkechIOU} from "./interfaces/ISkechIOU.sol";
import {IUSDCAuthorization} from "./interfaces/IUSDCAuthorization.sol";
import {SkechLadder} from "./SkechLadder.sol";

/// @title SkechGame
/// @notice skech, on chain: draw ink ahead of the Bitcoin price, and the ink the price runs through pays.
///
/// The house holds no money. Players deposit USDC; every stake goes into one pool; every hit is paid from it.
/// The house takes 4% of every stake and 10% of every profit, into `SkechRevenue`, and nothing else. When
/// the pool cannot pay a hit, the winner is issued `SkechIOU`, a debt that grows every block and is paid off,
/// by anyone, as the pool refills.
///
/// What goes on chain, and who vouches for it:
///
/// - A **piece** of a drawing is signed by the player's session key: where the ink is (bands of price, by second),
///   what each band stakes, what a dot costs, the second it opens on, the price the player was looking at and
///   the difficulty they were shown. The player's own signature is the only thing that can spend their balance.
/// - A **quote** is signed by the oracle (the engine): when it received each piece, the market's price and
///   momentum on the opening second, and each band's measured chance. The chance is measured off chain, on
///   thousands of real price paths; it cannot be measured here.
/// - The **ladder** is here: from the chance, the difficulty set on this contract and the momentum, the rung
///   each band pays is computed on chain (`SkechLadder`). The engine cannot pay a band more than its chance earns.
/// - A **bar** is the price's second, signed by the oracle: from the second before's close to its high and low.
///   Bars are stored once each and settle every band in that second, hit or miss, by one rule.
///
/// A piece must reach the engine before its opening second, and land here before that second is over, so
/// nothing is bet on a price already seen. Ink counts from the second after opening, up to thirty seconds ahead.
///
/// Sessions: a player registers a key (an Ethereum key, or a P-256 key the browser keeps and cannot export)
/// with one signature from their wallet. The key can place pieces, up to an allowance, until it expires. It
/// can never withdraw: only the wallet can.
///
/// Prices carry 8 decimals, USDC 6, time is in milliseconds on the exchange's clock, chances are in billionths.
contract SkechGame is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    NoncesUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /* ------------------------------------------------------------------ */
    /* Types                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice A band of price in one second of a piece: from `lo` to `hi` (8 decimals, on the grid), `second`
    /// seconds after the piece opens, staking `stake` USDC. A hit pays `stake` times its rung.
    struct Section {
        uint8 second;
        uint64 lo;
        uint64 hi;
        uint64 stake;
    }

    /// @notice What a player signs: a piece of a drawing, bet as it is drawn.
    struct Piece {
        address player;
        /// @dev The drawing this piece is part of, and its number within it: together they name the bet.
        uint64 drawing;
        uint32 index;
        uint8 market;
        /// @dev The difficulty the player was shown. If the market's has changed since, the piece is refused.
        uint8 difficulty;
        /// @dev The second it opens on, ms. Its bands are 1 to 30 seconds after it.
        uint64 openAt;
        /// @dev What one dot costs, USDC.
        uint64 perDot;
        /// @dev The price grid the bands sit on, 8 decimals: bands are judged one unit wider each way.
        uint64 unit;
        /// @dev The price on the player's screen when they drew, and its time, as the oracle signed it.
        uint64 priceSeen;
        uint64 priceTime;
        Section[] sections;
        /// @dev keccak256 of the stroke's points, kept as an event.
        bytes32 strokeHash;
    }

    /// @notice A piece with everything that vouches for it.
    struct Placement {
        Piece piece;
        /// @dev By the session key: 65 bytes r‖s‖v for an Ethereum key, 64 bytes r‖s for a P-256 key.
        bytes sessionSig;
        /// @dev The oracle's signature over `Price(market, priceSeen, priceTime)`.
        bytes priceSig;
        /// @dev The stroke's points, whose hash the piece carries.
        bytes stroke;
    }

    /// @notice What the oracle signs over a batch of pieces opening on one second: the market then, and every band's chance.
    struct Quote {
        uint8 market;
        uint64 openAt;
        uint64 unit;
        /// @dev The price the second before `openAt` closed at, and the last three seconds' move in volatilities, x1e6.
        uint64 price;
        int64 momentum;
        /// @dev When the engine received each piece, ms: one per piece.
        uint64[] receivedAt;
        /// @dev Each band's chance, in billionths: every piece's sections in order, one after another.
        uint32[] chances;
    }

    /// @notice One second of the price: from the second before's close to this one's high, low and close.
    struct Bar {
        uint8 market;
        uint64 second;
        uint64 prevClose;
        uint64 high;
        uint64 low;
        uint64 close;
    }

    struct Market {
        bool active;
        uint8 difficulty;
        /// @dev keccak256 of the market's name, as the oracle's `Price` names it: "BTC-USD".
        bytes32 nameHash;
    }

    /// @notice A player's session key. `key` set: an Ethereum key. Otherwise `x`, `y`: a P-256 public key.
    struct Session {
        address key;
        uint40 validUntil;
        /// @dev USDC the session may still stake.
        uint56 allowance;
        bytes32 x;
        bytes32 y;
    }

    /// @dev One bet: a piece as placed. Sections are packed one to a word: second | lo << 8 | hi << 72 | stake << 136 | rung << 200.
    struct Bet {
        address player;
        uint8 market;
        uint8 difficulty;
        uint8 count;
        uint32 liveMask;
        uint32 hitMask;
        uint64 openAt;
        uint64 perDot;
        uint64 unit;
        uint64 stake;
        uint256[32] sections;
    }

    /// @notice What the game looks like from outside.
    struct BetView {
        address player;
        uint8 market;
        uint8 difficulty;
        uint64 openAt;
        uint64 perDot;
        uint64 unit;
        uint64 stake;
        uint32 liveMask;
        uint32 hitMask;
        Section[] sections;
        uint16[] rungs;
    }

    struct Config {
        uint16 feeBps;
        uint16 profitFeeBps;
        uint16 sweepBps;
        uint32 lateMs;
        uint32 placeGraceMs;
        uint32 maxPriceAgeMs;
        uint64 minPerDot;
        uint64 maxPerDot;
        uint64 maxPieceStake;
        uint64 minRedeem;
    }

    /// @notice Why a piece in a batch was not placed. The rest of the batch goes through.
    enum Refusal {
        None,
        Mismatch,
        Replay,
        Difficulty,
        Late,
        StalePrice,
        PerDot,
        Sections,
        PriceSig,
        Stroke,
        Session,
        SessionSig,
        NotOffered,
        Allowance,
        Balance
    }

    /// @dev This contract is live behind a UUPS proxy, and an upgrade keeps this storage as it is. So: never reorder,
    /// retype or insert a field here, nor in any struct stored under it (Market, Session, Bet, Config). New state goes
    /// at the end of this struct, or of a struct that is only a mapping's value, or in a new ERC-7201 namespace;
    /// Config sits inline and may not grow. A field no longer used keeps its place. `evm/layout.ts --check` holds
    /// the layout to `snapshots/StorageLayout.json`.
    /// @custom:storage-location erc7201:skech.game
    struct GameStorage {
        IERC20 usdc;
        ISkechIOU iou;
        address revenue;
        address oracle;
        /// @dev USDC backing live stakes and paying hits: everything deposited that is not a balance or a fee.
        uint64 pool;
        /// @dev Fees taken and not yet collected.
        uint64 fees;
        Config config;
        /// @dev Deprecated: written by version 1, read by nothing. Kept so every field after it stays where it is.
        uint8 marketCount;
        mapping(uint8 => Market) markets;
        mapping(address => uint64) balances;
        mapping(address => Session) sessions;
        mapping(bytes32 => Bet) bets;
        /// @dev Pieces the oracle quoted that were refused. Spent like a placed bet's name, so the same signed piece
        /// can never go in later, once its price is known.
        mapping(bytes32 => bool) refused;
        /// @dev What the game owes in IOU, as it was owed: the basis of every share outstanding.
        uint64 owed;
    }

    /* ------------------------------------------------------------------ */
    /* Constants                                                           */
    /* ------------------------------------------------------------------ */

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Seconds ahead a band may be.
    uint8 public constant HORIZON = 30;
    /// @notice The least difficulty a market may be set to, as `SkechLadder` prices it.
    uint8 public constant MIN_DIFFICULTY = SkechLadder.MIN_DIFFICULTY;
    /// @notice Sections in one piece, at most.
    uint8 public constant MAX_SECTIONS = 32;
    /// @notice A second, in ms: every time here is in ms on the exchange's clock, and pieces and bars are on whole seconds.
    uint64 public constant SECOND_MS = 1000;
    /// @notice The price is at least this many grid units: a unit, which also pads every band, is a sliver of it.
    uint256 public constant MIN_UNITS_IN_PRICE = 2000;

    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(string market,uint256 price,uint64 time)");
    bytes32 public constant BAR_TYPEHASH =
        keccak256("Bar(uint8 market,uint64 second,uint64 prevClose,uint64 high,uint64 low,uint64 close)");
    bytes32 public constant SECTION_TYPEHASH = keccak256("Section(uint8 second,uint64 lo,uint64 hi,uint64 stake)");
    bytes32 public constant PIECE_TYPEHASH = keccak256(
        "Piece(address player,uint64 drawing,uint32 index,uint8 market,uint8 difficulty,uint64 openAt,uint64 perDot,uint64 unit,uint64 priceSeen,uint64 priceTime,Section[] sections,bytes32 strokeHash)Section(uint8 second,uint64 lo,uint64 hi,uint64 stake)"
    );
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 market,uint64 openAt,uint64 unit,uint64 price,int64 momentum,bytes32[] pieces,uint64[] receivedAt,uint32[] chances)"
    );
    bytes32 public constant SESSION_TYPEHASH = keccak256(
        "Session(address player,uint8 kind,address key,bytes32 x,bytes32 y,uint64 validUntil,uint64 allowance,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant REVOKE_TYPEHASH = keccak256("RevokeSession(address player,uint256 nonce,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address player,uint64 amount,address to,uint256 nonce,uint256 deadline)");

    // keccak256(abi.encode(uint256(keccak256("skech.game")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE = 0xf8cdf277c1dee82b808ef4977285f6a5b9934cf12bad104f17f251bc2b63ec00;
    bytes32 private constant BARS_SALT = keccak256("skech.game.bars");

    uint256 private constant BPS = 10_000;

    /* The bounds on the config: what the admin may set, at most (or at least). */
    uint16 public constant MAX_FEE_BPS = 2000;
    uint16 public constant MAX_PROFIT_FEE_BPS = 5000;
    uint16 public constant MAX_SWEEP_BPS = 5000;
    uint32 public constant MAX_LATE_MS = 1000;
    uint32 public constant MIN_PLACE_GRACE_MS = 1000;
    uint32 public constant MAX_PLACE_GRACE_MS = 10_000;
    /// @notice A minute: a price older than that is not what the player saw.
    uint32 public constant MAX_PRICE_AGE_MS = 60_000;
    /// @notice $10,000 a dot: 256 dots of it fit a stake with room to spare.
    uint64 public constant MAX_PER_DOT = 10_000e6;
    /// @notice $1,000,000 a piece.
    uint64 public constant MAX_PIECE_STAKE = 1_000_000e6;
    /// @notice $100: the least a partial IOU redemption may be worth can never be set so high it stops them.
    uint64 public constant MAX_MIN_REDEEM = 100e6;

    /// @notice How long after a bet's last second a band no bar has decided may be refunded, ms: an hour.
    uint64 public constant EXPIRE_AFTER_MS = 3_600_000;

    /* ------------------------------------------------------------------ */
    /* Events and errors                                                   */
    /* ------------------------------------------------------------------ */

    event Deposited(address indexed player, address indexed from, uint64 amount);
    event Withdrawn(address indexed player, address indexed to, uint64 amount);
    event SessionSet(address indexed player, uint8 kind, address key, bytes32 x, bytes32 y, uint64 validUntil, uint64 allowance);
    event SessionRevoked(address indexed player);
    /// @notice A piece went in. `sections` are packed as stored; `refunded` is the stake of bands not offered.
    event Placed(
        bytes32 indexed betId,
        address indexed player,
        uint8 market,
        uint64 openAt,
        uint64 perDot,
        uint64 unit,
        uint64 staked,
        uint64 fee,
        uint64 refunded,
        uint64 priceSeen,
        uint64 priceTime,
        uint256[] sections
    );
    /// @notice The stroke's points, as the player drew them.
    event Stroke(bytes32 indexed betId, bytes points);
    event Refused(bytes32 indexed betId, address indexed player, uint64 drawing, uint32 index, Refusal why);
    event BarPosted(uint8 indexed market, uint64 indexed second, uint64 prevClose, uint64 high, uint64 low, uint64 close);
    /// @notice Bands decided: `paid` USDC into the balance, `owed` as IOU, and `fee`, the house's cut of the profit, taken.
    event Settled(bytes32 indexed betId, address indexed player, uint32 hitMask, uint32 missMask, uint64 paid, uint64 owed, uint64 fee);
    /// @notice Bands no bar decided, given back: their stake, `paid` into the balance and `owed` as IOU.
    event Refunded(bytes32 indexed betId, address indexed player, uint32 mask, uint64 paid, uint64 owed);
    event Owed(address indexed to, uint64 value, uint256 shares);
    event Redeemed(address indexed holder, address indexed by, uint256 shares, uint64 value, uint64 cut);
    event FeesCollected(uint64 amount);
    event MarketSet(uint8 indexed market, string name, bool active, uint8 difficulty);
    event DifficultySet(uint8 indexed market, uint8 difficulty);
    event OracleSet(address oracle);
    event ConfigSet(Config config);

    error ZeroAddress();
    error ZeroAmount();
    error Expired();
    error BadSignature();
    error BadSession();
    error BadQuote();
    error NotOracle();
    error MarketInactive();
    error Window();
    error BadBar();
    error BarConflict();
    error BarDiscontinuous();
    error Insufficient();
    error NothingToRedeem();
    error BadConfig();
    error BadDifficulty();

    /* ------------------------------------------------------------------ */
    /* Setup                                                               */
    /* ------------------------------------------------------------------ */

    function _s() private pure returns (GameStorage storage $) {
        assembly {
            $.slot := STORAGE
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin Sets everything, upgrades, pauses. The oracle, relayer and treasurer are all it, for now.
    /// @param oracle_ The engine's wallet: signs prices, bars and quotes.
    /// @dev Version 2: a fresh deployment starts where an upgraded one ends up, owing nothing yet.
    function initialize(address admin, address oracle_, IERC20 usdc_, ISkechIOU iou_, address revenue_) external reinitializer(2) {
        if (
            admin == address(0) || oracle_ == address(0) || address(usdc_) == address(0) || address(iou_) == address(0)
                || revenue_ == address(0)
        ) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("skech", "1");
        __Nonces_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        GameStorage storage $ = _s();
        $.usdc = usdc_;
        $.iou = iou_;
        $.revenue = revenue_;
        $.oracle = oracle_;
        emit OracleSet(oracle_);
        _setConfig(
            Config({
                feeBps: 400,
                profitFeeBps: 1000,
                sweepBps: 1000,
                lateMs: 200,
                placeGraceMs: 3000,
                maxPriceAgeMs: 15_000,
                minPerDot: 10_000, // 1 cent
                maxPerDot: 100_000_000, // $100
                maxPieceStake: 10_000_000_000, // $10,000
                minRedeem: 10_000
            })
        );
        _setMarket(0, "BTC-USD", true, 51);
    }

    /// @notice The upgrade from version 1, in the same transaction (`upgradeToAndCall`): the IOU already owed, which
    /// version 1 kept no count of. `owedNow` is the sum of `SkechIOU.basisOf` over every holder.
    function initializeV2(uint64 owedNow) external reinitializer(2) onlyRole(UPGRADER_ROLE) {
        _s().owed = owedNow;
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /* ------------------------------------------------------------------ */
    /* Admin                                                               */
    /* ------------------------------------------------------------------ */

    function setOracle(address oracle_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle_ == address(0)) revert ZeroAddress();
        _s().oracle = oracle_;
        emit OracleSet(oracle_);
    }

    /// @notice Add or change a market. Its `name` must be what the oracle's `Price` calls it.
    function setMarket(uint8 id, string calldata name, bool active, uint8 difficulty) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMarket(id, name, active, difficulty);
    }

    /// @notice How hard the game is on `market`, 50 to 100: pieces placed from now on pay by it. Pieces already open keep
    /// theirs. Below 50, ink exactly on a rung would return more than a dollar.
    function setDifficulty(uint8 market, uint8 difficulty) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (difficulty < SkechLadder.MIN_DIFFICULTY || difficulty > 100) revert BadDifficulty();
        GameStorage storage $ = _s();
        if ($.markets[market].nameHash == bytes32(0)) revert MarketInactive();
        $.markets[market].difficulty = difficulty;
        emit DifficultySet(market, difficulty);
    }

    function setConfig(Config calldata config_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(config_);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _setMarket(uint8 id, string memory name, bool active, uint8 difficulty) private {
        if (difficulty < SkechLadder.MIN_DIFFICULTY || difficulty > 100) revert BadDifficulty();
        if (bytes(name).length == 0) revert BadConfig();
        GameStorage storage $ = _s();
        $.markets[id] = Market({active: active, difficulty: difficulty, nameHash: keccak256(bytes(name))});
        emit MarketSet(id, name, active, difficulty);
    }

    function _setConfig(Config memory c) private {
        if (c.feeBps > MAX_FEE_BPS || c.profitFeeBps > MAX_PROFIT_FEE_BPS || c.sweepBps > MAX_SWEEP_BPS) revert BadConfig();
        if (c.minPerDot == 0 || c.minPerDot > c.maxPerDot || c.maxPerDot > MAX_PER_DOT) revert BadConfig();
        if (c.maxPieceStake == 0 || c.maxPieceStake > MAX_PIECE_STAKE || c.minRedeem > MAX_MIN_REDEEM) revert BadConfig();
        if (c.placeGraceMs < MIN_PLACE_GRACE_MS || c.placeGraceMs > MAX_PLACE_GRACE_MS || c.lateMs > MAX_LATE_MS) revert BadConfig();
        if (c.maxPriceAgeMs == 0 || c.maxPriceAgeMs > MAX_PRICE_AGE_MS) revert BadConfig();
        _s().config = c;
        emit ConfigSet(c);
    }

    /* ------------------------------------------------------------------ */
    /* Money in and out                                                    */
    /* ------------------------------------------------------------------ */

    /// @notice Put USDC into your balance. Approve this contract first.
    function deposit(uint64 amount) external {
        _deposit(msg.sender, msg.sender, amount);
    }

    /// @notice Put USDC into `player`'s balance.
    function depositFor(address player, uint64 amount) external {
        _deposit(msg.sender, player, amount);
    }

    /// @notice Put `owner`'s USDC into their balance on the strength of their permit, so anyone can send the transaction for them.
    /// @dev The permit is tried, not required: if someone spent it first the allowance is already there. But then only
    /// the owner may go on: without a permit that worked, anyone could move an allowance the owner left standing into
    /// the game, on no say-so of theirs.
    function depositWithPermit(address owner, uint64 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(_s().usdc)).permit(owner, address(this), amount, deadline, v, r, s) {}
        catch {
            if (msg.sender != owner) revert BadSignature();
        }
        _deposit(owner, owner, amount);
    }

    /// @notice Put `owner`'s USDC into their balance on the strength of an EIP-3009 authorization they signed, the way
    /// x402 moves USDC: one signature, no allowance, a random nonce so any number can be in flight at once. USDC carries
    /// it out only for its payee, this contract, so nobody can use the signature anywhere else, and whoever sends the
    /// transaction, the USDC is credited to `owner`.
    /// @param validAfter,validBefore The window the authorization is good for, in seconds, as USDC checks it.
    /// @param nonce 32 random bytes, chosen by whoever signs.
    function depositWithAuthorization(
        address owner,
        uint64 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        if (owner == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        IERC20 token = $.usdc;
        uint256 before = token.balanceOf(address(this));
        IUSDCAuthorization(address(token)).receiveWithAuthorization(owner, address(this), amount, validAfter, validBefore, nonce, signature);
        // Credit what arrived, never what was asked for: a token that moved less, or nothing, credits nothing extra.
        if (token.balanceOf(address(this)) - before != amount) revert Insufficient();
        $.balances[owner] += amount;
        emit Deposited(owner, owner, amount);
    }

    function _deposit(address from, address player, uint64 amount) private whenNotPaused nonReentrant {
        if (player == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        $.usdc.safeTransferFrom(from, address(this), amount);
        $.balances[player] += amount;
        emit Deposited(player, from, amount);
    }

    /// @notice Take USDC out of your balance. Always open, paused or not: a session key cannot do this, only you.
    function withdraw(uint64 amount, address to) external nonReentrant {
        _withdraw(msg.sender, amount, to);
    }

    /// @notice Take USDC out of `player`'s balance on their signed say-so, so anyone can send the transaction for them.
    function withdrawBySig(address player, uint64 amount, address to, uint256 deadline, bytes calldata sig) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _withdrawDigest(player, amount, to, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, sig)) revert BadSignature();
        _useNonce(player);
        _withdraw(player, amount, to);
    }

    function _withdraw(address player, uint64 amount, address to) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        GameStorage storage $ = _s();
        uint64 held = $.balances[player];
        if (held < amount) revert Insufficient();
        $.balances[player] = held - amount;
        $.usdc.safeTransfer(to, amount);
        emit Withdrawn(player, to, amount);
    }

    /* ------------------------------------------------------------------ */
    /* Sessions                                                            */
    /* ------------------------------------------------------------------ */

    /// @notice Let `key` (kind 0, an Ethereum address) or `x`,`y` (kind 1, a P-256 public key) place pieces for `player`
    /// until `validUntil`, staking at most `allowance` USDC in all, on the player's signature. Replaces any session.
    function registerSession(
        address player,
        uint8 kind,
        address key,
        bytes32 x,
        bytes32 y,
        uint64 validUntil,
        uint64 allowance,
        uint256 deadline,
        bytes calldata sig
    ) external whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        if (kind == 0) {
            if (key == address(0) || x != 0 || y != 0) revert BadSession();
        } else if (kind == 1) {
            if (key != address(0) || !P256.isValidPublicKey(x, y)) revert BadSession();
        } else {
            revert BadSession();
        }
        if (validUntil >= 1 << 40 || allowance >= 1 << 56) revert BadSession();
        bytes32 digest = _sessionDigest(player, kind, key, x, y, validUntil, allowance, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, sig)) revert BadSignature();
        _useNonce(player);
        _s().sessions[player] = Session({key: key, validUntil: uint40(validUntil), allowance: uint56(allowance), x: x, y: y});
        emit SessionSet(player, kind, key, x, y, validUntil, allowance);
    }

    /// @notice End your session now. It uses up your nonce, so a session you signed and nobody has sent yet cannot
    /// bring the key back afterwards.
    function revokeSession() external {
        _revokeSession(msg.sender);
    }

    /// @notice End `player`'s session on their signed say-so, so anyone can send the transaction for them.
    function revokeSessionBySig(address player, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _revokeDigest(player, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(player, digest, sig)) revert BadSignature();
        _revokeSession(player);
    }

    function _revokeSession(address player) private {
        _useNonce(player);
        delete _s().sessions[player];
        emit SessionRevoked(player);
    }

    /* ------------------------------------------------------------------ */
    /* Placing                                                             */
    /* ------------------------------------------------------------------ */

    /// @notice Place a batch of pieces that open on one second, with the oracle's quote for them. Anyone may send
    /// this: every piece is signed by its player and the quote by the oracle. A piece that cannot go in is
    /// refused with a reason and the rest go in; nothing is charged for a refused piece.
    function place(Placement[] calldata placements, Quote calldata quote, bytes calldata quoteSig) external whenNotPaused {
        GameStorage storage $ = _s();
        uint256 n = placements.length;
        if (n == 0 || quote.receivedAt.length != n) revert BadQuote();
        Market storage market = $.markets[quote.market];
        if (!market.active) revert MarketInactive();
        if (quote.openAt % SECOND_MS != 0 || quote.unit == 0 || quote.price == 0) revert BadQuote();
        // A grid unit is a sliver of the price: it also pads every band, so it cannot be let grow.
        if (uint256(quote.unit) * MIN_UNITS_IN_PRICE > quote.price) revert BadQuote();
        // Inside the window: not long after the second the pieces open on, and not before it either.
        uint256 nowMs = block.timestamp * SECOND_MS;
        uint32 grace = $.config.placeGraceMs;
        if (nowMs > quote.openAt + grace || quote.openAt > nowMs + grace) revert Window();

        bytes32[] memory hashes = new bytes32[](n);
        uint256 bands;
        for (uint256 i = 0; i < n; i++) {
            hashes[i] = hashPiece(placements[i].piece);
            bands += placements[i].piece.sections.length;
        }
        if (quote.chances.length != bands) revert BadQuote();
        if (ECDSA.recover(_quoteDigest(quote, keccak256(abi.encodePacked(hashes))), quoteSig) != $.oracle) revert NotOracle();

        uint256 cursor;
        uint256 pooled;
        uint256 taken;
        for (uint256 i = 0; i < n; i++) {
            uint256 count = placements[i].piece.sections.length;
            (uint64 staked, uint64 fee) =
                _place(placements[i], hashes[i], quote, market, quote.receivedAt[i], quote.chances[cursor:cursor + count]);
            cursor += count;
            pooled += staked - fee;
            taken += fee;
        }
        $.pool += SafeCast.toUint64(pooled);
        $.fees += SafeCast.toUint64(taken);
    }

    /// @dev One piece. Returns what it staked (after fees, into the pool) and the fee; both zero if refused.
    function _place(
        Placement calldata pl,
        bytes32 pieceHash,
        Quote calldata q,
        Market storage market,
        uint64 receivedAt,
        uint32[] calldata chances
    ) private returns (uint64 staked, uint64 fee) {
        Piece calldata p = pl.piece;
        bytes32 betId = keccak256(abi.encodePacked(p.player, p.drawing, p.index));
        Refusal why = _check(p, pl, betId, pieceHash, q, market, receivedAt);
        if (why != Refusal.None) {
            _refuse(p, betId, why);
            return (0, 0);
        }
        GameStorage storage $ = _s();
        uint256 total;
        uint256 kept;
        uint256[] memory packed = new uint256[](p.sections.length);
        uint8 count;
        uint256 bars = _barsOf(q.market);
        for (uint256 i = 0; i < p.sections.length; i++) {
            Section calldata s = p.sections[i];
            total += s.stake;
            // Not offered: its second is already over on chain, or its chance earns no rung. Its stake is not taken.
            if (_barAt(bars, p.openAt + uint64(s.second) * SECOND_MS) != 0) continue;
            uint16 rung = SkechLadder.rungFor(chances[i], p.difficulty, _withIt(s, q), q.momentum);
            if (rung == 0) continue;
            // One section never pays past 256 dots: a big one stakes only what that pays for.
            uint64 stake = s.stake;
            uint64 most = SkechLadder.maxStake(p.perDot, rung);
            if (stake > most) stake = most;
            packed[count] = uint256(s.second) | (uint256(s.lo) << 8) | (uint256(s.hi) << 72) | (uint256(stake) << 136)
                | (uint256(rung) << 200);
            kept += stake;
            count++;
        }
        if (kept == 0) {
            _refuse(p, betId, Refusal.NotOffered);
            return (0, 0);
        }
        Session storage session = $.sessions[p.player];
        if (session.allowance < kept) {
            _refuse(p, betId, Refusal.Allowance);
            return (0, 0);
        }
        uint64 held = $.balances[p.player];
        if (held < kept) {
            _refuse(p, betId, Refusal.Balance);
            return (0, 0);
        }
        // Everything checks out: only now is anything written.
        staked = uint64(kept);
        fee = uint64(_feeOf(kept, $.config.feeBps));
        $.balances[p.player] = held - staked;
        session.allowance -= uint56(kept);
        Bet storage b = $.bets[betId];
        for (uint256 i = 0; i < count; i++) {
            b.sections[i] = packed[i];
        }
        b.player = p.player;
        b.market = p.market;
        b.difficulty = p.difficulty;
        b.count = count;
        b.liveMask = uint32((1 << count) - 1);
        b.openAt = p.openAt;
        b.perDot = p.perDot;
        b.unit = p.unit;
        b.stake = staked;
        assembly {
            mstore(packed, count)
        }
        emit Placed(betId, p.player, p.market, p.openAt, p.perDot, p.unit, staked, fee, uint64(total - kept), p.priceSeen, p.priceTime, packed);
        emit Stroke(betId, pl.stroke);
    }

    /// @dev A quoted piece that does not go in. Its name is spent all the same: its calldata is public, and sent again
    /// once the player had topped up their balance or allowance, or registered the key, it would be a bet placed
    /// after its price was seen. The player signs the ink again under a new index instead.
    function _refuse(Piece calldata p, bytes32 betId, Refusal why) private {
        if (why != Refusal.Replay) _s().refused[betId] = true;
        emit Refused(betId, p.player, p.drawing, p.index, why);
    }

    /// @dev Everything about a piece that can be wrong before its bands are priced.
    function _check(
        Piece calldata p,
        Placement calldata pl,
        bytes32 betId,
        bytes32 pieceHash,
        Quote calldata q,
        Market storage market,
        uint64 receivedAt
    ) private view returns (Refusal) {
        GameStorage storage $ = _s();
        Config storage c = $.config;
        if (p.market != q.market || p.openAt != q.openAt || p.unit != q.unit) return Refusal.Mismatch;
        if ($.bets[betId].player != address(0) || $.refused[betId]) return Refusal.Replay;
        if (p.difficulty != market.difficulty) return Refusal.Difficulty;
        // The engine must have had the piece before its opening second, give or take the network.
        if (receivedAt > p.openAt + c.lateMs) return Refusal.Late;
        if (p.priceTime > receivedAt || receivedAt - p.priceTime > c.maxPriceAgeMs) return Refusal.StalePrice;
        if (p.perDot < c.minPerDot || p.perDot > c.maxPerDot) return Refusal.PerDot;
        uint256 n = p.sections.length;
        if (n == 0 || n > MAX_SECTIONS) return Refusal.Sections;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            Section calldata s = p.sections[i];
            if (s.second == 0 || s.second > HORIZON || s.lo >= s.hi || s.stake == 0) return Refusal.Sections;
            if (s.lo % p.unit != 0 || s.hi % p.unit != 0) return Refusal.Sections;
            total += s.stake;
        }
        if (total > c.maxPieceStake) return Refusal.Sections;
        if (keccak256(pl.stroke) != p.strokeHash) return Refusal.Stroke;
        // The price the player saw: signed by the oracle, for this market.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(
            _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, market.nameHash, uint256(p.priceSeen), p.priceTime))),
            pl.priceSig
        );
        if (err != ECDSA.RecoverError.NoError || signer != $.oracle) return Refusal.PriceSig;
        Session storage session = $.sessions[p.player];
        if (session.validUntil <= block.timestamp) return Refusal.Session;
        bytes32 digest = _hashTypedDataV4(pieceHash);
        if (session.key != address(0)) {
            (address k, ECDSA.RecoverError e,) = ECDSA.tryRecover(digest, pl.sessionSig);
            if (e != ECDSA.RecoverError.NoError || k != session.key) return Refusal.SessionSig;
        } else {
            // WebCrypto signs SHA-256 of what it is given: the digest.
            if (pl.sessionSig.length != 64) return Refusal.SessionSig;
            bytes32 r = bytes32(pl.sessionSig[0:32]);
            bytes32 s = bytes32(pl.sessionSig[32:64]);
            if (!P256.verify(sha256(abi.encodePacked(digest)), r, s, session.x, session.y)) return Refusal.SessionSig;
        }
        return Refusal.None;
    }

    /// @dev Whether a band is on the side the price has just moved toward, where the momentum margin comes off.
    function _withIt(Section calldata s, Quote calldata q) private pure returns (bool) {
        uint256 mid = (uint256(s.lo) + uint256(s.hi)) / 2;
        return (mid > q.price && q.momentum > 0) || (mid < q.price && q.momentum < 0);
    }

    /* ------------------------------------------------------------------ */
    /* The price, and settling on it                                       */
    /* ------------------------------------------------------------------ */

    /// @notice Record one second of the price, signed by the oracle. Posting the same bar twice is fine; a different one for the same second is not.
    function postBar(Bar calldata bar, bytes calldata sig) external whenNotPaused {
        _postBar(bar, sig);
    }

    /// @notice Record a second of the price and settle the bets that have ink in it: the relayer's one transaction a second.
    function postBarAndSettle(Bar calldata bar, bytes calldata sig, bytes32[] calldata betIds) external whenNotPaused {
        _postBar(bar, sig);
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    /// @notice Record several seconds and settle after them.
    function postBarsAndSettle(Bar[] calldata bars, bytes[] calldata sigs, bytes32[] calldata betIds) external whenNotPaused {
        if (bars.length != sigs.length) revert BadBar();
        for (uint256 i = 0; i < bars.length; i++) {
            _postBar(bars[i], sigs[i]);
        }
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    /// @notice Settle bets on the bars already posted: bands in a posted second are hit or missed; the rest wait.
    function settle(bytes32[] calldata betIds) external whenNotPaused {
        for (uint256 i = 0; i < betIds.length; i++) {
            _settle(betIds[i]);
        }
    }

    /// @notice Give back the stake of bands no bar ever decided, so a bet can never be stuck. Once a bet's last second
    /// is `EXPIRE_AFTER_MS` gone, it is settled on whatever bars there are, and the stake of every band still live is
    /// paid back from the pool, as a win is: in USDC as far as the pool goes, the rest owed as IOU. The fee taken on
    /// it stays the house's. Bets not yet due, or already decided, are left as they are. Anyone may.
    function expire(bytes32[] calldata betIds) external whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        uint256 nowMs = block.timestamp * SECOND_MS;
        for (uint256 i = 0; i < betIds.length; i++) {
            bytes32 betId = betIds[i];
            Bet storage b = $.bets[betId];
            if (b.player == address(0) || b.liveMask == 0) continue;
            if (nowMs < uint256(b.openAt) + uint256(HORIZON) * SECOND_MS + EXPIRE_AFTER_MS) continue;
            // A band whose bar is up is decided by it, hit or miss, never refunded.
            _settle(betId);
            uint32 live = b.liveMask;
            if (live == 0) continue;
            uint256 refund;
            for (uint256 k = 0; k < b.count; k++) {
                if (live & (1 << k) != 0) refund += uint64(b.sections[k] >> 136);
            }
            b.liveMask = 0;
            (uint64 paid, uint64 owed) = _pay(b.player, uint64(refund));
            emit Refunded(betId, b.player, live, paid, owed);
        }
    }

    function _postBar(Bar calldata bar, bytes calldata sig) private {
        GameStorage storage $ = _s();
        // A market that is not active takes no new pieces, but its seconds are still posted: what is open settles.
        if ($.markets[bar.market].nameHash == bytes32(0)) revert MarketInactive();
        if (bar.second % SECOND_MS != 0 || bar.low == 0 || bar.prevClose == 0) revert BadBar();
        if (bar.low > bar.high || bar.close < bar.low || bar.close > bar.high) revert BadBar();
        // A second is posted only once it is over by this chain's clock: never while ink in it can still be placed.
        if (bar.second + SECOND_MS > block.timestamp * SECOND_MS) revert BadBar();
        if (ECDSA.recover(_barDigest(bar), sig) != $.oracle) revert NotOracle();
        uint256 packed = uint256(bar.prevClose) | (uint256(bar.high) << 64) | (uint256(bar.low) << 128) | (uint256(bar.close) << 192);
        uint256 bars = _barsOf(bar.market);
        uint256 existing = _barAt(bars, bar.second);
        if (existing != 0) {
            if (existing != packed) revert BarConflict();
            return;
        }
        // One second follows from the last: the previous bar's close is this one's opening price, and this one's close
        // the next one's, when a later second went up first.
        uint256 previous = bar.second >= SECOND_MS ? _barAt(bars, bar.second - SECOND_MS) : 0;
        if (previous != 0 && uint64(previous >> 192) != bar.prevClose) revert BarDiscontinuous();
        uint256 next = _barAt(bars, bar.second + SECOND_MS);
        if (next != 0 && uint64(next) != bar.close) revert BarDiscontinuous();
        uint256 slot = bars + bar.second / SECOND_MS;
        assembly {
            sstore(slot, packed)
        }
        emit BarPosted(bar.market, bar.second, bar.prevClose, bar.high, bar.low, bar.close);
    }

    function _settle(bytes32 betId) private {
        GameStorage storage $ = _s();
        Bet storage b = $.bets[betId];
        uint32 live = b.liveMask;
        if (b.player == address(0) || live == 0) return;
        uint8 count = b.count;
        uint64 openAt = b.openAt;
        uint64 unit = b.unit;
        uint256 bars = _barsOf(b.market);
        uint32 hits;
        uint32 decided;
        uint256 grossPay;
        uint256 stakeHit;
        for (uint256 i = 0; i < count; i++) {
            uint32 bit = uint32(1 << i);
            if (live & bit == 0) continue;
            uint256 word = b.sections[i];
            uint256 bar = _barAt(bars, openAt + uint64(uint8(word)) * SECOND_MS);
            if (bar == 0) continue;
            decided |= bit;
            // What the price covered in the second: from where the second before closed to its own high and low.
            uint256 prevClose = uint64(bar);
            uint256 high = uint64(bar >> 64);
            uint256 low = uint64(bar >> 128);
            if (prevClose > high) high = prevClose;
            if (prevClose < low) low = prevClose;
            uint256 lo = uint64(word >> 8);
            uint256 hi = uint64(word >> 72);
            // A band is judged one unit wider each way, as it was priced: the ink's own edges, inclusive.
            if (high + unit >= lo && low <= hi + unit) {
                hits |= bit;
                uint64 stake = uint64(word >> 136);
                stakeHit += stake;
                grossPay += SkechLadder.gross(stake, uint16(word >> 200));
            }
        }
        if (decided == 0) return;
        b.liveMask = live & ~decided;
        b.hitMask |= hits;
        uint64 paid;
        uint64 owed;
        uint64 fee;
        if (grossPay > 0) {
            uint256 profit = grossPay - stakeHit;
            uint256 profitFee = _feeOf(profit, $.config.profitFeeBps);
            (paid, owed) = _pay(b.player, uint64(grossPay - profitFee));
            // The player is paid first. The house's cut comes after, out of what the pool has left, and never as an IOU:
            // what the pool cannot pay it goes without, so a shortfall is never made worse by a debt growing to the house.
            uint64 available = $.pool;
            fee = profitFee <= available ? uint64(profitFee) : available;
            if (fee > 0) {
                $.pool = available - fee;
                $.fees += fee;
            }
        }
        emit Settled(betId, b.player, hits, decided & ~hits, paid, owed, fee);
    }

    /// @dev Pay `due` to `to` from the pool: in USDC as far as it goes, the rest as IOU, counted in `owed`.
    function _pay(address to, uint64 due) private returns (uint64 paid, uint64 owed) {
        GameStorage storage $ = _s();
        uint64 available = $.pool;
        paid = due <= available ? due : available;
        if (paid > 0) {
            $.pool = available - paid;
            _credit(to, paid);
        }
        owed = due - paid;
        if (owed > 0) {
            $.owed += owed;
            uint256 shares = $.iou.mint(to, owed);
            emit Owed(to, owed, shares);
        }
    }

    /// @dev The house's share of `amount`, rounded up: a stake or a profit split small never slips under the fee.
    /// Never more than `amount`, since no fee is over half of it.
    function _feeOf(uint256 amount, uint16 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }

    function _credit(address to, uint64 amount) private {
        GameStorage storage $ = _s();
        if (to == $.revenue) $.fees += amount;
        else $.balances[to] += amount;
    }

    /* ------------------------------------------------------------------ */
    /* IOUs and fees                                                       */
    /* ------------------------------------------------------------------ */

    /// @notice Pay off `holder`'s IOU, as much of `shares` as the pool can cover, into their balance. Anyone may do
    /// this, and is paid a share of the growth for it; a holder redeeming their own pays nothing.
    function redeem(address holder, uint256 shares) external whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        ISkechIOU token = $.iou;
        uint256 held = token.balanceOf(holder);
        if (shares > held) shares = held;
        if (shares == 0) revert NothingToRedeem();
        uint64 value = token.valueOf(shares);
        uint64 available = $.pool;
        if (value > available) {
            // What the pool can pay now; the rest stays owed, and keeps growing.
            shares = (shares * available) / value;
            value = token.valueOf(shares);
        }
        if (shares == 0 || value == 0) revert NothingToRedeem();
        if (shares < held && value < $.config.minRedeem) revert NothingToRedeem();
        (uint64 v, uint64 basis) = token.burn(holder, shares);
        if (v > available) revert Insufficient();
        $.owed -= basis;
        $.pool = available - v;
        uint64 growth = v > basis ? v - basis : 0;
        uint64 cut = msg.sender == holder ? 0 : uint64((uint256(growth) * $.config.sweepBps) / BPS);
        _credit(holder, v - cut);
        if (cut > 0) _credit(msg.sender, cut);
        emit Redeemed(holder, msg.sender, shares, v, cut);
    }

    /// @notice Move the fees taken so far to the revenue holder. Anyone may.
    function collectFees() external nonReentrant returns (uint64 amount) {
        GameStorage storage $ = _s();
        amount = $.fees;
        if (amount == 0) return 0;
        $.fees = 0;
        $.usdc.safeTransfer($.revenue, amount);
        emit FeesCollected(amount);
    }

    /* ------------------------------------------------------------------ */
    /* Reading                                                             */
    /* ------------------------------------------------------------------ */

    function balanceOf(address player) external view returns (uint64) {
        return _s().balances[player];
    }

    function sessionOf(address player) external view returns (Session memory) {
        return _s().sessions[player];
    }

    /// @notice What the game owes in IOU, as it was owed when issued: the IOUs' basis, before their growth.
    function owed() external view returns (uint64) {
        return _s().owed;
    }

    function pool() external view returns (uint64) {
        return _s().pool;
    }

    function fees() external view returns (uint64) {
        return _s().fees;
    }

    function oracle() external view returns (address) {
        return _s().oracle;
    }

    function usdc() external view returns (IERC20) {
        return _s().usdc;
    }

    function iou() external view returns (ISkechIOU) {
        return _s().iou;
    }

    function revenue() external view returns (address) {
        return _s().revenue;
    }

    function config() external view returns (Config memory) {
        return _s().config;
    }

    function marketOf(uint8 id) external view returns (Market memory) {
        return _s().markets[id];
    }

    function difficultyOf(uint8 market) external view returns (uint8) {
        return _s().markets[market].difficulty;
    }

    /// @notice The bet a piece became.
    function betOf(bytes32 betId) external view returns (BetView memory v) {
        Bet storage b = _s().bets[betId];
        v.player = b.player;
        v.market = b.market;
        v.difficulty = b.difficulty;
        v.openAt = b.openAt;
        v.perDot = b.perDot;
        v.unit = b.unit;
        v.stake = b.stake;
        v.liveMask = b.liveMask;
        v.hitMask = b.hitMask;
        v.sections = new Section[](b.count);
        v.rungs = new uint16[](b.count);
        for (uint256 i = 0; i < b.count; i++) {
            uint256 w = b.sections[i];
            v.sections[i] = Section({second: uint8(w), lo: uint64(w >> 8), hi: uint64(w >> 72), stake: uint64(w >> 136)});
            v.rungs[i] = uint16(w >> 200);
        }
    }

    /// @notice Whether a piece the oracle quoted was refused: its name is spent, and it can never be placed.
    function wasRefused(bytes32 betId) external view returns (bool) {
        return _s().refused[betId];
    }

    /// @notice The name of a piece's bet.
    function betIdOf(address player, uint64 drawing, uint32 index) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(player, drawing, index));
    }

    /// @notice The bar for `second` (ms) on `market`, all zero if not posted.
    function barAt(uint8 market, uint64 second) external view returns (uint64 prevClose, uint64 high, uint64 low, uint64 close) {
        uint256 bar = _barAt(_barsOf(market), second);
        return (uint64(bar), uint64(bar >> 64), uint64(bar >> 128), uint64(bar >> 192));
    }

    /// @notice The rung, x100, a band earns here: the ladder is on chain. Zero when not offered.
    function rungFor(uint8 market, uint32 chanceE9, bool withIt, int64 momentumE6) external view returns (uint16) {
        return SkechLadder.rungFor(chanceE9, _s().markets[market].difficulty, withIt, momentumE6);
    }

    /// @notice The EIP-712 struct hash of a piece: what a session key signs, under this contract's domain.
    function hashPiece(Piece calldata p) public pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](p.sections.length);
        for (uint256 i = 0; i < h.length; i++) {
            Section calldata s = p.sections[i];
            h[i] = keccak256(abi.encode(SECTION_TYPEHASH, s.second, s.lo, s.hi, s.stake));
        }
        return keccak256(
            abi.encode(
                PIECE_TYPEHASH,
                p.player,
                p.drawing,
                p.index,
                p.market,
                p.difficulty,
                p.openAt,
                p.perDot,
                p.unit,
                p.priceSeen,
                p.priceTime,
                keccak256(abi.encodePacked(h)),
                p.strokeHash
            )
        );
    }

    /// @notice The digest a session key signs for `p`.
    function pieceDigest(Piece calldata p) external view returns (bytes32) {
        return _hashTypedDataV4(hashPiece(p));
    }

    /// @notice The digest the oracle signs for a quote over these pieces.
    function quoteDigest(Quote calldata quote, bytes32[] calldata pieces) external view returns (bytes32) {
        return _quoteDigest(quote, keccak256(abi.encodePacked(pieces)));
    }

    /// @notice The digest a player's wallet signs to register a session.
    function sessionDigest(
        address player,
        uint8 kind,
        address key,
        bytes32 x,
        bytes32 y,
        uint64 validUntil,
        uint64 allowance,
        uint256 deadline
    ) external view returns (bytes32) {
        return _sessionDigest(player, kind, key, x, y, validUntil, allowance, deadline);
    }

    /// @notice The digest a player's wallet signs to end their session through someone else's transaction.
    function revokeDigest(address player, uint256 deadline) external view returns (bytes32) {
        return _revokeDigest(player, deadline);
    }

    /// @notice The digest a player's wallet signs to withdraw through someone else's transaction.
    function withdrawDigest(address player, uint64 amount, address to, uint256 deadline) external view returns (bytes32) {
        return _withdrawDigest(player, amount, to, deadline);
    }

    function barDigest(Bar calldata bar) external view returns (bytes32) {
        return _barDigest(bar);
    }

    function priceDigest(string calldata market, uint256 price, uint64 time) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, keccak256(bytes(market)), price, time)));
    }

    /* ---- the digests, each worked out in one place: what is checked is what the views show ---- */

    /// @dev `pieces`: keccak256 of the pieces' struct hashes, packed, in order.
    function _quoteDigest(Quote calldata quote, bytes32 pieces) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    quote.market,
                    quote.openAt,
                    quote.unit,
                    quote.price,
                    quote.momentum,
                    pieces,
                    keccak256(abi.encodePacked(quote.receivedAt)),
                    keccak256(abi.encodePacked(quote.chances))
                )
            )
        );
    }

    function _barDigest(Bar calldata bar) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(BAR_TYPEHASH, bar.market, bar.second, bar.prevClose, bar.high, bar.low, bar.close))
        );
    }

    /// @dev At the player's next nonce, as every digest a player's wallet signs here is.
    function _sessionDigest(
        address player,
        uint8 kind,
        address key,
        bytes32 x,
        bytes32 y,
        uint64 validUntil,
        uint64 allowance,
        uint256 deadline
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SESSION_TYPEHASH, player, kind, key, x, y, validUntil, allowance, nonces(player), deadline))
        );
    }

    function _revokeDigest(address player, uint256 deadline) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, player, nonces(player), deadline)));
    }

    function _withdrawDigest(address player, uint64 amount, address to, uint256 deadline) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, player, amount, to, nonces(player), deadline)));
    }

    /* ------------------------------------------------------------------ */
    /* Bars: one slot per second, consecutive, so a run of seconds shares a storage page                           */
    /* ------------------------------------------------------------------ */

    /// @dev Where `market`'s bars start: its second `s` is at this slot plus s / SECOND_MS. One hash for all of them.
    function _barsOf(uint8 market) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(BARS_SALT, market)));
    }

    function _barAt(uint256 bars, uint64 second) private view returns (uint256 bar) {
        uint256 slot = bars + second / SECOND_MS;
        assembly {
            bar := sload(slot)
        }
    }
}

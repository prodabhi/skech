// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISkechIOU} from "./interfaces/ISkechIOU.sol";

/// @title SkechIOU
/// @notice What the game owes when it cannot pay a win at once: an I-owe-you, as an ERC-20.
///
/// The house holds no money, so a hit is paid from what other players have lost. When there is not enough of
/// that yet, the winner is issued shares of this token worth exactly what they are owed, and the debt grows
/// every block: a share is worth `index` USDC, and `index` rises by a fixed amount each block. Shares transfer
/// like any token. Anyone may hand a holder's shares back to the game once it has the money (`SkechGame.redeem`),
/// and whoever does is paid a share of the growth; the holder gets the rest.
///
/// Each account also carries a `basis`: the USDC it was owed when its shares were issued, moved pro rata with
/// them on transfer. Growth is value less basis, and that is what the redeemer's cut is taken from.
///
/// Only the game may mint or burn. Values are USDC with 6 decimals; shares have 18, and one share was worth one
/// USDC at the start.
contract SkechIOU is Initializable, ERC20Upgradeable, AccessControlUpgradeable, UUPSUpgradeable, ISkechIOU {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint256 private constant ONE = 1e18;
    /// @dev USDC has 6 decimals and shares 18.
    uint256 private constant SCALE = 1e12;
    /// @notice The fastest the debt may grow, x1e18 a block: 3.5e11 is 10% a day at 300 ms blocks.
    uint256 public constant MAX_RATE = 350_000_000_000;

    /// @dev Live behind a UUPS proxy: never reorder, retype or insert a field here. New state goes at the end, or in
    /// a new ERC-7201 namespace. `evm/layout.ts --check` holds the layout to `snapshots/StorageLayout.json`.
    /// @custom:storage-location erc7201:skech.iou
    struct IOUStorage {
        /// @dev The index at `blockAt`, x1e18.
        uint256 indexAt;
        /// @dev How much the index rises per block, x1e18.
        uint256 ratePerBlock;
        uint64 blockAt;
        mapping(address account => uint64) basis;
    }

    // keccak256(abi.encode(uint256(keccak256("skech.iou")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE = 0x2452509cc4fa7a706c2195d8a01d74e61f4dcca1bc29541a0a9408a170350c00;

    event RateSet(uint256 ratePerBlock, uint256 indexNow);
    event Issued(address indexed to, uint64 value, uint256 shares);
    event Taken(address indexed from, uint256 shares, uint64 value, uint64 basis);

    error ZeroValue();
    error BadRate();

    function _s() private pure returns (IOUStorage storage $) {
        assembly {
            $.slot := STORAGE
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param rate How much a share's value rises each block, x1e18: 3.5e9 is 0.1% a day at 300 ms blocks.
    function initialize(address admin, address minter, uint256 rate) external initializer {
        if (rate > MAX_RATE) revert BadRate();
        __ERC20_init("skech IOU", "IOU");
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        IOUStorage storage $ = _s();
        $.indexAt = ONE;
        $.blockAt = uint64(block.number);
        $.ratePerBlock = rate;
        emit RateSet(rate, ONE);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /* ------------------------------------------------------------------ */
    /* What a share is worth                                               */
    /* ------------------------------------------------------------------ */

    /// @inheritdoc ISkechIOU
    function index() public view returns (uint256) {
        IOUStorage storage $ = _s();
        return $.indexAt + $.ratePerBlock * (block.number - $.blockAt);
    }

    function ratePerBlock() external view returns (uint256) {
        return _s().ratePerBlock;
    }

    /// @inheritdoc ISkechIOU
    function valueOf(uint256 shares) public view returns (uint64) {
        return SafeCast.toUint64((shares * index()) / (ONE * SCALE));
    }

    /// @notice How many shares `value` USDC is worth now, rounded up: an IOU is never worth less than what was owed.
    function sharesFor(uint64 value) public view returns (uint256) {
        return Math.ceilDiv(uint256(value) * SCALE * ONE, index());
    }

    /// @inheritdoc ISkechIOU
    function basisOf(address account) external view returns (uint64) {
        return _s().basis[account];
    }

    /// @notice What `account`'s shares are worth now, in USDC.
    function assetsOf(address account) external view returns (uint64) {
        return valueOf(balanceOf(account));
    }

    /// @inheritdoc ISkechIOU
    function totalAssets() external view returns (uint64) {
        return valueOf(totalSupply());
    }

    /// @notice Set how fast the debt grows, from this block on. What has accrued so far is kept.
    function setRate(uint256 newRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRate > MAX_RATE) revert BadRate();
        IOUStorage storage $ = _s();
        uint256 now_ = index();
        $.indexAt = now_;
        $.blockAt = uint64(block.number);
        $.ratePerBlock = newRate;
        emit RateSet(newRate, now_);
    }

    /* ------------------------------------------------------------------ */
    /* Issued and taken back by the game                                   */
    /* ------------------------------------------------------------------ */

    /// @inheritdoc ISkechIOU
    function mint(address to, uint64 value) external onlyRole(MINTER_ROLE) returns (uint256 shares) {
        if (value == 0) revert ZeroValue();
        shares = sharesFor(value);
        _s().basis[to] += value;
        _mint(to, shares);
        emit Issued(to, value, shares);
    }

    /// @inheritdoc ISkechIOU
    function burn(address from, uint256 shares) external onlyRole(MINTER_ROLE) returns (uint64 value, uint64 basis) {
        IOUStorage storage $ = _s();
        uint256 held = balanceOf(from);
        // The basis leaves with the shares, in proportion; all of it with the last share.
        basis = shares == held ? $.basis[from] : uint64((uint256($.basis[from]) * shares) / held);
        $.basis[from] -= basis;
        value = valueOf(shares);
        _burn(from, shares);
        emit Taken(from, shares, value, basis);
    }

    /// @dev A transfer carries its share of the sender's basis with it, rounded up: sending shares in dust never
    /// leaves their basis behind. Minting and burning set the basis themselves.
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount != 0) {
            IOUStorage storage $ = _s();
            uint256 held = balanceOf(from);
            // Under `held`, the share rounded up is still at most the whole basis; a transfer past it reverts below.
            uint64 moved = amount >= held ? $.basis[from] : uint64(Math.ceilDiv(uint256($.basis[from]) * amount, held));
            $.basis[from] -= moved;
            $.basis[to] += moved;
        }
        super._update(from, to, amount);
    }
}

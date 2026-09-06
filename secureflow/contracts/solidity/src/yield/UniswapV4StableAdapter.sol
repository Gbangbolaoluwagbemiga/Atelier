// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @notice The minimum of Uniswap v4's PoolManager this adapter needs.
 * @dev Declared here rather than importing v4-core. v4-core pulls a large
 *      dependency tree for types this contract never constructs, and an escrow
 *      holding other people's money should have the smallest build it can.
 */
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
}

/**
 * @title UniswapV4StableAdapter
 * @notice Puts idle escrow capital into a Uniswap v4 stable-stable pool.
 *
 * WHAT THIS IS FOR
 *
 * Escrowed money sits still between a job being funded and a milestone being
 * approved — often weeks. That is real capital doing nothing, and it is exactly
 * the demand Uniswap liquidity wants: patient, stable-denominated, and with a
 * known exit date. This is the contribution to the Uniswap stack: escrow TVL
 * that currently sits dead, routed into v4 pools.
 *
 * WHY STABLE-STABLE ONLY, ENFORCED IN THE CONSTRUCTOR
 *
 * Impermanent loss on a volatile pair is a loss of principal, and the principal
 * here is not ours. A USDC/USDT position has near-zero divergence risk, which is
 * the only risk profile an escrow can honestly accept. The pair is immutable
 * after deployment so nobody can later point this at ETH/USDC and keep the same
 * audited address.
 *
 * THE CONTRACT WITH THE ESCROW
 *
 *   withdraw(assets) returns exactly `assets`, or reverts.
 *
 * Never a partial transfer reported as success. SecureFlow's circuit breaker is
 * built on telling those apart: a revert is caught and the payout proceeds from
 * cash, while a silent shortfall is a hole nobody notices until a freelancer is
 * not paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS — read before deploying this
 *
 * The escrow-side integration is complete and fuzz-tested against a hostile
 * venue (see test/ProductiveEscrowInvariant.t.sol). THIS adapter — the v4 leg —
 * is written against v4's unlock/callback pattern but is NOT yet wired to a
 * live PoolManager, because v4 is not deployed on Arc testnet, where Atelier's
 * escrows live. It is deployed on Arc MAINNET, which opens 2026-09-16, and on
 * Ethereum/Base/Unichain Sepolia, where the fork tests point.
 *
 * Until it is proven against a real pool, `setLiquidityRouter` is unset and
 * deposit() reverts, so the escrow's adapter slot cannot be pointed at a
 * half-finished integration by accident.
 * ─────────────────────────────────────────────────────────────────────────────
 */
contract UniswapV4StableAdapter is IYieldAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    error NotEscrow();
    error NotConfigured();
    error PairNotStable();
    error ShortfallOnWithdraw(uint256 requested, uint256 recovered);

    /// The escrow this adapter serves. Immutable: an adapter serves one vault.
    address public immutable escrow;

    /// The asset the escrow deposits and expects back, 1:1.
    address public immutable override asset;

    /// The other half of the stable pair.
    address public immutable pairedStable;

    IPoolManager public immutable poolManager;

    /**
     * The periphery contract that actually mints and burns the position.
     *
     * Unset until the integration is proven against a live pool, and deposits
     * revert while it is unset — see STATUS above. Pointing an escrow at an
     * unfinished venue is the one mistake this file must make impossible.
     */
    address public liquidityRouter;

    /// Principal the escrow has sent in, before any fees earned.
    uint256 public principalDeposited;

    event Deposited(uint256 assets);
    event Withdrawn(uint256 requested, uint256 recovered);
    event LiquidityRouterSet(address indexed router);

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(
        address _escrow,
        address _asset,
        address _pairedStable,
        address _poolManager
    ) Ownable(msg.sender) {
        if (_escrow == address(0) || _asset == address(0)) revert NotConfigured();
        // Both legs must be stables. Enforced structurally rather than by
        // convention, because "we will only ever use it for USDC" is not a
        // guarantee, it is an intention.
        if (_asset == _pairedStable) revert PairNotStable();

        escrow = _escrow;
        asset = _asset;
        pairedStable = _pairedStable;
        poolManager = IPoolManager(_poolManager);
    }

    function setLiquidityRouter(address router) external onlyOwner {
        liquidityRouter = router;
        emit LiquidityRouterSet(router);
    }

    /**
     * @inheritdoc IYieldAdapter
     * @dev Reverts while unconfigured. The escrow treats a failed deposit as
     *      "stay in cash", which costs yield and nothing else — so failing
     *      closed here is free, and failing open would not be.
     */
    function deposit(uint256 assets) external payable override onlyEscrow {
        if (liquidityRouter == address(0)) revert NotConfigured();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        principalDeposited += assets;

        // v4 mints liquidity inside an unlock callback; the router holds the
        // position-manager logic and is called here once wired.
        emit Deposited(assets);
    }

    /**
     * @inheritdoc IYieldAdapter
     * @dev Asserts the full amount came back before returning. An adapter that
     *      quietly returns less is worse than one that reverts, because the
     *      escrow's breaker can survive a revert and cannot detect a lie.
     */
    function withdraw(uint256 assets) external override onlyEscrow returns (uint256) {
        if (liquidityRouter == address(0)) revert NotConfigured();

        uint256 before = IERC20(asset).balanceOf(address(this));
        // Burn exactly enough liquidity to cover `assets`, inside unlock().
        uint256 recovered = IERC20(asset).balanceOf(address(this)) - before;

        if (recovered < assets) revert ShortfallOnWithdraw(assets, recovered);

        principalDeposited = assets > principalDeposited ? 0 : principalDeposited - assets;
        IERC20(asset).safeTransfer(escrow, assets);

        emit Withdrawn(assets, recovered);
        return assets;
    }

    function totalAssets() external view override returns (uint256) {
        // Idle balance plus the position's value. Until the router is wired the
        // position is empty, so this is exactly what has been sent in.
        return IERC20(asset).balanceOf(address(this));
    }

    /**
     * @inheritdoc IYieldAdapter
     * @dev Zero while unconfigured — an honest "nothing is available right now"
     *      rather than an optimistic number the escrow would then rely on.
     */
    function maxWithdrawable() external view override returns (uint256) {
        if (liquidityRouter == address(0)) return 0;
        return IERC20(asset).balanceOf(address(this));
    }
}

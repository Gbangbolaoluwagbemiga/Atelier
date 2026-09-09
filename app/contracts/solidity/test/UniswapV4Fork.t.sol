// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/yield/UniswapV4StableAdapter.sol";

/**
 * Fork tests for the v4 leg, run against a real PoolManager.
 *
 * Arc testnet has no Uniswap v4 — both canonical PoolManager addresses return
 * empty code there — so there is nothing to fork on the chain Atelier's escrows
 * actually live on. Base mainnet has the real deployment, so that is what these
 * point at: the goal is to exercise the adapter against a genuine PoolManager,
 * not a mock that agrees with us.
 *
 * WHAT THESE ASSERT TODAY
 *
 * The adapter is a scaffold with no liquidity logic (see its STATUS block). So
 * the property under test is not "yield accrues" — it is that money cannot get
 * INTO a venue that has no way to give it back. That is the failure that would
 * cost a freelancer their payment, and it is the one worth pinning while the
 * integration is unwritten.
 *
 * When the unlock/modifyLiquidity/settle path lands, the reverting tests below
 * turn into the real deposit/withdraw round-trip. They are written so that
 * finishing the integration makes them fail loudly rather than pass silently.
 *
 *   forge test --match-path test/UniswapV4Fork.t.sol --fork-url $BASE_RPC_URL
 *
 * Skipped automatically when no fork is configured, so `forge test` stays green
 * offline and in CI without network access.
 */
contract UniswapV4ForkTest is Test {
    /// Uniswap v4 PoolManager on Base mainnet.
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    address escrow = makeAddr("escrow");
    UniswapV4StableAdapter adapter;

    /// True only when the test was started against a fork that has v4 on it.
    function _onFork() internal view returns (bool) {
        return POOL_MANAGER.code.length > 0;
    }

    function setUp() public {
        if (!_onFork()) return;
        adapter = new UniswapV4StableAdapter(escrow, USDC, USDT, POOL_MANAGER);
    }

    /**
     * Proves the fork is real before anything is concluded from it. Without
     * this, every test below would "pass" against an empty chain by skipping,
     * and a broken --fork-url would look like a clean run.
     */
    function test_fork_poolManagerIsDeployed() public {
        if (!_onFork()) {
            emit log("SKIP: no fork configured - pass --fork-url to run these");
            return;
        }
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager has no code on this fork");
        assertGt(USDC.code.length, 0, "USDC has no code on this fork");
        assertGt(USDT.code.length, 0, "USDT has no code on this fork");
    }

    /// The constructor's stable-pair rule holds against real token addresses.
    function test_fork_rejectsAPairThatIsNotTwoDistinctTokens() public {
        if (!_onFork()) return;
        vm.expectRevert(UniswapV4StableAdapter.PairNotStable.selector);
        new UniswapV4StableAdapter(escrow, USDC, USDC, POOL_MANAGER);
    }

    /**
     * The one that matters. Assets must not be accepted while there is no code
     * that can return them — and not merely because an admin has left the
     * router unset, which an admin can undo.
     */
    function test_fork_depositIsRefusedEvenWithARouterSet() public {
        if (!_onFork()) return;

        adapter.setLiquidityRouter(makeAddr("router"));
        assertEq(adapter.liquidityRouter(), makeAddr("router"), "router did not take");

        vm.prank(escrow);
        vm.expectRevert(UniswapV4StableAdapter.IntegrationNotImplemented.selector);
        adapter.deposit(1_000e6);

        assertEq(adapter.principalDeposited(), 0, "principal moved on a refused deposit");
    }

    /// Only the escrow may drive the adapter, router or no router.
    function test_fork_depositRejectsAnyOtherCaller() public {
        if (!_onFork()) return;

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(UniswapV4StableAdapter.NotEscrow.selector);
        adapter.deposit(1_000e6);
    }

    /**
     * withdraw() must never report a partial recovery as success. With no
     * liquidity logic it can recover nothing, so it has to revert — the escrow
     * catches that and pays from cash, which is the safe outcome.
     */
    function test_fork_withdrawRevertsRatherThanUnderPaying() public {
        if (!_onFork()) return;

        adapter.setLiquidityRouter(makeAddr("router"));

        vm.prank(escrow);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4StableAdapter.ShortfallOnWithdraw.selector, uint256(500e6), uint256(0))
        );
        adapter.withdraw(500e6);
    }

    /// An unconfigured venue reports zero available, not an optimistic number.
    function test_fork_maxWithdrawableIsZeroWhileUnconfigured() public view {
        if (!_onFork()) return;
        assertEq(adapter.maxWithdrawable(), 0, "claimed liquidity it does not have");
    }

    /// The pair is fixed at construction so an audited address cannot be repointed.
    function test_fork_pairIsImmutable() public view {
        if (!_onFork()) return;
        assertEq(adapter.asset(), USDC);
        assertEq(adapter.pairedStable(), USDT);
        assertEq(address(adapter.poolManager()), POOL_MANAGER);
    }
}

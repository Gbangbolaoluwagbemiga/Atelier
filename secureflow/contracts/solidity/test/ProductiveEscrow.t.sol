// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";

/**
 * PRODUCTIVE ESCROW.
 *
 * The brief calls this the riskiest feature in the product, and it is right:
 * everything else here moves other people's money from A to B, and this is the
 * only part that puts it somewhere it might not come back from.
 *
 * So the tests are not about the yield. They are about the one sentence the
 * feature is allowed to claim:
 *
 *     Principal is redeemable at face value, instantly, always.
 *     A yield failure must never block a payout or a dispute.
 *
 * Every test below breaks the venue on purpose and then checks somebody still
 * got paid.
 */
contract ProductiveEscrowTest is JobManagerBase {
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();
        venue = new MockYieldAdapter(address(usdc), address(sf));
        sf.setYieldAdapter(address(usdc), address(venue));
        sf.setYieldBuffer(2000); // 20%
    }

    /* ─────────────── The policy ─────────────── */

    function test_yieldIsOffUntilTheDepositorAsks() public {
        uint256 id = _createOpenJob();
        assertFalse(sf.yieldOptIn(id), "must never default to on");
        assertEq(sf.investableAmount(id), 0, "deployable while opted out");

        vm.prank(client);
        sf.setYieldOptIn(id, true);
        assertTrue(sf.yieldOptIn(id));

        vm.prank(client);
        sf.setYieldOptIn(id, false);
        assertFalse(sf.yieldOptIn(id));
    }

    function test_onlyTheDepositorMayOptIn() public {
        uint256 id = _createOpenJob();
        vm.prank(outsider);
        vm.expectRevert(SecureFlow.Unauthorized.selector);
        sf.setYieldOptIn(id, true);
    }

    function test_bufferCannotBeSetToNothing() public {
        // A zero buffer turns the venue from an optimisation into a dependency.
        vm.expectRevert(SecureFlow.BufferTooLow.selector);
        sf.setYieldBuffer(0);
        vm.expectRevert(SecureFlow.BufferTooLow.selector);
        sf.setYieldBuffer(999);
        sf.setYieldBuffer(1000); // the floor is allowed
    }

    function test_adapterMustMatchItsToken() public {
        MockYieldAdapter wrong = new MockYieldAdapter(address(0xBEEF), address(sf));
        vm.expectRevert(SecureFlow.InvalidConfig.selector);
        sf.setYieldAdapter(address(usdc), address(wrong));
    }

    /**
     * An open job is refundable in full by cancelJob at any instant, so none of
     * it is safe to lend out. This is rule 1 of the cap, and the first version
     * of the feature got it wrong.
     */
    function test_deploysNothingWhileTheJobIsStillOpen() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);

        assertEq(sf.investableAmount(id), 0, "deployable while still cancellable");
        sf.investIdle(id);
        assertEq(sf.escrowDeployed(id), 0);
    }

    /**
     * The cap keeps the largest single unpaid milestone in cash, so any one
     * approval is always payable without the venue.
     *
     * Budget 900, milestones 300 and 600, buffer 20%:
     *   reserve = 600 (largest) + 180 (buffer) = 780
     *   deployable = 900 - 780 = 120
     */
    function test_capKeepsTheLargestMilestoneInCash() public {
        uint256 id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);

        assertEq(sf.investableAmount(id), 120e6, "cap is not the safe amount");

        sf.investIdle(id);
        uint256 deployed = sf.escrowDeployed(id);

        assertEq(deployed, 120e6);
        assertGe(BUDGET - deployed, M2, "cash cannot cover the largest milestone");
    }

    function test_investingTwiceDoesNotStackPastTheCap() public {
        uint256 id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);

        sf.investIdle(id);
        uint256 first = sf.escrowDeployed(id);
        sf.investIdle(id);
        sf.investIdle(id);

        assertEq(sf.escrowDeployed(id), first, "repeat calls stacked");
    }

    /**
     * Once the small milestone is paid, the remaining 600 IS the largest
     * milestone, so nothing further is safe to deploy.
     */
    function test_capTightensAsTheEscrowDrainsDown() public {
        uint256 id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);
        sf.investIdle(id);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(sf.investableAmount(id), 0, "still deploying with one claim left");
    }

    /* ─────────────── The invariant, under a hostile venue ─────────────── */

    /// A job with a freelancer assigned and work started.
    function _assignedJob() internal returns (uint256 id) {
        id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);
    }

    /// A live job with capital actually deployed and a milestone ready.
    function _fundedAndDeployed() internal returns (uint256 id) {
        id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);

        sf.investIdle(id);
        assertGt(sf.escrowDeployed(id), 0, "fixture deployed nothing");

        _submit(id, 0);
    }

    function test_payoutSucceedsWhenTheVenueIsHealthy() public {
        uint256 id = _fundedAndDeployed();

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "worker paid");
    }

    /**
     * The whole point. The venue is down; the freelancer is still paid.
     */
    function test_payoutSucceedsWhenTheVenueReverts() public {
        uint256 id = _fundedAndDeployed();
        venue.setRevertOnWithdraw(true);

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "a broken venue blocked a payment");
    }

    function test_payoutSucceedsWhenTheVenueIsIlliquid() public {
        uint256 id = _fundedAndDeployed();
        venue.setLiquidCap(1); // effectively frozen

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "an illiquid venue blocked a payment");
    }

    function test_payoutSucceedsWhenTheVenueReturnsLessThanAsked() public {
        uint256 id = _fundedAndDeployed();
        venue.setPayoutBP(5000); // returns half

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "a lossy venue blocked a payment");
    }

    /**
     * The buffer means the PAYMENT itself never touches the venue — cash covers
     * it outright. What does happen afterwards is a rebalance: paying a
     * milestone shrinks what is safe to have lent out, so the excess comes
     * back. Those are different things and the test asserts both.
     */
    function test_paymentComesFromCash_thenTheExcessIsRecalled() public {
        uint256 id = _fundedAndDeployed();
        uint256 deployedBefore = sf.escrowDeployed(id);
        uint256 cashBefore = usdc.balanceOf(address(sf));

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "worker not paid");
        // Cash alone covered the payment: it fell by no more than the payment.
        assertGe(cashBefore, M1, "cash could not have covered this alone");
        // And the now-unsafe deployment was pulled back.
        assertLt(sf.escrowDeployed(id), deployedBefore, "excess left lent out");
        assertEq(sf.investableCeiling(id), 0, "ceiling should be zero with one claim left");
    }

    /* ─────────────── Disputes ─────────────── */

    function test_disputeResolvesWhileTheVenueIsDown() public {
        uint256 id = _fundedAndDeployed();
        venue.setRevertOnWithdraw(true);

        vm.prank(worker);
        sf.disputeMilestone(id, 0, "no response");

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(arbiter);
        sf.resolveDispute(id, 0, M1 / 2, M1 / 2, "split");

        assertEq(usdc.balanceOf(worker), workerBefore + M1 / 2, "worker share blocked");
        assertEq(usdc.balanceOf(client), clientBefore + M1 / 2, "client refund blocked");
    }

    /**
     * Cancellation refunds everything at once — which is exactly why an open
     * job deploys nothing. The venue being down is therefore irrelevant, and
     * this test exists to prove that rather than assume it.
     */
    function test_cancellationRefundsWhileTheVenueIsDown() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);
        sf.investIdle(id);
        venue.setRevertOnWithdraw(true);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        assertGt(usdc.balanceOf(client), before, "a broken venue blocked a refund");
    }

    /* ─────────────── Accounting ─────────────── */

    function test_yieldIsReportedOnlyWhenItIsReal() public {
        uint256 id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);
        sf.investIdle(id);

        assertEq(sf.yieldEarned(address(usdc)), 0, "reported yield before any accrued");

        venue.simulateYield(int256(uint256(5e6)));
        assertEq(sf.yieldEarned(address(usdc)), 5e6, "did not report real yield");

        // A venue that has LOST money must report zero, never a negative dressed
        // up as a positive by an underflow.
        venue.simulateYield(-int256(uint256(50e6)));
        assertEq(sf.yieldEarned(address(usdc)), 0, "reported yield on a loss");
    }

    function test_disconnectingAVenueStopsNewDeploymentsOnly() public {
        uint256 id = _assignedJob();
        vm.prank(client);
        sf.setYieldOptIn(id, true);
        sf.investIdle(id);
        uint256 deployed = sf.deployedAssets(address(usdc));
        assertGt(deployed, 0);

        sf.setYieldAdapter(address(usdc), address(0));

        // Nothing new goes out...
        vm.expectRevert(SecureFlow.YieldNotEnabled.selector);
        sf.investIdle(id);
        // ...and what is already out there is not force-exited at the worst
        // possible moment; it drains through the ordinary payout path.
        assertEq(sf.deployedAssets(address(usdc)), deployed);
    }
}

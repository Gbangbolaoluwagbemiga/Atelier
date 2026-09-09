// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * A dispute settles one milestone. It does not settle the job.
 *
 * That gap trapped money. After arbitration the escrow returned to InProgress
 * with every remaining milestone still funded and no way to reach it: cancelJob
 * and withdrawJobFunds both refused a job with a freelancer on it, and
 * disputeMilestone refuses a milestone nobody has submitted. A client whose
 * working relationship had just been to an arbiter could do nothing but wait
 * out the deadline plus the emergency delay.
 *
 * The rule these tests pin: once a dispute has been settled, the client may
 * take back milestones NOBODY HAS STARTED, and nothing else.
 */
contract PostDisputeExitTest is JobManagerBase {
    /// Job funded, worker hired and started, milestone 0 submitted and disputed.
    function _disputedJob() internal returns (uint256 escrowId) {
        escrowId = _createOpenJob();
        _apply(escrowId, worker);

        vm.prank(client);
        sf.acceptFreelancer(escrowId, worker);

        vm.prank(worker);
        sf.startWork(escrowId);

        _submit(escrowId, 0);

        vm.prank(worker);
        sf.disputeMilestone(escrowId, 0, "It meets every criterion listed");
    }

    /// Split milestone 0 down the middle and let the escrow return to InProgress.
    function _resolve(uint256 escrowId) internal {
        vm.prank(arbiter);
        sf.resolveDispute(escrowId, 0, M1 / 2, M1 - M1 / 2, "Half each");
    }

    /* ─────────── the bug ─────────── */

    function test_clientCanTakeBackAnUnstartedMilestoneAfterArbitration() public {
        uint256 id = _disputedJob();
        _resolve(id);

        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        // The budget comes back, and so does the platform fee charged on it.
        uint256 refunded = usdc.balanceOf(client) - before;
        assertGe(refunded, M2, "client did not get the unstarted milestone back");

        assertEq(sf.getMilestones(id)[1].amount, 0, "milestone still carries a budget");
    }

    /// The escrow closes once nothing is left owing.
    function test_theJobEndsWhenNothingIsLeftToPay() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(esc.totalAmount, esc.paidAmount, "escrow still owes something");
    }

    /* ─────────── and the limits on it ─────────── */

    /**
     * The check that makes this fair rather than a way to renege.
     *
     * A submitted milestone is work that has arrived. It goes through review or
     * arbitration like anything else — it is not the client's to withdraw.
     */
    function test_cannotTakeBackWorkTheFreelancerHasAlreadySubmitted() public {
        uint256 id = _disputedJob();
        _resolve(id);

        _submit(id, 1); // the freelancer delivers the second milestone

        vm.prank(client);
        vm.expectRevert(Atelier.MilestoneAlreadyProcessed.selector);
        sf.withdrawJobFunds(id, M2, 1);
    }

    /// No arbitration, no exit. This is not a way to walk away mid-job.
    function test_cannotTakeBackFundsFromAJobThatWasNeverDisputed() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);

        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(Atelier.CannotCancelAssignedJob.selector);
        sf.withdrawJobFunds(id, M2, 1);
    }

    /// Only the client. Not the freelancer, not the agent, not a passer-by.
    function test_onlyTheClientMayTakeItBack() public {
        uint256 id = _disputedJob();
        _resolve(id);

        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? worker : i == 1 ? manager : outsider;
            vm.prank(who);
            vm.expectRevert(Atelier.Unauthorized.selector);
            sf.withdrawJobFunds(id, M2, 1);
        }
    }

    /// The pre-hire path this shares code with must still behave.
    function test_openJobFundManagementStillWorks() public {
        uint256 id = _createOpenJob();

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        assertGe(usdc.balanceOf(client) - before, M2, "pre-hire withdrawal broke");
    }
}

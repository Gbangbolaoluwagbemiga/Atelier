// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAtelierYield.sol";
import "./IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/** The slice of Atelier this controller needs to reason about safety. */
interface IAtelierEscrows {
    enum EscrowStatus { Pending, InProgress, Released, Refunded, Disputed, Expired, Cancelled }
    enum MilestoneStatus { NotStarted, Submitted, Approved, Rejected, Disputed, ProposalPending }

    struct Milestone {
        uint256 amount;
        string description;
        string requirements;
        MilestoneStatus status;
        uint256 submittedAt;
        uint256 approvedAt;
        uint256 disputedAt;
        address disputedBy;
        string disputeReason;
        string rejectionReason;
        uint256 resolvedAt;
        address resolvedBy;
        uint256 proposedAmount;
        string proposedDescription;
        uint256 resolutionFreelancerAmount;
        uint256 resolutionClientAmount;
        string resolutionReason;
    }

    struct Escrow {
        address depositor;
        address beneficiary;
        address token;
        uint256 totalAmount;
        uint256 paidAmount;
        uint256 deadline;
        EscrowStatus status;
        bool workStarted;
        uint256 platformFee;
        address[] arbiters;
        uint256 requiredConfirmations;
        bool isOpenJob;
        string projectTitle;
        string projectDescription;
    }

    function getEscrow(uint256 escrowId) external view returns (Escrow memory);
    function getMilestones(uint256 escrowId) external view returns (Milestone[] memory);
}

/**
 * @title AtelierYield
 * @notice Productive escrow: idle capital earns, and never at the cost of a payout.
 *
 * WHY THIS IS A SEPARATE CONTRACT
 *
 * It used to live inside Atelier. That pushed the escrow to 26.2KB against
 * EIP-170's 24,576-byte limit, which meant the feature could not be deployed at
 * all — and trimming a working escrow to make room would have made the contract
 * smaller and worse. Two attempts at shaving bytes are recorded in Atelier.sol
 * so nobody repeats them: dropping optimizer_runs saved 292 bytes, and moving
 * the cancellation-penalty maths to a library made it BIGGER.
 *
 * Splitting it is the right answer anyway, not just the one that fits. The
 * escrow's job is holding money safely; deciding where idle capital earns is a
 * different job with a different risk profile, and it can now be replaced,
 * paused or disconnected without touching the contract that custodies funds.
 *
 * THE INVARIANT, unchanged by the move:
 *
 *     Cash plus deployed capital never falls below what is owed.
 *
 * A failing venue can DELAY a payout. It cannot lose the money, and it cannot
 * leave the escrow owing more than it holds a claim on.
 */
contract AtelierYield is IAtelierYield, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotEscrow();
    error BufferTooLow();
    error InvalidConfig();
    error Unauthorized();

    address public immutable escrow;

    mapping(address => IYieldAdapter) public yieldAdapter;
    /** Fraction of an escrow's remainder never deployed, in basis points. */
    uint256 public yieldBufferBP = 2000;
    mapping(uint256 => bool) public yieldOptIn;
    mapping(address => uint256) public deployedAssets;
    mapping(uint256 => uint256) public escrowDeployed;

    event YieldAdapterSet(address indexed token, address indexed adapter);
    event YieldOptInChanged(uint256 indexed escrowId, bool optedIn);
    event YieldDeployed(address indexed token, uint256 amount);
    event YieldUnwound(address indexed token, uint256 requested, uint256 recovered);
    /** The venue could not return funds on demand. Surfaced, never swallowed. */
    event YieldCircuitBreakerTripped(address indexed token, uint256 shortfall);

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(address _escrow) Ownable(msg.sender) {
        if (_escrow == address(0)) revert InvalidConfig();
        escrow = _escrow;
    }

    /* ─────────────── Policy ─────────────── */

    function setYieldAdapter(address token, address adapter) external onlyOwner {
        if (adapter != address(0) && IYieldAdapter(adapter).asset() != token) revert InvalidConfig();
        yieldAdapter[token] = IYieldAdapter(adapter);
        emit YieldAdapterSet(token, adapter);
    }

    /**
     * @dev Floored at 10%. A zero buffer means every payout has to unwind, which
     *      turns the venue from an optimisation into a dependency — precisely
     *      what the circuit breaker exists to avoid.
     */
    function setYieldBuffer(uint256 bp) external onlyOwner {
        if (bp < 1000 || bp > 10000) revert BufferTooLow();
        yieldBufferBP = bp;
    }

    /** @dev The depositor's call and only theirs: it is their capital at risk. */
    function setYieldOptIn(uint256 escrowId, bool optedIn) external {
        if (msg.sender != IAtelierEscrows(escrow).getEscrow(escrowId).depositor) revert Unauthorized();
        yieldOptIn[escrowId] = optedIn;
        emit YieldOptInChanged(escrowId, optedIn);
    }

    /* ─────────────── The cap ─────────────── */

    /**
     * @notice The most this escrow may safely have lent out, right now.
     *
     * Derived from the largest claim that could arrive next, not from a
     * percentage. The first version deployed "everything except a 20% buffer"
     * and a fuzzer broke it in a few thousand calls: milestones are not 20% of
     * an escrow, so a 20% buffer cannot pay a 50% milestone when the venue is
     * down.
     *
     *   1. An OPEN job is refundable in full by cancelJob at any instant, so
     *      none of it is safe to lend.
     *   2. Once a freelancer is assigned, claims arrive one milestone at a
     *      time — so the largest unpaid milestone stays in cash.
     *   3. The percentage buffer applies on top of that, not instead of it.
     */
    function investableCeiling(uint256 escrowId) public view returns (uint256) {
        IAtelierEscrows.Escrow memory esc = IAtelierEscrows(escrow).getEscrow(escrowId);
        if (esc.depositor == address(0)) return 0;
        if (esc.isOpenJob || esc.beneficiary == address(0)) return 0;
        if (
            esc.status != IAtelierEscrows.EscrowStatus.Pending &&
            esc.status != IAtelierEscrows.EscrowStatus.InProgress
        ) return 0;

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining == 0) return 0;

        uint256 largestClaim;
        IAtelierEscrows.Milestone[] memory ms = IAtelierEscrows(escrow).getMilestones(escrowId);
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == IAtelierEscrows.MilestoneStatus.Approved) continue;
            if (ms[i].amount > largestClaim) largestClaim = ms[i].amount;
        }

        uint256 reserve = largestClaim + (remaining * yieldBufferBP) / 10000;
        return remaining <= reserve ? 0 : remaining - reserve;
    }

    /** @notice Headroom: the ceiling minus what is already out there. */
    function investableAmount(uint256 escrowId) public view returns (uint256) {
        if (!yieldOptIn[escrowId]) return 0;

        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        if (address(yieldAdapter[token]) == address(0)) return 0;

        uint256 ceiling = investableCeiling(escrowId);
        uint256 already = escrowDeployed[escrowId];
        if (already >= ceiling) return 0;

        uint256 room = ceiling - already;
        uint256 cash = _cash(token, escrow);
        return room > cash ? cash : room;
    }

    /**
     * @notice Put one escrow's genuinely idle capital to work.
     * @dev Permissionless: it moves money only from the escrow into the venue
     *      its owner chose, never out to a caller — so there is nothing to gain
     *      by calling it and something to lose by nobody ever doing so.
     */
    function investIdle(uint256 escrowId) external nonReentrant {
        uint256 amount = investableAmount(escrowId);
        if (amount == 0) return;

        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        IYieldAdapter adapter = yieldAdapter[token];

        escrowDeployed[escrowId] += amount;
        deployedAssets[token] += amount;

        // Pull from the escrow, then forward to the venue.
        IAtelierPull(escrow).releaseToYield(token, amount);

        if (token == address(0)) {
            adapter.deposit{value: amount}(amount);
        } else {
            IERC20(token).forceApprove(address(adapter), amount);
            adapter.deposit(amount);
        }
        emit YieldDeployed(token, amount);
    }

    /* ─────────────── The escrow's two hooks ─────────────── */

    /**
     * @inheritdoc IAtelierYield
     * @dev Every failure path is swallowed on purpose. This runs immediately
     *      before a freelancer is paid, and a venue that reverts, pauses or has
     *      gone illiquid must cost us the yield and NOT the payment.
     */
    function ensureLiquid(address token, uint256 amount)
        external
        onlyEscrow
        returns (uint256 delivered)
    {
        IYieldAdapter adapter = yieldAdapter[token];
        uint256 deployed = deployedAssets[token];
        if (address(adapter) == address(0) || deployed == 0) {
            emit YieldCircuitBreakerTripped(token, amount);
            return 0;
        }

        uint256 ask = amount > deployed ? deployed : amount;
        try adapter.withdraw(ask) returns (uint256 recovered) {
            uint256 booked = recovered > deployed ? deployed : recovered;
            deployedAssets[token] = deployed - booked;
            _send(token, escrow, booked);
            emit YieldUnwound(token, ask, recovered);
            if (recovered < ask) emit YieldCircuitBreakerTripped(token, ask - recovered);
            return booked;
        } catch {
            emit YieldCircuitBreakerTripped(token, amount);
            return 0;
        }
    }

    /**
     * @inheritdoc IAtelierYield
     * @dev A cap computed at deploy time goes stale: pay the small milestone and
     *      the remainder shrinks while the largest outstanding claim does not.
     *      A fuzzer found that too. Pull the excess back, and swallow failures —
     *      this runs after a payment has already gone out.
     */
    function onObligationChanged(uint256 escrowId) external onlyEscrow {
        uint256 deployed = escrowDeployed[escrowId];
        if (deployed == 0) return;

        uint256 safe = investableCeiling(escrowId);
        if (deployed <= safe) return;

        uint256 excess = deployed - safe;
        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return;

        try adapter.withdraw(excess) returns (uint256 recovered) {
            uint256 booked = recovered > deployed ? deployed : recovered;
            escrowDeployed[escrowId] = deployed - booked;
            deployedAssets[token] -= booked;
            _send(token, escrow, booked);
            emit YieldUnwound(token, excess, recovered);
            if (recovered < excess) emit YieldCircuitBreakerTripped(token, excess - recovered);
        } catch {
            emit YieldCircuitBreakerTripped(token, excess);
        }
    }

    /** @notice Yield earned above principal. Zero if the venue has lost money. */
    function yieldEarned(address token) external view returns (uint256) {
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return 0;
        uint256 held = adapter.totalAssets();
        uint256 principal = deployedAssets[token];
        return held > principal ? held - principal : 0;
    }

    /* ─────────────── internals ─────────────── */

    function _cash(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "native send failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    receive() external payable {}
}

/** The one call the controller makes back into the escrow. */
interface IAtelierPull {
    function releaseToYield(address token, uint256 amount) external;
}

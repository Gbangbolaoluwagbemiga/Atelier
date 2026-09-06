// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./yield/IYieldAdapter.sol";

/**
 * @title SecureFlow
 * @dev Milestone-based escrow with on-chain ratings, deadline extension,
 *      and enumerable arbiter list — deployed on Arc EVM.
 *
 * Fee model:
 *   Client deposits totalAmount + platformFee upfront.
 *   Fee is separated immediately at creation.
 *   Milestones sum to totalAmount so the release check is exact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPGRADEABILITY (UUPS) — read this before deploying or upgrading
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This contract sits behind an ERC1967 proxy so that new features can ship
 * without migrating live escrows. Deploy the implementation, deploy the proxy
 * pointing at it, and call `initialize` through the proxy. Never call
 * `initialize` on the implementation itself — the constructor disables it.
 *
 * WHAT THAT COSTS, STATED PLAINLY. SecureFlow's promise is that neither party
 * can unilaterally move money once an escrow is live. Upgradeability puts one
 * asterisk on it: the owner can replace the implementation, and a malicious
 * replacement could do anything to funds already locked. That is true of every
 * upgradeable escrow, it is not hidden here, and it is the reason
 * `_authorizeUpgrade` is owner-only and `Ownable2Step` is used — a fat-fingered
 * ownership transfer cannot silently hand over the upgrade key.
 *
 * The honest framing for a client: the CONTRACT cannot take your money, and the
 * OWNER can change the contract. Do not describe this deployment as trustless
 * without that second clause.
 *
 * RULES FOR FUTURE UPGRADES — storage layout is append-only:
 *   1. Never reorder, retype, or delete an existing state variable.
 *   2. Add new variables ONLY at the end, immediately before `__gap`, and
 *      reduce `__gap`'s length by the number of slots you added.
 *   3. Adding a field to a struct held in a MAPPING is safe (values live at
 *      hashed offsets). Adding one to a struct held in an ARRAY is NOT.
 *   4. Bump `version()` in the same commit as any storage change, so a
 *      deployed proxy can be identified from chain state alone.
 *   5. Run the upgrade tests in test/SecureFlowUpgrade.t.sol before shipping.
 */
contract SecureFlow is
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /* ===================== ERRORS ===================== */
    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error EscrowNotFound();
    error InvalidEscrowStatus();
    error WorkAlreadyStarted();
    error EscrowNotActive();
    error DeadlineNotPassed();
    error InvalidMilestone();
    error MilestoneAlreadyProcessed();
    error MilestoneNotSubmitted();
    error EmergencyPeriodNotReached();
    error NothingToRefund();
    error CannotRefund();
    error TokenNotWhitelisted();
    error MilestoneSumMismatch();
    error InvalidConfig();
    error AlreadyApplied();
    error NotAnOpenJob();
    error FreelancerNotApplied();
    error AlreadyRated();
    error InvalidRating();
    error EscrowNotReleased();
    error NotParticipant();
    error ExtensionTooShort();
    error JobAlreadyAssigned();
    error CannotCancelAssignedJob();
    error NoPendingProposal();
    error ProposalAlreadyExists();
    error ManagerCannotBeBeneficiary();
    error ManagerCannotSelfHire();
    error NoManagerSet();
    error YieldNotEnabled();
    error BufferTooLow();

    /* ===================== ENUMS & STRUCTS ===================== */
    enum EscrowStatus { Pending, InProgress, Released, Refunded, Disputed, Expired, Cancelled }
    enum MilestoneStatus { NotStarted, Submitted, Approved, Rejected, Disputed, ProposalPending }

    struct Milestone {
        uint256 amount;
        string description;       // freelancer's submission text (overwritten on submit)
        string requirements;      // original client requirements — set once at creation, never overwritten
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
        uint256 resolutionFreelancerAmount; // Amount awarded to freelancer in dispute resolution
        uint256 resolutionClientAmount;     // Amount refunded to client in dispute resolution
        string resolutionReason;            // Admin's reason for resolution decision
    }

    struct Escrow {
        address depositor;
        address beneficiary;
        address token;          // address(0) = native ETH
        uint256 totalAmount;    // net of platform fee; milestones sum to this
        uint256 paidAmount;
        uint256 deadline;
        EscrowStatus status;
        bool workStarted;
        uint256 platformFee;    // already separated at creation
        address[] arbiters;
        uint256 requiredConfirmations;
        bool isOpenJob;
        string projectTitle;
        string projectDescription;
    }

    struct Rating {
        address rater;
        address rated;
        uint8 score;        // 1-5
        string review;
        uint256 ratedAt;
    }

    /* ===================== STATE VARIABLES ===================== */
    address public feeCollector;
    uint256 public platformFeeBP;
    uint256 public constant MAX_PLATFORM_FEE_BP = 1000; // 10 %
    uint256 public constant EMERGENCY_REFUND_DELAY = 30 days;
    uint256 public constant MIN_EXTENSION_DAYS = 1;
    address public constant NATIVE_TOKEN = address(0);

    /**
     * @dev Set in `initialize`, NOT here. A declaration-site initialiser runs in
     *      the implementation's constructor, which a proxy never executes — so
     *      this would have silently started at 0 behind the proxy and made
     *      escrow id 0 both "the first escrow" and "does not exist".
     */
    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;
    mapping(uint256 => Milestone[]) private escrowMilestones;

    // Multi-sig dispute tracking
    mapping(uint256 => mapping(address => bool)) public disputeVotes;
    mapping(uint256 => uint256) public disputeVoteCounts;

    // Platform state
    mapping(address => bool) public authorizedArbiters;
    address[] private _arbiterList;                // enumerable
    mapping(address => bool) public whitelistedTokens;
    mapping(address => uint256) public escrowedAmount;
    mapping(address => uint256) public totalFeesByToken;
    mapping(address => uint256) public completedEscrows;
    mapping(address => uint256) public reputation;

    // Ratings: escrowId → rater → Rating
    mapping(uint256 => mapping(address => Rating)) private _ratings;
    // All ratings received by an address
    mapping(address => Rating[]) private _receivedRatings;

    // User escrow tracking
    mapping(address => uint256[]) private userEscrows;
    mapping(uint256 => mapping(address => bool)) public hasApplied;
    mapping(uint256 => address[]) private escrowApplications;

    // Anti-abuse: Cancellation tracking
    mapping(address => uint256) public userCancellations;
    mapping(address => uint256) public lastCancellationTime;

    /**
     * Autopilot: a per-escrow manager who may do the LABOUR of managing a job —
     * hiring, approving, rejecting — on behalf of the depositor, and nothing
     * else.
     *
     * This exists so that a client can delegate the work of running a job to an
     * agent WITHOUT handing over the money. Before it, the only way an agent
     * could manage a job was to be the depositor itself, which made the client
     * a custodial creditor with no on-chain standing: no approval rights, and —
     * worse — no ability to dispute, since disputeMilestone admits only the
     * depositor and the beneficiary.
     *
     * THE ONE-WAY KEY, the invariant this whole feature rests on:
     *
     *     No action available to a manager can cause value to reach the manager.
     *
     * It holds structurally rather than by inspection: the only value-moving
     * call a manager has is approveMilestone, and that pays esc.beneficiary and
     * nothing else. So the guard that keeps it true is simply that a manager can
     * never BE the beneficiary — enforced at both ends, in setJobManager and in
     * acceptFreelancer, because the beneficiary of an open job is assigned after
     * the manager is appointed.
     *
     * What this does NOT prevent: a manager hiring a confederate. No contract
     * can tell an arm's-length hire from a collusive one. That risk is bounded
     * off-chain instead — the depositor keeps dispute rights, can revoke the
     * manager at any moment, and funds only one job at a time. Do not let the
     * permission table imply otherwise.
     */
    mapping(uint256 => address) public jobManager;

    /* ===================== PRODUCTIVE ESCROW ===================== */

    /**
     * Escrowed capital sits idle between a job being funded and a milestone
     * being approved — often for weeks. This layer lets that capital earn,
     * without ever putting it at risk of not being there when it is needed.
     *
     * THE INVARIANT, and it outranks the yield entirely:
     *
     *     Cash plus deployed capital never falls below what is owed.
     *
     * Stated in plain terms: a failing venue can DELAY a payout. It cannot lose
     * the money, and it cannot leave this contract owing more than it holds a
     * claim on.
     *
     * That wording is deliberate and was arrived at the hard way. The first
     * version of this claimed principal was "redeemable at face value,
     * instantly, always". A fuzzer running a hostile venue broke it in a few
     * thousand calls — cash at 502.5 against a claim of 600 — and no amount of
     * circuit breaking fixes that, because a breaker can stop you DEPENDING on
     * a venue, it cannot conjure money you have already lent out. The stronger
     * sentence was not true, so it is not the one written here.
     *
     * How that is held:
     *   - Opt-in per escrow, by the depositor. Never the default.
     *   - A liquidity buffer that is never deployed, so ordinary payouts are
     *     served from cash without touching the venue at all.
     *   - Every payout routes through _doTransfer, which tops up from the venue
     *     first — and does so inside a try/catch, so a venue that reverts costs
     *     us the yield and not the payment.
     *   - Stable-stable venues only. Impermanent loss on a volatile pair is a
     *     loss of principal, and principal is not ours to gamble.
     *
     * THE RESIDUAL RISK, named rather than buried. If the venue is unreachable
     * at the moment a large claim arrives, and cash does not cover it, that
     * payout reverts until the venue responds. The money is not lost — it is
     * still on the books and reclaimed by the next payout that succeeds — but
     * the freelancer waits. The cap exists to make that window small: the
     * largest single unpaid milestone is always held back in cash, so only an
     * unusual sequence can reach it.
     *
     * It is also why this is opt-in and off by default, per the build brief's
     * own instruction: ship it capped rather than unbounded when the strongest
     * invariant cannot be written.
     */
    mapping(address => IYieldAdapter) public yieldAdapter;

    /// Fraction of a token's escrowed balance never deployed, in basis points.
    uint256 public yieldBufferBP;

    /// Per-escrow opt-in. The depositor's decision, and reversible.
    mapping(uint256 => bool) public yieldOptIn;

    /// What this contract believes is sitting in the venue, per token.
    mapping(address => uint256) public deployedAssets;

    /// Per escrow, so the safe-to-deploy cap can be computed for one job.
    mapping(uint256 => uint256) public escrowDeployed;

    /* ===================== EVENTS ===================== */
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed depositor,
        address indexed beneficiary,
        address[] arbiters,
        uint256 requiredConfirmations,
        uint256 totalAmount,
        uint256 platformFee,
        address token,
        uint256 deadline,
        bool isOpenJob
    );
    event EscrowUpdated(uint256 indexed escrowId, EscrowStatus status, uint256 timestamp);
    event WorkStarted(uint256 indexed escrowId, address indexed beneficiary, uint256 timestamp);
    event DeadlineExtended(uint256 indexed escrowId, uint256 oldDeadline, uint256 newDeadline);
    event MilestoneSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed beneficiary, string description, uint256 timestamp);
    event MilestoneApproved(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed beneficiary, uint256 amount, uint256 timestamp);
    event MilestoneRejected(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed depositor, string reason, uint256 timestamp);
    event MilestoneDisputed(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed disputer, string reason, uint256 timestamp);
    event DisputeVoteCast(uint256 indexed escrowId, address indexed arbiter, uint256 voteCount);
    event DisputeResolved(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed arbiter, uint256 freelancerAmount, uint256 clientAmount, uint256 timestamp);
    event FundsRefunded(uint256 indexed escrowId, address indexed depositor, uint256 amount);
    event EmergencyRefundExecuted(uint256 indexed escrowId, address indexed depositor, uint256 amount);
    event EvidenceSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed submitter, string cid);
    event ApplicationSubmitted(uint256 indexed escrowId, address indexed freelancer, string coverLetter, uint256 proposedTimeline);
    event FreelancerAccepted(uint256 indexed escrowId, address indexed freelancer);
    event OverdueDisputeRaised(uint256 indexed escrowId, address indexed requester, string reason, uint256 timestamp);
    event RatingSubmitted(uint256 indexed escrowId, address indexed rater, address indexed rated, uint8 score);
    event ArbiterAuthorized(address indexed arbiter);
    event ArbiterRevoked(address indexed arbiter);
    event TokenWhitelisted(address indexed token);
    event TokenBlacklisted(address indexed token);
    event PlatformFeeUpdated(uint256 feeBp);
    event FeeCollectorUpdated(address indexed feeCollector);
    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event EscrowDeleted(uint256 indexed escrowId, address indexed deletedBy);
    event JobCancelled(uint256 indexed escrowId, address indexed depositor, uint256 refundAmount);
    event JobFundsUpdated(uint256 indexed escrowId, uint256 oldAmount, uint256 newAmount, bool isIncrease);
    event MilestoneProposalSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed freelancer, uint256 proposedAmount, string proposedDescription);
    event MilestoneProposalApproved(uint256 indexed escrowId, uint256 indexed milestoneIndex, uint256 newAmount, string newDescription);
    event MilestoneProposalRejected(uint256 indexed escrowId, uint256 indexed milestoneIndex);
    event JobManagerSet(uint256 indexed escrowId, address indexed manager);
    event JobManagerRevoked(uint256 indexed escrowId, address indexed manager);
    event YieldAdapterSet(address indexed token, address indexed adapter);
    event YieldOptInChanged(uint256 indexed escrowId, bool optedIn);
    event YieldDeployed(address indexed token, uint256 amount);
    event YieldUnwound(address indexed token, uint256 requested, uint256 recovered);
    /// The circuit breaker tripped: the venue could not return funds on demand.
    event YieldCircuitBreakerTripped(address indexed token, uint256 shortfall);

    /* ===================== MODIFIERS ===================== */
    modifier onlyArbiter() {
        _onlyArbiter();
        _;
    }
    function _onlyArbiter() internal view {
        if (!authorizedArbiters[msg.sender]) revert Unauthorized();
    }

    /**
     * @dev Callable by the depositor, or by a manager the depositor appointed.
     *
     * Guarded against the address(0) case: an unset jobManager is address(0),
     * and msg.sender is never address(0) in a real transaction, but relying on
     * that keeps a footgun one refactor away from being live.
     */
    function _onlyDepositorOrManager(Escrow storage esc, uint256 escrowId) internal view {
        if (msg.sender == esc.depositor) return;
        address mgr = jobManager[escrowId];
        if (mgr != address(0) && msg.sender == mgr) return;
        revert Unauthorized();
    }

    /* ===================== INITIALISATION ===================== */

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Locks the implementation so nobody can initialise it directly and
        // take ownership of a contract the proxy is delegating into.
        _disableInitializers();
    }

    /**
     * @notice Initialise the proxy. Replaces the constructor.
     * @dev Call this through the proxy, once, immediately after deployment.
     */
    function initialize(address _feeCollector, uint256 _platformFeeBP) external initializer {
        if (_feeCollector == address(0)) revert InvalidAddress();
        if (_platformFeeBP > MAX_PLATFORM_FEE_BP) revert InvalidConfig();

        __Ownable_init(msg.sender);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        feeCollector = _feeCollector;
        platformFeeBP = _platformFeeBP;
        nextEscrowId = 1;
    }

    /**
     * @notice Identifies the deployed implementation from chain state alone.
     * @dev Bump this in the same commit as any storage-layout change.
     */
    function version() external pure virtual returns (string memory) {
        return "2.0.0-autopilot";
    }

    /// @dev Only the owner may ship a new implementation. See the note above.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    /* ===================== CORE ESCROW LOGIC ===================== */

    /**
     * @notice Create a milestone-based escrow.
     * @dev Deposit = totalAmount + platformFee. Fee is separated immediately.
     */
    function createEscrow(
        address beneficiary,
        address token,
        uint256 totalAmount,
        uint256 durationDays,
        address[] calldata arbiters,
        uint256 requiredConfirmations,
        uint256[] calldata milestoneAmounts,
        string[] calldata milestoneDescriptions,
        string calldata projectTitle,
        string calldata projectDescription
    ) external payable whenNotPaused nonReentrant returns (uint256) {
        if (totalAmount == 0) revert InvalidAmount();
        if (durationDays == 0) revert InvalidConfig();
        if (token != NATIVE_TOKEN && !whitelistedTokens[token]) revert TokenNotWhitelisted();
        if (milestoneAmounts.length == 0 || milestoneAmounts.length != milestoneDescriptions.length)
            revert InvalidConfig();
        if (arbiters.length > 0 && requiredConfirmations > arbiters.length) revert InvalidConfig();

        uint256 milestoneSum;
        for (uint256 i; i < milestoneAmounts.length; ++i) {
            if (milestoneAmounts[i] == 0) revert InvalidAmount();
            milestoneSum += milestoneAmounts[i];
        }
        if (milestoneSum != totalAmount) revert MilestoneSumMismatch();

        uint256 fee = (totalAmount * platformFeeBP) / 10000;
        uint256 totalDeposit = totalAmount + fee;

        if (token == NATIVE_TOKEN) {
            if (msg.value != totalDeposit) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), totalDeposit);
        }

        if (fee > 0) totalFeesByToken[token] += fee;

        uint256 escrowId = nextEscrowId++;
        bool isOpenJob = beneficiary == address(0);

        Escrow storage esc = escrows[escrowId];
        esc.depositor = msg.sender;
        esc.beneficiary = beneficiary;
        esc.token = token;
        esc.totalAmount = totalAmount;
        esc.deadline = block.timestamp + durationDays * 1 days;
        esc.status = EscrowStatus.Pending;
        esc.platformFee = fee;
        esc.arbiters = arbiters;
        esc.requiredConfirmations = requiredConfirmations == 0 ? 1 : requiredConfirmations;
        esc.isOpenJob = isOpenJob;
        esc.projectTitle = projectTitle;
        esc.projectDescription = projectDescription;

        for (uint256 i; i < milestoneAmounts.length; ++i) {
            escrowMilestones[escrowId].push(Milestone({
                amount: milestoneAmounts[i],
                description: "",
                requirements: milestoneDescriptions[i],
                status: MilestoneStatus.NotStarted,
                submittedAt: 0,
                approvedAt: 0,
                disputedAt: 0,
                disputedBy: address(0),
                disputeReason: "",
                rejectionReason: "",
                resolvedAt: 0,
                resolvedBy: address(0),
                proposedAmount: 0,
                proposedDescription: "",
                resolutionFreelancerAmount: 0,
                resolutionClientAmount: 0,
                resolutionReason: ""
            }));
        }

        escrowedAmount[token] += totalAmount;
        userEscrows[msg.sender].push(escrowId);
        if (!isOpenJob) userEscrows[beneficiary].push(escrowId);

        emit EscrowCreated(escrowId, msg.sender, beneficiary, arbiters, requiredConfirmations,
            totalAmount, fee, token, esc.deadline, isOpenJob);
        return escrowId;
    }

    function startWork(uint256 escrowId) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.beneficiary != msg.sender) revert Unauthorized();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        if (esc.workStarted) revert WorkAlreadyStarted();

        esc.workStarted = true;
        esc.status = EscrowStatus.InProgress;

        emit WorkStarted(escrowId, msg.sender, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.InProgress, block.timestamp);
    }

    /**
     * @notice Extend the deadline of an active escrow.
     * @dev Only the depositor can extend. Extension must be at least 1 day.
     */
    function extendDeadline(uint256 escrowId, uint256 additionalDays) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (esc.status != EscrowStatus.Pending && esc.status != EscrowStatus.InProgress)
            revert InvalidEscrowStatus();
        if (additionalDays < MIN_EXTENSION_DAYS) revert ExtensionTooShort();

        uint256 oldDeadline = esc.deadline;
        esc.deadline = oldDeadline + additionalDays * 1 days;

        emit DeadlineExtended(escrowId, oldDeadline, esc.deadline);
    }

    function submitMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata description)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.beneficiary != msg.sender) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted && m.status != MilestoneStatus.Rejected)
            revert MilestoneAlreadyProcessed();

        m.status = MilestoneStatus.Submitted;
        m.description = description;
        m.submittedAt = block.timestamp;

        emit MilestoneSubmitted(escrowId, milestoneIndex, msg.sender, description, block.timestamp);
    }

    function approveMilestone(uint256 escrowId, uint256 milestoneIndex)
        external nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        // Depositor, or the agent they appointed. Payment goes to esc.beneficiary
        // either way — a manager approving is paying the freelancer by
        // construction, never itself.
        _onlyDepositorOrManager(esc, escrowId);
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Approved;
        m.approvedAt = block.timestamp;

        esc.paidAmount += m.amount;
        escrowedAmount[esc.token] -= m.amount;

        if (esc.paidAmount == esc.totalAmount) {
            esc.status = EscrowStatus.Released;
            completedEscrows[esc.beneficiary]++;
            completedEscrows[esc.depositor]++;
            reputation[esc.beneficiary]++;
            emit EscrowUpdated(escrowId, EscrowStatus.Released, block.timestamp);
        }

        _doTransfer(esc.token, address(this), esc.beneficiary, m.amount);
        // What is safe to have lent out just shrank. Pull the excess back.
        _rebalanceYield(escrowId);
        emit MilestoneApproved(escrowId, milestoneIndex, esc.beneficiary, m.amount, block.timestamp);
    }

    function rejectMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata reason)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        // Rejection moves no value; it sends the milestone back for revision,
        // which is exactly the review labour Autopilot exists to do.
        _onlyDepositorOrManager(esc, escrowId);
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Rejected;
        m.rejectionReason = reason;

        emit MilestoneRejected(escrowId, milestoneIndex, msg.sender, reason, block.timestamp);
    }

    function disputeMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata reason)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor && msg.sender != esc.beneficiary) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted && m.status != MilestoneStatus.Rejected)
            revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Disputed;
        m.disputedAt = block.timestamp;
        m.disputedBy = msg.sender;
        m.disputeReason = reason;
        esc.status = EscrowStatus.Disputed;

        emit MilestoneDisputed(escrowId, milestoneIndex, msg.sender, reason, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.Disputed, block.timestamp);
    }

    function raiseOverdueDispute(uint256 escrowId, string calldata reason) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor && msg.sender != esc.beneficiary) revert Unauthorized();
        if (block.timestamp <= esc.deadline) revert DeadlineNotPassed();
        if (esc.status == EscrowStatus.Released ||
            esc.status == EscrowStatus.Refunded ||
            esc.status == EscrowStatus.Expired) revert CannotRefund();

        esc.status = EscrowStatus.Disputed;
        emit OverdueDisputeRaised(escrowId, msg.sender, reason, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.Disputed, block.timestamp);
    }

    /**
     * @notice Multi-sig arbiter dispute resolution.
     * @param reason Admin's reason for the resolution decision (required)
     */
    function resolveDispute(
        uint256 escrowId,
        uint256 milestoneIndex,
        uint256 freelancerAmount,
        uint256 clientAmount,
        string calldata reason
    ) external onlyArbiter nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.status != EscrowStatus.Disputed) revert InvalidEscrowStatus();
        if (bytes(reason).length == 0) revert InvalidConfig(); // Reason is required

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (freelancerAmount + clientAmount != m.amount) revert InvalidAmount();

        if (!disputeVotes[escrowId][msg.sender]) {
            disputeVotes[escrowId][msg.sender] = true;
            disputeVoteCounts[escrowId]++;
            emit DisputeVoteCast(escrowId, msg.sender, disputeVoteCounts[escrowId]);
        }

        if (disputeVoteCounts[escrowId] < esc.requiredConfirmations) return;

        m.status = MilestoneStatus.Approved;
        m.resolvedAt = block.timestamp;
        m.resolvedBy = msg.sender;
        m.resolutionFreelancerAmount = freelancerAmount;
        m.resolutionClientAmount = clientAmount;
        m.resolutionReason = reason;

        esc.paidAmount += freelancerAmount;
        esc.totalAmount -= clientAmount;
        escrowedAmount[esc.token] -= m.amount;

        if (esc.paidAmount == esc.totalAmount) {
            esc.status = EscrowStatus.Released;
            emit EscrowUpdated(escrowId, EscrowStatus.Released, block.timestamp);
        } else {
            esc.status = EscrowStatus.InProgress;
            emit EscrowUpdated(escrowId, EscrowStatus.InProgress, block.timestamp);
        }

        if (freelancerAmount > 0) _doTransfer(esc.token, address(this), esc.beneficiary, freelancerAmount);
        if (clientAmount > 0) _doTransfer(esc.token, address(this), esc.depositor, clientAmount);
        // A resolution moves paidAmount and totalAmount both, so the safe level
        // moves too. Same reason as approveMilestone.
        _rebalanceYield(escrowId);

        emit DisputeResolved(escrowId, milestoneIndex, msg.sender, freelancerAmount, clientAmount, block.timestamp);
    }

    function emergencyRefundAfterDeadline(uint256 escrowId) external nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.depositor != msg.sender) revert Unauthorized();
        if (block.timestamp <= esc.deadline + EMERGENCY_REFUND_DELAY) revert EmergencyPeriodNotReached();
        if (esc.status == EscrowStatus.Released ||
            esc.status == EscrowStatus.Refunded ||
            esc.status == EscrowStatus.Expired) revert CannotRefund();

        uint256 refundAmount = esc.totalAmount - esc.paidAmount;
        if (refundAmount == 0) revert NothingToRefund();

        esc.status = EscrowStatus.Expired;
        escrowedAmount[esc.token] -= refundAmount;

        _doTransfer(esc.token, address(this), esc.depositor, refundAmount);
        emit EmergencyRefundExecuted(escrowId, msg.sender, refundAmount);
        emit EscrowUpdated(escrowId, EscrowStatus.Expired, block.timestamp);
    }

    function submitEvidence(uint256 escrowId, uint256 milestoneIndex, string calldata cid) external {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor && msg.sender != esc.beneficiary) revert Unauthorized();
        emit EvidenceSubmitted(escrowId, milestoneIndex, msg.sender, cid);
    }

    /* ===================== RATINGS ===================== */

    /**
     * @notice Submit a 1-5 star rating after the escrow is fully released.
     * @dev Each participant may rate the other exactly once per escrow.
     */
    function submitRating(uint256 escrowId, uint8 score, string calldata review) external {
        if (score < 1 || score > 5) revert InvalidRating();

        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.status != EscrowStatus.Released) revert EscrowNotReleased();

        bool isDepositor = msg.sender == esc.depositor;
        bool isBeneficiary = msg.sender == esc.beneficiary;
        if (!isDepositor && !isBeneficiary) revert NotParticipant();

        if (_ratings[escrowId][msg.sender].ratedAt != 0) revert AlreadyRated();

        address rated = isDepositor ? esc.beneficiary : esc.depositor;

        Rating memory r = Rating({
            rater: msg.sender,
            rated: rated,
            score: score,
            review: review,
            ratedAt: block.timestamp
        });

        _ratings[escrowId][msg.sender] = r;
        _receivedRatings[rated].push(r);

        emit RatingSubmitted(escrowId, msg.sender, rated, score);
    }

    /* ===================== OPEN JOB LOGIC ===================== */

    function applyToJob(uint256 escrowId, string calldata coverLetter, uint256 proposedTimeline)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (!esc.isOpenJob) revert NotAnOpenJob();
        if (hasApplied[escrowId][msg.sender]) revert AlreadyApplied();

        hasApplied[escrowId][msg.sender] = true;
        escrowApplications[escrowId].push(msg.sender);

        emit ApplicationSubmitted(escrowId, msg.sender, coverLetter, proposedTimeline);
    }

    function acceptFreelancer(uint256 escrowId, address freelancer) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        _onlyDepositorOrManager(esc, escrowId);
        if (!esc.isOpenJob) revert NotAnOpenJob();
        if (!hasApplied[escrowId][freelancer]) revert FreelancerNotApplied();
        if (freelancer == address(0)) revert InvalidAddress();

        /**
         * THE ONE-WAY KEY, second enforcement point.
         *
         * setJobManager checks manager != beneficiary, but on an open job the
         * beneficiary is not known yet — it is assigned right here. Without this
         * check a manager could appoint itself the freelancer and then approve
         * its own milestones, which is the entire attack the invariant exists to
         * stop.
         *
         * Checked against the stored manager rather than against msg.sender, so
         * it holds no matter who calls: a depositor cannot accidentally hire
         * their own agent as the worker either.
         */
        if (freelancer == jobManager[escrowId]) revert ManagerCannotSelfHire();

        esc.beneficiary = freelancer;
        esc.isOpenJob = false;
        userEscrows[freelancer].push(escrowId);

        emit FreelancerAccepted(escrowId, freelancer);
    }

    /* ===================== AUTOPILOT: SCOPED JOB MANAGER ===================== */

    /**
     * @notice Appoint an agent to manage this job on your behalf.
     * @dev Depositor only. The manager may hire, approve and reject. It may not
     *      dispute, cancel, extend, add or withdraw funds, re-appoint, or become
     *      the beneficiary — see the jobManager mapping for the invariant.
     *
     *      Appointing a new manager replaces the previous one outright; there is
     *      deliberately no list. One job, one manager, so "who did this" always
     *      has exactly one answer.
     */
    function setJobManager(uint256 escrowId, address manager) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (manager == address(0)) revert InvalidAddress();

        // Paying yourself to manage your own job is a configuration mistake, and
        // silently accepting it would leave a manager set that nobody expects.
        if (manager == esc.depositor) revert InvalidAddress();

        // THE ONE-WAY KEY. A manager that is also the beneficiary could approve
        // its own milestones and drain the escrow to itself.
        if (manager == esc.beneficiary) revert ManagerCannotBeBeneficiary();

        jobManager[escrowId] = manager;
        emit JobManagerSet(escrowId, manager);
    }

    /**
     * @notice Take back management of this job, immediately.
     * @dev Depositor only. Effective on the next call — a revoked manager's very
     *      next transaction reverts. This is the client's escape hatch and must
     *      never depend on the manager's cooperation or on a timelock.
     */
    function revokeJobManager(uint256 escrowId) external {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        address mgr = jobManager[escrowId];
        if (mgr == address(0)) revert NoManagerSet();

        delete jobManager[escrowId];
        emit JobManagerRevoked(escrowId, mgr);
    }

    /// @notice Whether `who` may currently manage `escrowId`.
    function isJobManager(uint256 escrowId, address who) external view returns (bool) {
        return who != address(0) && jobManager[escrowId] == who;
    }

    /* ===================== PRODUCTIVE ESCROW ===================== */

    /**
     * @notice Point a token at a yield venue. Owner only.
     * @dev Setting address(0) stops new deployments; it does NOT unwind what is
     *      already out there. Unwinding happens on demand through the payout
     *      path, so a bad venue is disconnected first and drained as escrows
     *      resolve, rather than forcing one enormous exit at the worst moment.
     */
    function setYieldAdapter(address token, address adapter) external onlyOwner {
        if (adapter != address(0) && IYieldAdapter(adapter).asset() != token) revert InvalidConfig();
        yieldAdapter[token] = IYieldAdapter(adapter);
        emit YieldAdapterSet(token, adapter);
    }

    /**
     * @notice Fraction of escrowed funds never deployed, in basis points.
     * @dev Floored at 10% rather than 0. A zero buffer means every single
     *      payout has to unwind, which turns the venue from an optimisation
     *      into a dependency — exactly what the circuit breaker exists to avoid.
     */
    function setYieldBuffer(uint256 bp) external onlyOwner {
        if (bp < 1000 || bp > 10000) revert BufferTooLow();
        yieldBufferBP = bp;
    }

    /**
     * @notice Opt this escrow's idle funds into earning yield, or back out.
     * @dev The depositor's call, and only theirs: it is their capital at risk.
     *      Opting out does not unwind on the spot — the funds come back through
     *      the ordinary payout path, so opting out can never itself fail.
     */
    function setYieldOptIn(uint256 escrowId, bool optedIn) external {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        yieldOptIn[escrowId] = optedIn;
        emit YieldOptInChanged(escrowId, optedIn);
    }

    /**
     * @notice How much of ONE escrow's capital is safe to deploy.
     *
     * THIS IS THE HEART OF THE FEATURE, and the first version of it was wrong.
     *
     * The obvious rule — "deploy everything except a 20% buffer" — does not
     * hold. Milestones are not 20% of an escrow. A job with two milestones has
     * one worth half the budget, and when the venue is down, a 20% buffer
     * cannot pay a 50% milestone. The payout reverts. Tested against a venue
     * that refuses to return funds, the first implementation failed six ways,
     * and no amount of circuit breaking fixes it: a breaker can stop you
     * depending on the venue, it cannot conjure money you already lent out.
     *
     * So the cap is derived from the largest thing that could be claimed next,
     * not from a percentage someone liked:
     *
     *   1. An OPEN job can be cancelled outright, refunding everything. The
     *      whole balance is claimable at any instant, so nothing is deployable.
     *   2. Once a freelancer is assigned, cancellation is blocked and claims
     *      arrive one milestone at a time. The largest unpaid milestone must
     *      therefore stay in cash.
     *   3. `yieldBufferBP` is applied on top of that, not instead of it.
     *
     * What is left over is money this escrow provably cannot be asked for in a
     * single call, so lending it out cannot block a payment.
     *
     * The honest exception, and it is documented rather than hidden:
     * `emergencyRefundAfterDeadline` pays out the whole remainder at once. It
     * requires the deadline plus 30 days, which is a long time to unwind a
     * position in, but it is the one path where a dead venue could delay a
     * withdrawal. It cannot lose the money — only hold it up.
     */
    function investableAmount(uint256 escrowId) public view returns (uint256) {
        Escrow storage esc = escrows[escrowId];
        if (esc.depositor == address(0)) return 0;
        if (!yieldOptIn[escrowId]) return 0;

        address token = esc.token;
        if (address(yieldAdapter[token]) == address(0)) return 0;

        // Rule 1: an open job is refundable in full, on demand.
        if (esc.isOpenJob || esc.beneficiary == address(0)) return 0;
        if (esc.status != EscrowStatus.Pending && esc.status != EscrowStatus.InProgress) return 0;

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining == 0) return 0;

        // Rule 2: keep the largest single claim in cash.
        uint256 largestClaim;
        Milestone[] storage ms = escrowMilestones[escrowId];
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == MilestoneStatus.Approved) continue;
            if (ms[i].amount > largestClaim) largestClaim = ms[i].amount;
        }

        // Rule 3: the percentage buffer, on top.
        uint256 buffer = (remaining * yieldBufferBP) / 10000;
        uint256 reserve = largestClaim + buffer;
        if (remaining <= reserve) return 0;

        uint256 already = escrowDeployed[escrowId];
        uint256 ceiling = remaining - reserve;
        if (already >= ceiling) return 0;
        uint256 room = ceiling - already;

        uint256 cash = token == NATIVE_TOKEN
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
        return room > cash ? cash : room;
    }

    /**
     * @notice The most this escrow may safely have lent out, right now.
     * @dev The same arithmetic as investableAmount, without subtracting what is
     *      already deployed — this is the level, that is the headroom. Kept
     *      separate so rebalancing has something to unwind DOWN to.
     */
    function investableCeiling(uint256 escrowId) public view returns (uint256) {
        Escrow storage esc = escrows[escrowId];
        if (esc.depositor == address(0)) return 0;
        if (esc.isOpenJob || esc.beneficiary == address(0)) return 0;
        if (esc.status != EscrowStatus.Pending && esc.status != EscrowStatus.InProgress) return 0;

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining == 0) return 0;

        uint256 largestClaim;
        Milestone[] storage ms = escrowMilestones[escrowId];
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == MilestoneStatus.Approved) continue;
            if (ms[i].amount > largestClaim) largestClaim = ms[i].amount;
        }

        uint256 reserve = largestClaim + (remaining * yieldBufferBP) / 10000;
        return remaining <= reserve ? 0 : remaining - reserve;
    }

    /**
     * @notice Put one escrow's genuinely idle capital to work.
     * @dev Permissionless: it moves money only from this contract into the
     *      venue its owner chose, never out to a caller, so there is nothing to
     *      gain by calling it and something to lose by nobody ever calling it.
     */
    function investIdle(uint256 escrowId) external nonReentrant whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        address token = esc.token;
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) revert YieldNotEnabled();

        uint256 amount = investableAmount(escrowId);
        if (amount == 0) return;

        escrowDeployed[escrowId] += amount;
        deployedAssets[token] += amount;

        if (token == NATIVE_TOKEN) {
            adapter.deposit{value: amount}(amount);
        } else {
            IERC20(token).forceApprove(address(adapter), amount);
            adapter.deposit(amount);
        }
        emit YieldDeployed(token, amount);
    }

    /// @notice Yield earned above principal, per token. Zero if the venue lost.
    function yieldEarned(address token) external view returns (uint256) {
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return 0;
        uint256 held = adapter.totalAssets();
        uint256 principal = deployedAssets[token];
        return held > principal ? held - principal : 0;
    }

    /* ===================== JOB MANAGEMENT (BEFORE ASSIGNMENT) ===================== */

    /**
     * @notice Cancel an open job and refund the depositor (only if no freelancer assigned)
     * @dev Implements tiered penalty system to prevent abuse:
     *      - Cancellations 0-2: 0% penalty (free)
     *      - Cancellations 3-5: 5% penalty
     *      - Cancellations 6-10: 10% penalty
     *      - Cancellations 11+: 15% penalty
     *      Additional penalty based on number of applications received
     */
    function cancelJob(uint256 escrowId) external nonReentrant whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (!esc.isOpenJob) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();

        // Track cancellation
        userCancellations[msg.sender]++;
        lastCancellationTime[msg.sender] = block.timestamp;

        // Calculate penalty
        uint256 penalty = _calculateCancellationPenalty(msg.sender, escrowId);
        uint256 refundAmount = esc.totalAmount;
        uint256 feeRefund = esc.platformFee;
        
        // Deduct penalty from refund
        uint256 netRefund = refundAmount > penalty ? refundAmount - penalty : 0;
        uint256 totalRefund = netRefund + feeRefund;

        esc.status = EscrowStatus.Cancelled;
        escrowedAmount[esc.token] -= refundAmount;
        totalFeesByToken[esc.token] -= feeRefund;
        
        // Add penalty to platform fees
        if (penalty > 0) {
            totalFeesByToken[esc.token] += penalty;
        }

        _doTransfer(esc.token, address(this), esc.depositor, totalRefund);

        emit JobCancelled(escrowId, msg.sender, totalRefund);
        emit EscrowUpdated(escrowId, EscrowStatus.Cancelled, block.timestamp);
    }

    /**
     * @notice Calculate cancellation penalty based on user's history
     * @dev Tiered system with application-based penalties
     */
    function _calculateCancellationPenalty(address user, uint256 escrowId) 
        internal view returns (uint256) 
    {
        uint256 effectiveCancellations = _getEffectiveCancellations(user);
        uint256 baseAmount = escrows[escrowId].totalAmount;
        
        // Base penalty based on cancellation tier
        uint256 basePenaltyPercent = 0;
        if (effectiveCancellations <= 2) {
            basePenaltyPercent = 0;  // Tier 1: Free
        } else if (effectiveCancellations <= 5) {
            basePenaltyPercent = 5;  // Tier 2: 5%
        } else if (effectiveCancellations <= 10) {
            basePenaltyPercent = 10; // Tier 3: 10%
        } else {
            basePenaltyPercent = 15; // Tier 4: 15%
        }
        
        // Additional penalty based on applications
        uint256 applicationCount = escrowApplications[escrowId].length;
        uint256 applicationPenaltyPercent = 0;
        if (applicationCount >= 11) {
            applicationPenaltyPercent = 15;
        } else if (applicationCount >= 6) {
            applicationPenaltyPercent = 10;
        } else if (applicationCount >= 1) {
            applicationPenaltyPercent = 5;
        }
        
        uint256 totalPenaltyPercent = basePenaltyPercent + applicationPenaltyPercent;
        // Cap at 30% maximum penalty
        if (totalPenaltyPercent > 30) totalPenaltyPercent = 30;
        
        return (baseAmount * totalPenaltyPercent) / 100;
    }

    /**
     * @notice Get effective cancellations with time-based reduction
     * @dev Reduces by 1 for every 30 days without cancellation
     */
    function _getEffectiveCancellations(address user) internal view returns (uint256) {
        uint256 cancellations = userCancellations[user];
        uint256 lastCancel = lastCancellationTime[user];
        
        if (lastCancel == 0 || cancellations == 0) return cancellations;
        
        // Reduce by 1 for every 30 days without cancellation
        uint256 daysSinceLastCancel = (block.timestamp - lastCancel) / 1 days;
        uint256 reduction = daysSinceLastCancel / 30;
        
        return cancellations > reduction ? cancellations - reduction : 0;
    }

    /**
     * @notice Add more funds to an open job (before freelancer is assigned)
     *         and allocate them to a specific milestone so the sum invariant
     *         (sum(milestoneAmounts) == totalAmount) is always maintained.
     * @param milestoneIndex The milestone that receives the additional funds.
     */
    function addJobFunds(uint256 escrowId, uint256 additionalAmount, uint256 milestoneIndex)
        external payable nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (!esc.isOpenJob) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        if (additionalAmount == 0) revert InvalidAmount();

        // Validate milestone index before any state changes
        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();

        uint256 additionalFee = (additionalAmount * platformFeeBP) / 10000;
        uint256 totalDeposit = additionalAmount + additionalFee;

        if (esc.token == NATIVE_TOKEN) {
            if (msg.value != totalDeposit) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20(esc.token).safeTransferFrom(msg.sender, address(this), totalDeposit);
        }

        uint256 oldTotal = esc.totalAmount;
        esc.totalAmount += additionalAmount;
        esc.platformFee += additionalFee;
        m.amount += additionalAmount; // keep sum invariant

        escrowedAmount[esc.token] += additionalAmount;
        totalFeesByToken[esc.token] += additionalFee;

        emit JobFundsUpdated(escrowId, oldTotal, esc.totalAmount, true);
    }

    /**
     * @notice Withdraw funds from a specific milestone on an open job
     *         (before freelancer is assigned). Reduces both totalAmount and
     *         the chosen milestone's amount to keep the sum invariant.
     * @param milestoneIndex The milestone to reduce.
     */
    function withdrawJobFunds(uint256 escrowId, uint256 withdrawAmount, uint256 milestoneIndex)
        external nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (!esc.isOpenJob) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        if (withdrawAmount == 0 || withdrawAmount > esc.totalAmount) revert InvalidAmount();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();
        if (withdrawAmount > m.amount) revert InvalidAmount(); // can't reduce below zero

        uint256 feeToRefund = (withdrawAmount * platformFeeBP) / 10000;
        uint256 oldTotal = esc.totalAmount;

        esc.totalAmount -= withdrawAmount;
        esc.platformFee -= feeToRefund;
        m.amount -= withdrawAmount; // keep sum invariant

        escrowedAmount[esc.token] -= withdrawAmount;
        totalFeesByToken[esc.token] -= feeToRefund;

        uint256 totalWithdraw = withdrawAmount + feeToRefund;
        _doTransfer(esc.token, address(this), esc.depositor, totalWithdraw);

        emit JobFundsUpdated(escrowId, oldTotal, esc.totalAmount, false);
    }

    /* ===================== MILESTONE NEGOTIATION ===================== */

    /**
     * @notice Freelancer proposes changes to a milestone
     */
    function proposeMilestoneChange(
        uint256 escrowId,
        uint256 milestoneIndex,
        uint256 proposedAmount,
        string calldata proposedDescription
    ) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.beneficiary) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress && esc.status != EscrowStatus.Pending) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();
        if (proposedAmount == 0) revert InvalidAmount();

        m.proposedAmount = proposedAmount;
        m.proposedDescription = proposedDescription;
        m.status = MilestoneStatus.ProposalPending;

        emit MilestoneProposalSubmitted(escrowId, milestoneIndex, msg.sender, proposedAmount, proposedDescription);
    }

    /**
     * @notice Client approves the proposed milestone changes
     */
    function approveMilestoneProposal(uint256 escrowId, uint256 milestoneIndex) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.ProposalPending) revert NoPendingProposal();

        // Update milestone with proposed values
        m.amount = m.proposedAmount;
        m.description = m.proposedDescription;
        m.status = MilestoneStatus.NotStarted;

        // Clear proposal data
        m.proposedAmount = 0;
        m.proposedDescription = "";

        emit MilestoneProposalApproved(escrowId, milestoneIndex, m.amount, m.description);
    }

    /**
     * @notice Client rejects the proposed milestone changes
     */
    function rejectMilestoneProposal(uint256 escrowId, uint256 milestoneIndex) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.ProposalPending) revert NoPendingProposal();

        // Revert to NotStarted status
        m.status = MilestoneStatus.NotStarted;
        m.proposedAmount = 0;
        m.proposedDescription = "";

        emit MilestoneProposalRejected(escrowId, milestoneIndex);
    }

    /* ===================== ADMIN LOGIC ===================== */

    function authorizeArbiter(address arbiter) external onlyOwner {
        if (arbiter == address(0)) revert InvalidAddress();
        if (!authorizedArbiters[arbiter]) {
            authorizedArbiters[arbiter] = true;
            _arbiterList.push(arbiter);
            emit ArbiterAuthorized(arbiter);
        }
    }

    function revokeArbiter(address arbiter) external onlyOwner {
        if (authorizedArbiters[arbiter]) {
            authorizedArbiters[arbiter] = false;
            // Remove from enumerable list
            uint256 len = _arbiterList.length;
            for (uint256 i; i < len; ++i) {
                if (_arbiterList[i] == arbiter) {
                    _arbiterList[i] = _arbiterList[len - 1];
                    _arbiterList.pop();
                    break;
                }
            }
            emit ArbiterRevoked(arbiter);
        }
    }

    function whitelistToken(address token) external onlyOwner {
        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token);
    }

    function blacklistToken(address token) external onlyOwner {
        whitelistedTokens[token] = false;
        emit TokenBlacklisted(token);
    }

    /**
     * @notice Permanently delete an escrow record (owner only).
     * @dev Requires zero remaining funds — i.e. all value has been paid out,
     *      refunded, or the escrow was cancelled with nothing deposited.
     *      Status must be Released, Refunded, Expired, or Cancelled.
     *      This deletes the storage slot; the escrow ID can never be reused.
     */
    function deleteEscrow(uint256 escrowId) external onlyOwner nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);

        // Must be in a terminal state with no funds remaining
        bool isTerminal = (
            esc.status == EscrowStatus.Released  ||
            esc.status == EscrowStatus.Refunded  ||
            esc.status == EscrowStatus.Expired   ||
            esc.status == EscrowStatus.Cancelled
        );
        if (!isTerminal) revert InvalidEscrowStatus();

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining > 0) revert InvalidAmount(); // funds still locked

        delete escrows[escrowId];
        // Remove from depositor and beneficiary index arrays
        _removeFromUserEscrows(esc.depositor, escrowId);
        if (esc.beneficiary != address(0)) {
            _removeFromUserEscrows(esc.beneficiary, escrowId);
        }

        emit EscrowDeleted(escrowId, msg.sender);
    }

    function setPlatformFee(uint256 _platformFeeBP) external onlyOwner {
        if (_platformFeeBP > MAX_PLATFORM_FEE_BP) revert InvalidConfig();
        platformFeeBP = _platformFeeBP;
        emit PlatformFeeUpdated(_platformFeeBP);
    }

    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert InvalidAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    function withdrawFees(address token) external nonReentrant {
        if (msg.sender != feeCollector) revert Unauthorized();
        uint256 amount = totalFeesByToken[token];
        if (amount == 0) revert InvalidAmount();

        totalFeesByToken[token] = 0;
        _doTransfer(token, address(this), feeCollector, amount);
        emit FeesWithdrawn(token, amount, feeCollector);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /* ===================== VIEW FUNCTIONS ===================== */

    function getEscrow(uint256 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    function getMilestones(uint256 escrowId) external view returns (Milestone[] memory) {
        return escrowMilestones[escrowId];
    }

    function getUserEscrows(address user) external view returns (uint256[] memory) {
        return userEscrows[user];
    }

    function getEscrowApplications(uint256 escrowId) external view returns (address[] memory) {
        return escrowApplications[escrowId];
    }

    function getApplicationCount(uint256 escrowId) external view returns (uint256) {
        return escrowApplications[escrowId].length;
    }

    function getMilestoneCount(uint256 escrowId) external view returns (uint256) {
        return escrowMilestones[escrowId].length;
    }

    /** @notice Returns all currently authorized arbiters. */
    function getArbiters() external view returns (address[] memory) {
        return _arbiterList;
    }

    /** @notice Returns all ratings received by an address. */
    function getRatingsForAddress(address addr) external view returns (Rating[] memory) {
        return _receivedRatings[addr];
    }

    /**
     * @notice Returns average rating (scaled ×100) and count for an address.
     *         e.g. average = 450 means 4.50 stars.
     */
    function getAverageRating(address addr) external view returns (uint256 averageX100, uint256 count) {
        Rating[] storage ratings = _receivedRatings[addr];
        count = ratings.length;
        if (count == 0) return (0, 0);
        uint256 total;
        for (uint256 i; i < count; ++i) total += ratings[i].score;
        averageX100 = (total * 100) / count;
    }

    /** @notice Returns the rating a specific rater gave in an escrow (0 if not rated). */
    function getRating(uint256 escrowId, address rater) external view returns (Rating memory) {
        return _ratings[escrowId][rater];
    }

    /**
     * @notice Compute the total deposit required (totalAmount + fee).
     */
    function quoteDeposit(uint256 totalAmount) external view returns (uint256 deposit, uint256 fee) {
        fee = (totalAmount * platformFeeBP) / 10000;
        deposit = totalAmount + fee;
    }

    /* ===================== INTERNAL HELPERS ===================== */

    function _requireEscrow(uint256 escrowId) private view returns (Escrow storage) {
        Escrow storage esc = escrows[escrowId];
        if (esc.depositor == address(0)) revert EscrowNotFound();
        return esc;
    }

    function _getMilestone(uint256 escrowId, uint256 index) private view returns (Milestone storage) {
        if (index >= escrowMilestones[escrowId].length) revert InvalidMilestone();
        return escrowMilestones[escrowId][index];
    }

    function _removeFromUserEscrows(address user, uint256 escrowId) private {
        uint256[] storage arr = userEscrows[user];
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            if (arr[i] == escrowId) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    /**
     * @dev Make sure this contract can pay `amount` of `token` right now.
     *
     * THE CIRCUIT BREAKER. Called before every outbound payment. If cash covers
     * it, the venue is never touched — which is what the buffer is for, and is
     * the common case.
     *
     * If it does not, we try to unwind exactly the shortfall. That call is
     * wrapped, so a venue that reverts, pauses, or has gone illiquid costs us
     * the yield and NOT the payment: control returns here, the transfer is
     * attempted from whatever cash exists, and the shortfall is emitted rather
     * than swallowed. A freelancer being paid does not depend on a pool being
     * healthy.
     *
     * Deliberately not `nonReentrant`: every caller already is, and adding it
     * here would make approveMilestone revert on its own guard.
     */
    function _ensureLiquid(address token, uint256 amount) private {
        uint256 cash = token == NATIVE_TOKEN
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
        if (cash >= amount) return;

        uint256 shortfall = amount - cash;
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) {
            emit YieldCircuitBreakerTripped(token, shortfall);
            return;
        }

        uint256 deployed = deployedAssets[token];
        uint256 ask = shortfall > deployed ? deployed : shortfall;
        if (ask == 0) {
            emit YieldCircuitBreakerTripped(token, shortfall);
            return;
        }

        try adapter.withdraw(ask) returns (uint256 recovered) {
            // An adapter that returns less than asked has broken its contract.
            // Book what actually came back, never what was promised.
            deployedAssets[token] = deployed - (recovered > deployed ? deployed : recovered);
            emit YieldUnwound(token, ask, recovered);
            if (recovered < ask) emit YieldCircuitBreakerTripped(token, ask - recovered);
        } catch {
            // The venue is unavailable. That is survivable; not paying is not.
            emit YieldCircuitBreakerTripped(token, shortfall);
        }
    }

    /**
     * @dev Pull capital back down to what is still safe to have lent out.
     *
     * The deployment cap is computed at the moment of deploying, and an escrow
     * does not hold still: pay the small milestone and the remaining balance
     * shrinks while the largest outstanding claim does not, so an amount that
     * was safe an hour ago is not safe now. A fuzzer found this in a few
     * thousand calls — cash 502.5 against a next claim of 600, with 120 sitting
     * in a pool.
     *
     * So every payout that changes what is owed calls this, and it unwinds the
     * excess. Wrapped, because a venue that will not return funds must delay
     * yield, never a payment: if the unwind fails the payout still goes ahead
     * from cash, and the position stays marked for the next attempt.
     */
    function _rebalanceYield(uint256 escrowId) private {
        uint256 deployed = escrowDeployed[escrowId];
        if (deployed == 0) return;

        uint256 safe = investableCeiling(escrowId);
        if (deployed <= safe) return;

        uint256 excess = deployed - safe;
        Escrow storage esc = escrows[escrowId];
        address token = esc.token;
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return;

        try adapter.withdraw(excess) returns (uint256 recovered) {
            uint256 booked = recovered > deployed ? deployed : recovered;
            escrowDeployed[escrowId] = deployed - booked;
            deployedAssets[token] -= booked;
            emit YieldUnwound(token, excess, recovered);
            if (recovered < excess) emit YieldCircuitBreakerTripped(token, excess - recovered);
        } catch {
            emit YieldCircuitBreakerTripped(token, excess);
        }
    }

    function _doTransfer(address token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        if (from == address(this)) _ensureLiquid(token, amount);
        if (token == NATIVE_TOKEN) {
            if (from == address(this)) {
                (bool ok,) = to.call{value: amount}("");
                require(ok, "ETH transfer failed");
            }
        } else {
            if (from == address(this)) {
                IERC20(token).safeTransfer(to, amount);
            } else {
                IERC20(token).safeTransferFrom(from, to, amount);
            }
        }
    }

    receive() external payable {}

    /**
     * @dev Reserved storage so future versions can add state without shifting
     *      anything that already exists.
     *
     *      When you add a variable, put it directly ABOVE this gap and subtract
     *      the slots you used from the array length — one slot per variable,
     *      except for variables that pack together in a single slot. Get this
     *      wrong and an upgrade silently reinterprets live escrow data as
     *      whatever the new layout says it is; there is no revert, only wrong
     *      numbers.
     */
    /* 50 - 5 for the productive-escrow state above. Get this wrong and the
       next upgrade reinterprets live escrow data as whatever the new layout
       says; there is no revert, only wrong numbers. */
    uint256[45] private __gap;
}

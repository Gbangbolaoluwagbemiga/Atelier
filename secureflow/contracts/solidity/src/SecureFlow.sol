// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title SecureFlow
 * @dev Milestone-based escrow with on-chain ratings, deadline extension,
 *      and enumerable arbiter list — deployed on Arc EVM.
 *
 * Fee model:
 *   Client deposits totalAmount + platformFee upfront.
 *   Fee is separated immediately at creation.
 *   Milestones sum to totalAmount so the release check is exact.
 */
contract SecureFlow is Ownable2Step, ReentrancyGuard, Pausable {
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

    uint256 public nextEscrowId = 1;
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

    /* ===================== MODIFIERS ===================== */
    modifier onlyArbiter() {
        _onlyArbiter();
        _;
    }
    function _onlyArbiter() internal view {
        if (!authorizedArbiters[msg.sender]) revert Unauthorized();
    }

    /* ===================== CONSTRUCTOR ===================== */
    constructor(address _feeCollector, uint256 _platformFeeBP) Ownable(msg.sender) {
        if (_feeCollector == address(0)) revert InvalidAddress();
        if (_platformFeeBP > MAX_PLATFORM_FEE_BP) revert InvalidConfig();
        feeCollector = _feeCollector;
        platformFeeBP = _platformFeeBP;
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
        if (esc.depositor != msg.sender) revert Unauthorized();
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
        emit MilestoneApproved(escrowId, milestoneIndex, esc.beneficiary, m.amount, block.timestamp);
    }

    function rejectMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata reason)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.depositor != msg.sender) revert Unauthorized();
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
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (!esc.isOpenJob) revert NotAnOpenJob();
        if (!hasApplied[escrowId][freelancer]) revert FreelancerNotApplied();
        if (freelancer == address(0)) revert InvalidAddress();

        esc.beneficiary = freelancer;
        esc.isOpenJob = false;
        userEscrows[freelancer].push(escrowId);

        emit FreelancerAccepted(escrowId, freelancer);
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

    function _doTransfer(address token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
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
}

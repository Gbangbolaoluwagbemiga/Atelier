import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { motion } from "framer-motion";
import { Clock, DollarSign, ChevronDown, ChevronUp, Star, AlertTriangle, CalendarPlus, Scale, Paperclip, MessageCircle, CircleDollarSign, Loader2, Archive } from "lucide-react";
import { MilestoneActions } from "@/components/milestone-actions";
import { MilestoneNegotiation } from "@/components/milestone-negotiation";
import { JobManagement } from "@/components/job-management";
import { EvidenceSubmissionButton } from "@/components/evidence-submission-button";
import { ViewEvidenceButton } from "@/components/view-evidence-button";
import { parseAttachment, formatEth, formatTokenAmount } from "@/lib/utils";
import { RatingDialog } from "@/components/rating/rating-dialog";
import { ChatDialog } from "@/components/chat/chat-dialog";
import { useState, useEffect } from "react";
import { contractService } from "@/lib/web3/contract-service";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { isApiConfigured } from "@/lib/api";
import type { Escrow } from "@/lib/web3/types";
import { encodeJobId } from "@/lib/id-codec";


interface EscrowCardProps {
  escrow: Escrow;
  index: number;
  expandedEscrow: string | null;
  submittingMilestone: string | null;
  onToggleExpanded: (escrowId: string) => void;
  onApproveMilestone: (escrowId: string, milestoneIndex: number) => void;
  onRejectMilestone: (escrowId: string, milestoneIndex: number) => void;
  onDisputeMilestone: (escrowId: string, milestoneIndex: number) => void;
  onStartWork: (escrowId: string) => void;
  onDispute: (escrowId: string) => void;
  calculateDaysLeft: (createdAt: number, duration: number) => number;
  getDaysLeftMessage: (daysLeft: number) => {
    text: string;
    color: string;
    bgColor: string;
  };
  onRaiseOverdueDispute?: (escrowId: string, reason: string) => void;
  onExtendDeadline?: (escrowId: string, extraDays: number) => void;
  onReclaimSurplus?: (escrowId: string) => void;
  reclaimingFunds?: boolean;
  onArchive?: (escrowId: string) => void;
  onUnarchive?: (escrowId: string) => void;
}

export function EscrowCard({
  escrow,
  index,
  expandedEscrow,
  onToggleExpanded,
  calculateDaysLeft,
  getDaysLeftMessage,
  onRaiseOverdueDispute,
  onExtendDeadline,
  onReclaimSurplus,
  reclaimingFunds = false,
  onArchive,
  onUnarchive,
}: EscrowCardProps) {
  const { toast } = useToast();
  const [showRatingDialog, setShowRatingDialog] = useState(false);
  const [hasRating, setHasRating] = useState(false);
  const [existingRating, setExistingRating] = useState<{
    rating: number;
    review: string;
  } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const [customDays, setCustomDays] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [showDisputeForm, setShowDisputeForm] = useState(false);

  const { wallet } = useWeb3();

  // ── Surplus / stuck-funds detection ───────────────────────────────────────
  // addJobFunds increases totalAmount but doesn't create new milestones, so
  // sum(milestone.amount) can be < totalAmount after funds are added.
  // approveMilestone only flips the escrow to Released when paidAmount ==
  // totalAmount, so the surplus stays locked. emergencyRefundAfterDeadline
  // (contract constant = deadline + 30 days) is the only on-chain escape hatch.
  const milestoneAmountSum = escrow.milestones.reduce(
    (acc, m) => acc + parseFloat(m.amount || "0"),
    0,
  );
  const totalAmountNum = parseFloat(escrow.totalAmount || "0");
  const surplusAmount = totalAmountNum - milestoneAmountSum;
  const hasSurplus = escrow.isClient && surplusAmount >= 1000; // ≥ 0.001 USDC in raw units

  const now = Date.now();
  const deadlineAt = escrow.deadlineAt ?? 0;

  const EMERGENCY_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
  const emergencyAvailableAt = deadlineAt > 0 ? deadlineAt + EMERGENCY_DELAY_MS : 0;
  const canEmergencyRefund = hasSurplus && emergencyAvailableAt > 0 && now > emergencyAvailableAt;
  const emergencyAvailableDate = emergencyAvailableAt
    ? new Date(emergencyAvailableAt).toLocaleDateString()
    : null;
  const isOverdue = deadlineAt > 0 && now > deadlineAt;
  const isActive = escrow.status === "active" || escrow.status === "pending";
  // Pending, open jobs with no freelancer yet can Cancel Job for an instant
  // full refund — no need to wait on the 30-day emergency-refund window.
  const isCancelableJob =
    escrow.isClient &&
    escrow.status === "pending" &&
    (!escrow.beneficiary ||
      escrow.beneficiary === "0x0000000000000000000000000000000000000000");
  const isSettled =
    escrow.status === "completed" ||
    escrow.status === "refunded" ||
    escrow.status === "expired";

  // Check if rating exists for this escrow
  useEffect(() => {
    if (escrow.status === "completed" && escrow.isClient) {
      contractService
        .getRating(Number.parseInt(escrow.id, 10), wallet.address || undefined)
        .then((r: any) => {
          if (r && r.score) {
            setHasRating(true);
            setExistingRating({ rating: r.score, review: r.review || "" });
          }
        })
        .catch(() => {});
    }
  }, [escrow.id, escrow.status, escrow.isClient]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "active":
        return "bg-blue-100 text-blue-800";
      case "completed":
        return "bg-green-100 text-green-800";
      case "disputed":
        return "bg-orange-100 text-orange-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      case "resolved":
        return "bg-purple-100 text-purple-800";
      case "Dispute Resolved":
        return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  // Check if this escrow has issues (disputed or rejected milestones)
  const hasIssues = escrow.milestones.some(
    (milestone) =>
      milestone.status === "disputed" ||
      milestone.status === "rejected" ||
      milestone.status === "resolved"
  );
  
  // Check if any milestone was resolved (dispute resolution)
  const hasResolvedDispute = escrow.milestones.some(m => m.status === "resolved");
  
  // Determine display status
  const getDisplayStatus = () => {
    // If any milestone is disputed, show disputed
    if (escrow.milestones.some(m => m.status === "disputed")) return "disputed";
    // If any milestone is rejected, show rejected
    if (escrow.milestones.some(m => m.status === "rejected")) return "rejected";
    // If any milestone was resolved (dispute resolution), show "Dispute Resolved"
    if (hasResolvedDispute) return "Dispute Resolved";
    return escrow.status;
  };
  
  const displayStatus = getDisplayStatus();

  const getMilestoneStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "submitted":
        return "bg-blue-100 text-blue-800";
      case "approved":
        return "bg-green-100 text-green-800";
      case "disputed":
        return "bg-red-100 text-red-800";
      case "resolved":
        return "bg-purple-100 text-purple-800";
      case "rejected":
        return "bg-orange-100 text-orange-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const progressPercentage =
    escrow.totalAmount !== "0"
      ? (Number.parseFloat(escrow.releasedAmount) /
          Number.parseFloat(escrow.totalAmount)) *
        100
      : 0;

  const completedMilestones = escrow.milestones.filter(
    (m) => m.status === "approved"
  ).length;
  const totalMilestones = escrow.milestones.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
    >
      <Card className="glass border-primary/20 p-4 md:p-6 hover:border-primary/40 transition-colors">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="text-lg mb-1">
                {escrow.projectTitle || encodeJobId(escrow.id)}
              </CardTitle>
              {escrow.projectDescription && (
                <p className="text-sm text-muted-foreground mb-2">
                  {escrow.projectDescription}
                </p>
              )}
              <div className="flex items-center gap-4 text-sm text-gray-600">
                <div className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  <span>
                    {Math.round(escrow.duration / (24 * 60 * 60))} days
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <DollarSign className="h-4 w-4" />
                  <span>
                    {formatTokenAmount(escrow.totalAmount, escrow.token)}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                className={getStatusColor(displayStatus)}
              >
                {displayStatus}
              </Badge>
              {/* Message Freelancer — visible to client only once a real freelancer
                  is assigned. `escrow.beneficiary` is truthy even for the zero
                  address on genuinely unassigned open jobs, so that alone isn't
                  enough — it made the button appear and "message" 0x0. */}
              {escrow.isClient &&
                escrow.beneficiary &&
                escrow.beneficiary !== "0x0000000000000000000000000000000000000000" &&
                wallet.address &&
                isApiConfigured() && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => setChatOpen(true)}
                  title="Message freelancer"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  Message
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onToggleExpanded(escrow.id)}
                className="cursor-pointer"
              >
                {expandedEscrow === escrow.id ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-sm mb-2">
                <span>Progress</span>
                <span>
                  {completedMilestones}/{totalMilestones} milestones
                </span>
              </div>
              <Progress value={progressPercentage} className="h-2" />
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-gray-600">Total Amount:</span>
                <div className="font-semibold">
                  {formatTokenAmount(escrow.totalAmount, escrow.token)}
                </div>
              </div>
              <div>
                <span className="text-gray-600">Released:</span>
                <div className="font-semibold">
                  {formatTokenAmount(escrow.releasedAmount, escrow.token)}
                </div>
              </div>
              {(escrow.status === "pending" || escrow.status === "active") && (
                <div>
                  <span className="text-gray-600">Days Left:</span>
                  <div className="font-semibold flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    {(() => {
                      const daysLeft = calculateDaysLeft(
                        escrow.createdAt,
                        escrow.duration
                      );
                      const message = getDaysLeftMessage(daysLeft);
                      return (
                        <span className={message.color}>{message.text}</span>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* ── Surplus funds warning banner (client only) ──────────────────── */}
            {hasSurplus && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-400/50 bg-amber-50/80 dark:bg-amber-900/20 dark:border-amber-500/40 px-4 py-3 text-sm">
                <div className="flex items-start gap-2 flex-1">
                  <CircleDollarSign className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-800 dark:text-amber-300">
                      {formatTokenAmount(surplusAmount.toFixed(0), escrow.token)}{" "}
                      {isCancelableJob ? "surplus funds" : "surplus funds stuck"}
                    </p>
                    <p className="text-amber-700 dark:text-amber-400 text-xs mt-0.5">
                      {isCancelableJob
                        ? "No freelancer is assigned yet — cancel this job below to get all of it back instantly, instead of waiting on the emergency refund window."
                        : `Extra funds were added above milestone amounts. They cannot be released until the emergency refund window opens (${canEmergencyRefund ? "now available" : `available ${emergencyAvailableDate}`}).`}
                    </p>
                  </div>
                </div>
                {canEmergencyRefund && onReclaimSurplus && !isCancelableJob && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-500 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap shrink-0"
                    onClick={() => onReclaimSurplus(escrow.id)}
                    disabled={reclaimingFunds}
                  >
                    {reclaimingFunds ? (
                      <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Reclaiming…</>
                    ) : (
                      "Reclaim Surplus"
                    )}
                  </Button>
                )}

              </div>
            )}

            {/* Archive / Unarchive — settled escrows */}
            {isSettled && (
              <div className="flex justify-end">
                {onUnarchive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground gap-1.5"
                    onClick={() => onUnarchive(escrow.id)}
                    title="Restore to dashboard"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Unarchive
                  </Button>
                ) : onArchive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground gap-1.5"
                    onClick={() => onArchive(escrow.id)}
                    title="Hide this escrow from your dashboard"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </Button>
                ) : null}
              </div>
            )}

            {expandedEscrow === escrow.id && (
              <div className="space-y-4 pt-4 border-t">
                <div className="space-y-2">
                  <h4 className="font-medium">Milestones:</h4>
                  {escrow.milestones.map((milestone, idx) => (
                    <div
                      key={idx}
                      className="flex flex-col gap-3 p-3 bg-muted/20 rounded-lg border border-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          {(() => {
                            const { body, attachment } = parseAttachment(milestone.description ?? "");
                            // `requirements` is set at creation and never overwritten.
                            // Fall back to `originalDescription` (old-contract cache) then body.
                            const requirementsText =
                              milestone.requirements || milestone.originalDescription || body;
                            const hasSubmissionResponse =
                              milestone.description &&
                              milestone.status !== "pending" &&
                              (milestone.requirements
                                ? true
                                : milestone.originalDescription
                                  ? milestone.description !== milestone.originalDescription
                                  : false);
                            const requirements = requirementsText;
                            return (
                              <>
                                <p className="text-xs text-muted-foreground font-medium">
                                  Requirements:
                                </p>
                                <p className="text-sm font-medium whitespace-pre-wrap break-words">
                                  {requirements}
                                </p>
                                {hasSubmissionResponse && (
                                  <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800">
                                    <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                                      Submission Response:
                                    </p>
                                    <p className="text-sm text-blue-800 dark:text-blue-200 whitespace-pre-wrap break-words mt-1">
                                      {body}
                                    </p>
                                  </div>
                                )}
                                {attachment && (
                                  <a
                                    href={attachment.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 mt-1 text-xs text-primary hover:underline"
                                  >
                                    <Paperclip className="h-3 w-3 shrink-0" />
                                    {attachment.name}
                                  </a>
                                )}
                              </>
                            );
                          })()}
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatTokenAmount(milestone.amount, escrow.token)}
                          </p>
                        </div>
                        <Badge
                          className={getMilestoneStatusColor(milestone.status)}
                        >
                          {milestone.status}
                        </Badge>
                      </div>
                      
                      {/* Milestone Actions - Now vertical */}
                      <MilestoneActions
                        escrowId={escrow.id}
                        milestoneIndex={idx}
                        milestone={milestone}
                        isPayer={escrow.isClient || false}
                        isBeneficiary={escrow.isFreelancer || false}
                        escrowStatus={escrow.status}
                        allMilestones={escrow.milestones}
                        showSubmitButton={false} // Hide submit buttons on dashboard
                        payerAddress={escrow.payer} // Client address for notifications
                        beneficiaryAddress={escrow.beneficiary} // Freelancer address for notifications
                        escrowReleasedAmount={escrow.releasedAmount}
                        escrowTotalAmount={escrow.totalAmount}
                        onSuccess={async () => {
                          // Refresh the escrow data
                          window.dispatchEvent(
                            new CustomEvent("escrowUpdated")
                          );
                          // Wait a moment for blockchain state to update
                          await new Promise((resolve) =>
                            setTimeout(resolve, 2000)
                          );
                          // Trigger refresh without reloading the page
                          // The parent component should listen to the event and refresh
                        }}
                      />
                      
                      {/* Evidence buttons for disputed milestones */}
                      {milestone.status === "disputed" && (
                        <div className="mt-2 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg border border-orange-200 dark:border-orange-800">
                          <div className="flex items-center gap-2 mb-2">
                            <AlertTriangle className="h-4 w-4 text-orange-600" />
                            <span className="text-sm font-medium text-orange-700 dark:text-orange-300">
                              Milestone Under Dispute
                            </span>
                          </div>
                          <p className="text-xs text-orange-600 dark:text-orange-400 mb-3">
                            This milestone is being reviewed by an arbiter. Submit evidence to support your case.
                          </p>
                          <div className="flex flex-col gap-2">
                            <ViewEvidenceButton
                              escrowId={escrow.id}
                              milestoneIndex={idx}
                              clientAddress={escrow.payer}
                              freelancerAddress={escrow.beneficiary}
                              variant="outline"
                              size="sm"
                              className="w-full"
                            />
                            <EvidenceSubmissionButton
                              escrowId={escrow.id}
                              milestoneIndex={idx}
                              onEvidenceSubmitted={() => {
                                toast({
                                  title: "Evidence submitted",
                                  description: "Your evidence has been recorded on-chain",
                                });
                              }}
                              otherPartyAddress={escrow.beneficiary}
                              projectTitle={escrow.projectTitle}
                              variant="default"
                              size="sm"
                              className="w-full"
                            />
                          </div>
                        </div>
                      )}
                      
                      {/* Milestone Negotiation Component - Shows proposal review UI for clients */}
                      <MilestoneNegotiation
                        escrowId={escrow.id}
                        milestoneIndex={idx}
                        milestone={milestone}
                        isFreelancer={false}
                        isClient={escrow.isClient || false}
                        totalBudget={escrow.totalAmount}
                        onUpdate={() => {
                          window.dispatchEvent(new CustomEvent("escrowUpdated"));
                        }}
                      />
                    </div>
                  ))}
                </div>

                {/* Job Management Component - Only shows for open jobs */}
                <JobManagement
                  escrowId={escrow.id}
                  isOpenJob={!escrow.beneficiary || escrow.beneficiary === "0x0000000000000000000000000000000000000000"}
                  isClient={escrow.isClient || false}
                  totalAmount={escrow.totalAmount}
                  token={escrow.token}
                  projectTitle={escrow.projectTitle}
                  milestones={escrow.milestones.map((m, idx) => ({
                    index: idx,
                    description:
                      m.requirements ||
                      m.originalDescription ||
                      parseAttachment(m.description ?? "").body,
                    amount: m.amount,
                  }))}
                  onUpdate={() => {
                    window.dispatchEvent(new CustomEvent("escrowUpdated"));
                  }}
                />
              </div>
            )}

            {/* Overdue actions — visible to BOTH client and freelancer */}
            {isOverdue && isActive && !isSettled && (escrow.isClient || escrow.isFreelancer) && (
              <div className="mt-4 pt-4 border-t border-orange-200 dark:border-orange-800 space-y-3">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-700">
                  <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-orange-700 dark:text-orange-400">
                      Project deadline has passed
                    </p>
                    <p className="text-orange-600/80 dark:text-orange-400/70 text-xs mt-0.5">
                      {escrow.isClient
                        ? escrow.status === "pending"
                          ? "No freelancer has been assigned yet. Cancel this job below to get your full funds back instantly, or extend the deadline to keep the listing open."
                          : "You may extend the deadline to give the freelancer more time, or raise a dispute for arbiter review."
                        : "If the client is unresponsive, you can raise a dispute so an arbiter reviews the situation fairly."}
                    </p>
                  </div>
                </div>

                {/* Client: extend with custom days */}
                {escrow.isClient && onExtendDeadline && (
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label className="text-xs mb-1 block text-muted-foreground">
                        Extend by (days)
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        max={90}
                        placeholder="e.g. 7"
                        value={customDays}
                        onChange={(e) => setCustomDays(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 shrink-0"
                      disabled={!customDays || Number(customDays) < 1}
                      onClick={() => {
                        const days = parseInt(customDays, 10);
                        if (days > 0) {
                          onExtendDeadline(escrow.id, days);
                          setCustomDays("");
                        }
                      }}
                    >
                      <CalendarPlus className="h-3.5 w-3.5" />
                      Extend
                    </Button>
                  </div>
                )}

                {/* Both: request arbitration — not applicable for pending jobs (no freelancer assigned) */}
                {onRaiseOverdueDispute && escrow.status !== "pending" && (
                  <div>
                    {!showDisputeForm ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 w-full border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                        onClick={() => setShowDisputeForm(true)}
                      >
                        <Scale className="h-3.5 w-3.5" />
                        Request Arbitration
                      </Button>
                    ) : (
                      <div className="space-y-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700">
                        <p className="text-xs font-medium text-red-700 dark:text-red-400">
                          State your case — arbiters will review both sides
                        </p>
                        <Textarea
                          rows={3}
                          placeholder="Describe the situation clearly — what work was done, what's missing, and what outcome you're requesting..."
                          value={disputeReason}
                          onChange={(e) => setDisputeReason(e.target.value)}
                          className="text-sm"
                        />
                        <div className="flex gap-2 justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setShowDisputeForm(false);
                              setDisputeReason("");
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={!disputeReason.trim()}
                            onClick={() => {
                              onRaiseOverdueDispute(escrow.id, disputeReason);
                              setShowDisputeForm(false);
                              setDisputeReason("");
                            }}
                          >
                            Submit to Arbiters
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Rating Section for Completed Escrows - Hide for disputed/resolved projects */}
            {escrow.status === "completed" && escrow.isClient && !hasResolvedDispute && (
              <div className="mt-4 pt-4 border-t">
                {hasRating ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                      <span className="font-medium">
                        Your Rating: {existingRating?.rating}/5
                      </span>
                    </div>
                    {existingRating?.review && (
                      <div className="bg-muted/20 rounded-lg p-3 text-sm">
                        {existingRating.review}
                      </div>
                    )}
                  </div>
                ) : (
                  <Button
                    onClick={() => setShowRatingDialog(true)}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <Star className="h-4 w-4 mr-2" />
                    Rate Freelancer
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chat Dialog */}
      {chatOpen && escrow.beneficiary && wallet.address && (
        <ChatDialog
          open={chatOpen}
          onOpenChange={setChatOpen}
          myAddress={wallet.address}
          otherAddress={escrow.beneficiary}
        />
      )}

      {/* Rating Dialog */}
      {escrow.status === "completed" && escrow.beneficiary && (
        <RatingDialog
          open={showRatingDialog}
          onOpenChange={setShowRatingDialog}
          escrowId={Number.parseInt(escrow.id, 10)}
          freelancerAddress={escrow.beneficiary}
          onRatingSubmitted={async () => {
            setHasRating(true);
            // Refresh rating data for this escrow only
            try {
              const r: any = await contractService.getRating(
                Number.parseInt(escrow.id, 10),
                wallet.address || undefined
              );
              if (r && r.score) {
                setExistingRating({ rating: r.score, review: r.review || "" });
              }
            } catch (error) {
            }
          }}
        />
      )}
    </motion.div>
  );
}

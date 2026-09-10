import { useCallback, useEffect, useState } from "react";
import { useWriteContract } from "wagmi";
import { Sprout, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useWeb3 } from "@/contexts/web3-context";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * THE CLIENT'S DECISION TO PUT THEIR OWN ESCROW TO WORK.
 *
 * Escrowed money sits still between funding and approval — often for weeks —
 * and the yield it can earn in that time is what pays the platform fee. The
 * client's fee is covered first, the freelancer takes the larger share of what
 * is left, and the platform takes the remainder. If the job goes to arbitration
 * the platform takes all of it, because at that point somebody has to pay for
 * the arbiters and it should not be either of the two people arguing.
 *
 * WHY THIS IS A SWITCH AND NOT A DEFAULT
 *
 * It is the depositor's capital at risk, so it is the depositor's call; the
 * contract enforces that and this is just the surface. A vault that quietly
 * lends out somebody else's escrow is the thing every objection to this feature
 * is actually about, and the answer is that we never do it without being asked.
 *
 * WHY IT HIDES ITSELF
 *
 * `available` is false unless the escrow names a controller AND that controller
 * has a venue for this escrow's token. Offering the switch without both would
 * be offering a control that does nothing — which is precisely what happened to
 * the Earning badge: it read a number nothing in the app could ever set, so it
 * was invisible on every job and no test noticed.
 */
export function YieldOptIn({
  escrowId,
  isClient,
  status,
  onDone,
}: {
  escrowId: number;
  isClient: boolean;
  status: string;
  onDone?: () => void;
}) {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const [state, setState] = useState<{
    available: boolean;
    optedIn: boolean;
    deployed: bigint;
    freelancerShareBP: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    let live = true;
    new ContractService(CONTRACTS.ATELIER_ESCROW)
      .getYieldStatus(escrowId)
      .then((s) => { if (live) setState(s); })
      .catch(() => {});
    return () => { live = false; };
  }, [escrowId]);

  useEffect(() => refresh(), [refresh]);

  /* Settled jobs have nothing left to invest, and the freelancer is not the one
     whose money this is. */
  const settled = status === "completed" || status === "cancelled";
  if (!isClient || settled || !state?.available) return null;

  const share = state.freelancerShareBP
    ? `${Math.round(state.freelancerShareBP / 100)}%`
    : "the larger share";

  async function toggle(next: boolean) {
    if (!wallet?.isConnected) {
      toast({ title: "Connect your wallet first", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await new ContractService(CONTRACTS.ATELIER_ESCROW).setYieldOptIn(
        escrowId,
        next,
        writeContractAsync,
      );
      // Optimistic, then reconciled against the chain by refresh().
      setState((s) => (s ? { ...s, optedIn: next } : s));
      toast({
        title: next ? "This escrow will earn while it waits" : "Investing switched off",
        description: next
          ? "Only the genuinely idle portion is ever deployed. Your next milestone payment always stays in cash."
          : "Anything currently deployed is withdrawn at the next payout.",
      });
      refresh();
      onDone?.();
    } catch (err: unknown) {
      toast({
        title: "Could not change that",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex items-start justify-between gap-4 rounded-lg border border-[var(--actor-border)] bg-muted/20 p-3"
      data-testid="yield-opt-in"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-medium">
          <Sprout className="h-4 w-4" aria-hidden="true" />
          Put idle escrow to work
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          While this job runs, the part of your escrow that no milestone can claim
          yet earns in a stable position. What it earns covers your platform fee
          first; {share} of anything beyond that goes to the freelancer.
        </p>
        {state.deployed > 0n && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="yield-deployed">
            ${(Number(state.deployed) / 1e6).toFixed(2)} is out earning right now.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        <Switch
          checked={state.optedIn}
          disabled={busy}
          onCheckedChange={toggle}
          aria-label="Put idle escrow to work"
          data-testid="yield-switch"
        />
      </div>
    </div>
  );
}

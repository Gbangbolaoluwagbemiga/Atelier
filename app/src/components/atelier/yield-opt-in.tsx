import { useEffect, useState } from "react";
import { Sprout } from "lucide-react";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * WHAT THIS JOB'S ESCROW DOES WHILE IT WAITS — stated, not adjustable.
 *
 * This was a switch. That was the bug: the yield share is a term of the job,
 * and a freelancer applies partly because of it. A client able to flip it off
 * after hiring would be changing the deal after the other side accepted, with
 * no recourse and probably no notice.
 *
 * The choice now happens once, on the posting screen, and the contract refuses
 * to let it change once anybody is hired — see AtelierYield.setYieldOptIn and
 * components/create/yield-choice.tsx. What is left here is the statement of
 * what was agreed, which both sides can read and neither can move.
 *
 * It renders nothing when the escrow does not earn, rather than showing an
 * "off" state. There is nothing to tell someone about a job that behaves
 * exactly like every other job.
 */
export function YieldOptIn({
  escrowId,
  status,
}: {
  escrowId: number;
  /* Kept in the signature because callers pass it and a settled job has
     nothing left to say about what its escrow is doing. */
  status?: string;
  isClient?: boolean;
  onDone?: () => void;
}) {
  const [state, setState] = useState<{
    optedIn: boolean;
    deployed: bigint;
    freelancerShareBP: number;
  } | null>(null);

  useEffect(() => {
    let live = true;
    new ContractService(CONTRACTS.ATELIER_ESCROW)
      .getYieldStatus(escrowId)
      .then((s) => { if (live) setState(s); })
      .catch(() => {});
    return () => { live = false; };
  }, [escrowId]);

  if (!state?.optedIn) return null;
  if (status === "completed" || status === "cancelled") return null;

  const share = state.freelancerShareBP
    ? `${Math.round(state.freelancerShareBP / 100)}%`
    : "the larger share";

  return (
    <div
      className="rounded-lg border border-[var(--actor-border)] bg-muted/20 p-3"
      data-testid="yield-status"
    >
      <div className="flex items-center gap-2 font-medium">
        <Sprout className="h-4 w-4" aria-hidden="true" />
        This escrow earns while the job runs
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The part of the budget no milestone can claim yet is invested. What it
        earns covers the platform fee first; {share} of anything beyond that goes
        to the freelancer. Agreed when the job was posted and fixed since.
      </p>
      {state.deployed > 0n && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="yield-deployed">
          ${(Number(state.deployed) / 1e6).toFixed(2)} is out earning right now.
        </p>
      )}
    </div>
  );
}

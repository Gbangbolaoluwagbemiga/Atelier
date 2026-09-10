import { useEffect, useState } from "react";
import { Sprout } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";

/**
 * "🌱 Escrow yield" — a chip, with the explanation on hover.
 *
 * WHY THIS IS FOUR WORDS AND NOT A PARAGRAPH
 *
 * It was a paragraph, sitting in its own bordered box in the middle of the
 * card, restating the whole mechanism to a client who had already agreed to it
 * when they posted the job. Every job carried it, so every card was longer, and
 * the things a client actually opens a card for — what is owed, what is
 * submitted, what needs approving — were pushed further down.
 *
 * A standing fact about a job is not news, and news is what earns vertical
 * space. The chip says the fact; the tooltip holds the detail for the one
 * reading in ten who wants it.
 *
 * The pattern is deliberately {@link AutopilotBadge}'s, down to the delay and
 * the `cursor-help`: these two chips answer the same shape of question about
 * the same card, and the reader should not have to learn two idioms.
 *
 * It renders nothing on a job that does not earn — an "off" state would be
 * chrome describing the absence of a feature.
 */
export function YieldOptIn({
  escrowId,
  status,
}: {
  escrowId: number;
  /* A settled job has nothing left to say about what its escrow is doing. */
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
      .then((next) => { if (live) setState(next); })
      .catch(() => {});
    return () => { live = false; };
  }, [escrowId]);

  if (!state?.optedIn) return null;
  if (status === "completed" || status === "cancelled") return null;

  const share = state.freelancerShareBP
    ? `${Math.round(state.freelancerShareBP / 100)}%`
    : "the larger share";
  const deployed = state.deployed > 0n
    ? `$${(Number(state.deployed) / 1e6).toFixed(2)}`
    : null;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500 cursor-help"
            aria-label="This escrow earns while the job runs"
            data-testid="yield-status"
          >
            {/* Breathes, because the escrow is working right now — see
                .yield-live in index.css. Holds still under
                prefers-reduced-motion. */}
            <Sprout className="h-3.5 w-3.5 text-emerald-500 yield-live" aria-hidden="true" />
            Escrow yield
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">This escrow earns while the job runs.</p>
          <p className="text-xs mt-1.5 leading-relaxed">
            The part of the budget no milestone can claim yet is invested. What
            it earns covers the platform fee first; {share} of anything beyond
            that goes to the freelancer.
          </p>
          <p className="text-xs mt-1.5 leading-relaxed">
            Agreed when the job was posted and fixed since — it cannot be turned
            off once someone is hired.
          </p>
          {deployed && (
            <p className="text-xs mt-1.5 font-medium" data-testid="yield-deployed">
              {deployed} is out earning right now.
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

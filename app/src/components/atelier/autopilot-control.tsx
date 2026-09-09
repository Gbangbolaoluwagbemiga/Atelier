/**
 * WHO IS RUNNING THIS JOB — and the one click that changes the answer.
 *
 * Shown to a client on their own job. Never to a freelancer: a worker must not
 * be able to tell whether their client is a person or an agent, and this
 * component would announce it in amber. `lib/atelier/actor.ts` explains why that
 * matters; the guard is that this is only mounted inside the client's own area.
 *
 * The design job here is to make handing over control feel reversible, because
 * it is. The revoke button is not hidden behind a confirmation or a settings
 * page — it sits next to the delegation, same size, always available. A client
 * who can see the exit is much more likely to try the thing at all.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { Bot, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useJobManager } from "@/hooks/use-job-manager";
import { AUTOPILOT_CONFIGURED } from "@/lib/atelier/agent-api";
import { toastError } from "@/lib/atelier/errors";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function AutopilotControl({
  escrowId,
  /** Hide entirely when the connected wallet is not this job's client. */
  isClient,
}: {
  escrowId: number;
  isClient: boolean;
}) {
  const { manager, loaded, busy, delegate, revoke } = useJobManager(escrowId);
  const { toast } = useToast();
  const [pending, setPending] = useState<"delegate" | "revoke" | null>(null);

  if (!isClient) return null;

  const onDelegate = async () => {
    setPending("delegate");
    try {
      await delegate();
      toast({
        title: "Autopilot is running this job",
        description:
          "It can hire, review and pay. It can never move your money elsewhere, and disputes stay yours.",
      });
    } catch (e) {
      toast(toastError("Could not hand over the job", e));
    } finally {
      setPending(null);
    }
  };

  const onRevoke = async () => {
    setPending("revoke");
    try {
      await revoke();
      toast({
        title: "You are running this job again",
        description: "Autopilot's next action on it will be rejected on-chain.",
      });
    } catch (e) {
      toast(toastError("Could not take back control", e));
    } finally {
      setPending(null);
    }
  };

  /* `manager === null` is a real answer, so it must not be rendered until we
     actually know — otherwise every Autopilot job flashes "managed by you"
     first, which is the one wrong thing to say about it. */
  if (!loaded) {
    return (
      <div className="rounded-xl glass p-4 flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking who manages this job…
      </div>
    );
  }

  const onAutopilot = manager !== null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`${onAutopilot ? "actor-agent" : "actor-human"} rounded-xl actor-panel p-4 sm:p-5`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="actor-chip">
            <span className="actor-dot" />
            {onAutopilot ? "Autopilot" : "You"}
          </span>

          <h3 className="font-display text-lg font-semibold mt-2.5 actor-text">
            {onAutopilot ? "Autopilot is running this job" : "You are running this job"}
          </h3>

          <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed max-w-prose">
            {onAutopilot ? (
              <>
                It briefs, hires, reviews and releases payment as{" "}
                <span className="font-mono text-xs">
                  {shortAddress(manager)}
                </span>
                . It cannot move your money anywhere else, and it cannot settle
                a dispute — if it runs out of revision rounds it hands the job
                to a human arbiter, exactly as you or the freelancer could.
              </>
            ) : (
              "You write the brief, choose the freelancer, and approve each milestone yourself."
            )}
          </p>
        </div>

        <Button
          variant={onAutopilot ? "outline" : "default"}
          onClick={onAutopilot ? onRevoke : onDelegate}
          disabled={busy || (!onAutopilot && !AUTOPILOT_CONFIGURED)}
          className={
            onAutopilot
              ? "shrink-0"
              : "shrink-0 bg-[var(--actor-agent)] text-[var(--actor-agent-fg)] hover:bg-[var(--actor-agent)] hover:opacity-90"
          }
        >
          {pending !== null && (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
          )}
          {pending === null &&
            (onAutopilot ? (
              <User className="h-4 w-4 mr-2" aria-hidden="true" />
            ) : (
              <Bot className="h-4 w-4 mr-2" aria-hidden="true" />
            ))}
          {onAutopilot ? "Take back control" : "Hand to Autopilot"}
        </Button>
      </div>

      {!onAutopilot && !AUTOPILOT_CONFIGURED && (
        <p className="text-xs text-muted-foreground mt-3">
          Autopilot is not configured for this deployment.
        </p>
      )}
    </motion.div>
  );
}

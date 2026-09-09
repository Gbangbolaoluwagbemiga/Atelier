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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AUTOPILOT_CONFIGURED } from "@/lib/atelier/agent-api";
import { toastError } from "@/lib/atelier/errors";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * The acceptance criteria written into the escrow at funding time.
 *
 * A job posted through Autopilot puts them there; a job created by hand puts
 * only the client's free text. That difference decides whether the agent reads
 * back criteria the client approved or invents its own, so it has to be visible
 * before the client signs, not discovered afterwards.
 */
function criteriaIn(description: string | undefined): string[] {
  if (!description) return [];
  const marker = description.indexOf("Acceptance criteria:");
  if (marker === -1) return [];
  return description
    .slice(marker)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•"))
    .map((line) => line.replace(/^•\s*/, ""));
}

export function AutopilotControl({
  escrowId,
  /** Hide entirely when the connected wallet is not this job's client. */
  isClient,
  projectDescription,
  milestones,
}: {
  escrowId: number;
  isClient: boolean;
  /** What is actually stored on-chain — the only thing the agent can read. */
  projectDescription?: string;
  milestones?: Array<{ description: string; amount: string }>;
}) {
  const { manager, loaded, busy, delegate, revoke } = useJobManager(escrowId);
  const { toast } = useToast();
  const [pending, setPending] = useState<"delegate" | "revoke" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const criteria = criteriaIn(projectDescription);

  // Below every hook, so the guard cannot change how many run.
  if (!isClient) return null;

  const onDelegate = async () => {
    setConfirming(false);
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
          onClick={onAutopilot ? onRevoke : () => setConfirming(true)}
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

      {/*
        Show what the agent will actually work from, before the signature.
        Handing over is one transaction that names an address; everything the
        agent then does, it decides from what is already stored on-chain. A
        client who has not seen that is approving a standard they have not read.
      */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Hand this job to Autopilot?</AlertDialogTitle>
            <AlertDialogDescription>
              It will hire, review and release payment against what is written
              below — the only thing it can read. You keep the money, the dispute
              right, and the ability to take the job back at any moment.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 text-sm max-h-[45vh] overflow-y-auto">
            {milestones && milestones.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                  It pays out in these stages
                </div>
                <ul className="space-y-1">
                  {milestones.map((m, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-mono text-xs shrink-0 actor-text">
                        ${(Number(m.amount) / 1e6).toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">{m.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                It approves or rejects against
              </div>
              {criteria.length > 0 ? (
                <ul className="space-y-1 text-muted-foreground">
                  {criteria.map((c, i) => (
                    <li key={i}>• {c}</li>
                  ))}
                </ul>
              ) : (
                /*
                 * The honest case, and the reason this dialog exists. A job
                 * created by hand stores only free text, so there are no agreed
                 * criteria for the agent to read and it will derive its own
                 * from the description. Say so rather than letting the client
                 * find out when work is rejected against a standard they never
                 * wrote.
                 */
                <p className="text-muted-foreground">
                  This job has no acceptance criteria written into it — jobs
                  posted through Autopilot store them, jobs created by hand do
                  not. The agent will work them out from your description, so it
                  may judge against wording you have not seen. You can take the
                  job back at any point.
                </p>
              )}
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDelegate()}>
              Hand it over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}

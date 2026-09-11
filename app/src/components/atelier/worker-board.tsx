/**
 * The board a managed worker sees: open jobs, their own work, and their money.
 *
 * Deliberately NOT the same component as Browse Jobs. That page is for someone
 * with a wallet who signs their own transactions; this one is for someone who
 * has never held a private key and applies with a button. Sharing a component
 * across those two would mean branching on wallet mode inside every action, and
 * the branch would eventually leak into the copy.
 *
 * What is shared is the rule: a worker never learns whether their client is a
 * person or an agent. Nothing here reads client mode, and the board must stay
 * that way — see lib/atelier/actor.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Send, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/atelier/errors";
import {
  apply,
  me as fetchMe,
  minutesUntilClose,
  myWork,
  quests as fetchQuests,
  submit as submitWork,
  deliveryTarget,
  type DeliveryTarget,
  withdraw,
  type Quest,
  type Worker,
  type WorkItem,
} from "@/lib/atelier/worker";

export function WorkerBoard({
  worker,
  onWorkerChanged,
}: {
  worker: Worker;
  onWorkerChanged: (w: Worker) => void;
}) {
  const { toast } = useToast();
  const [quests, setQuests] = useState<Quest[]>([]);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [applyingTo, setApplyingTo] = useState<string | null>(null);
  const [coverLetter, setCoverLetter] = useState("");
  const [busy, setBusy] = useState(false);

  /* Delivering finished work. The row used to say "You were hired — send your
     work" and offer no way to send it: the endpoint and the client call both
     existed, the board simply never wired them up, so a hired freelancer's only
     route to delivering was the Telegram bot. */
  const [deliveringTo, setDeliveringTo] = useState<string | null>(null);
  const [delivery, setDelivery] = useState("");

  /* What the stage is and what it will be marked against. Loaded when the box
     opens rather than for every row: it is a chain read per job, and most
     viewings of this board never open one. */
  const [target, setTarget] = useState<DeliveryTarget | null>(null);

  function openDelivery(escrowId: string) {
    setDeliveringTo(escrowId);
    setTarget(null);
    void deliveryTarget(escrowId)
      .then(setTarget)
      .catch(() => {
        /* Left null: the box still submits, and the daemon still resolves the
           stage. Better to deliver without the detail than not at all. */
      });
  }

  function closeDelivery() {
    setDeliveringTo(null);
    setDelivery("");
    setTarget(null);
  }

  const refresh = useCallback(async () => {
    try {
      const [q, w, m] = await Promise.all([
        fetchQuests(worker.id),
        myWork(worker.id),
        fetchMe(worker.id),
      ]);
      setQuests(q);
      setWork(w);
      onWorkerChanged(m);
    } catch {
      /* Left silent on purpose: this polls, and a toast every few seconds
         because the daemon blinked would be worse than a stale board. */
    } finally {
      setLoading(false);
    }
  }, [worker.id, onWorkerChanged]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function sendDelivery(escrowId: string) {
    setBusy(true);
    try {
      /* No milestoneIndex on purpose — the daemon resolves which stage actually
         needs delivering. Hard-coding 0 filed a second milestone's work
         against the first. */
      await submitWork({ workerId: worker.id, escrowId, description: delivery.trim() });
      toast({
        title: "Work submitted",
        description:
          "It is on-chain and waiting on review. You will hear as soon as the milestone is approved and paid.",
      });
      closeDelivery();
      await refresh();
    } catch (e) {
      toast(toastError("Could not submit your work", e));
    } finally {
      setBusy(false);
    }
  }

  async function sendApplication(escrowId: string) {
    setBusy(true);
    try {
      await apply({
        workerId: worker.id,
        escrowId,
        coverLetter: coverLetter.trim(),
      });
      toast({
        title: "Application sent",
        description: "Autopilot scores every applicant together when the window closes.",
      });
      setApplyingTo(null);
      setCoverLetter("");
      void refresh();
    } catch (e) {
      toast(toastError("Could not send that application", e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading the board…
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <Earnings worker={worker} onWithdrawn={() => void refresh()} />

      {work.length > 0 && (
        <section>
          <h2 className="font-display text-2xl font-semibold">Your work</h2>
          <div className="space-y-3 mt-4">
            {work.map((w) => (
              <div key={w.escrowId} className="rounded-xl glass p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{w.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {w.icon} {w.status}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="actor-figure figure-md">${w.budget}</span>
                    {w.state === "hired" && w.canSubmit !== false && deliveringTo !== w.escrowId && (
                      <Button size="sm" onClick={() => openDelivery(w.escrowId)}>
                        <Send className="h-4 w-4 mr-2" aria-hidden="true" />
                        Send work
                      </Button>
                    )}
                  </div>
                </div>

                {/*
                  WHO IS HOLDING THIS, AND ROUGHLY FOR HOW LONG.

                  A freelancer waiting on a verdict cannot tell an agent that
                  answers in minutes from a client who answers when they next
                  open the tab — both look like silence. The wait is the same
                  either way; the worry is not.
                */}
                {(w.awaitingReview ?? 0) > 0 && deliveringTo !== w.escrowId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {w.awaitingReview === 1
                      ? "One stage is with the reviewer."
                      : `${w.awaitingReview} stages are with the reviewer.`}{" "}
                    {w.reviewer === "agent"
                      ? "Autopilot is reviewing — that usually takes a few minutes."
                      : w.reviewer === "client"
                        ? "The client reviews this one themselves, so it can take longer than an agent would."
                        : "You will hear as soon as it is decided."}{" "}
                    The next stage opens once this one is decided.
                  </p>
                )}

                {/* Sent back. The one state where doing nothing is the wrong move. */}
                {(w.needsRevision ?? 0) > 0 && (w.awaitingReview ?? 0) === 0 && deliveringTo !== w.escrowId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Your last delivery was sent back with feedback. Open{" "}
                    <span className="text-foreground">Send work</span> to read it
                    and resend — the money is still locked in escrow for you.
                  </p>
                )}

                {w.state === "hired" && w.canSubmit !== false && deliveringTo === w.escrowId && (
                  <div className="mt-4 space-y-3">
                    {/*
                      WHICH STAGE, AND WHAT IT HAS TO MEET.

                      This box used to be a bare textarea. On a two-stage job it
                      silently chose a milestone for you, and on an agent-run job
                      a machine then approved or rejected what you wrote against
                      criteria you had never been shown.
                    */}
                    {target && (
                      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                              {target.count > 1
                                ? `Milestone ${target.index + 1} of ${target.count}`
                                : "This job pays in one stage"}
                            </div>
                            {target.description && (
                              <p className="text-sm mt-1 wrap-break-word">
                                {target.description}
                              </p>
                            )}
                          </div>
                          {target.amountUsdc !== null && (
                            <span className="actor-figure figure-sm shrink-0">
                              ${target.amountUsdc}
                            </span>
                          )}
                        </div>

                        {/* What was wrong last time — written by the reviewer,
                            and never shown to the person asked to fix it. */}
                        {target.previousFeedback && (
                          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                            <div className="text-xs uppercase tracking-wide mb-1">
                              Why this came back
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {target.previousFeedback}
                            </p>
                          </div>
                        )}

                        {target.criteria.length > 0 && (
                          <div>
                            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                              {target.agentReviewed
                                ? "An agent approves or rejects against"
                                : "The client is looking for"}
                            </div>
                            <ul className="space-y-1">
                              {target.criteria.map((c, i) => (
                                <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                                  <span className="actor-dot mt-1" aria-hidden="true" />
                                  <span className="min-w-0">{c}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {target.count > 1 && (
                          <p className="text-xs text-muted-foreground">
                            Only this stage is being delivered. The rest stay
                            funded and are sent separately.
                          </p>
                        )}
                      </div>
                    )}

                    <Label htmlFor={`wk-${w.escrowId}`} className="text-xs">
                      What did you deliver?
                    </Label>
                    <Textarea
                      id={`wk-${w.escrowId}`}
                      rows={3}
                      value={delivery}
                      onChange={(e) => setDelivery(e.target.value)}
                      placeholder="Describe what you produced and where it is — a link, a file, a repo. This is what gets reviewed against the job's criteria."
                      className="text-sm resize-none"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={closeDelivery}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void sendDelivery(w.escrowId)}
                        disabled={busy || delivery.trim().length === 0}
                      >
                        {busy && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                        )}
                        Submit for review
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-display text-2xl font-semibold">Open jobs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Apply with a sentence. No gas, no signature.
        </p>

        {quests.length === 0 ? (
          <div className="rounded-xl glass p-8 text-center mt-4">
            <p className="text-sm text-muted-foreground">
              Nothing open right now. New jobs appear here as clients post them.
            </p>
          </div>
        ) : (
          <div className="space-y-4 mt-4">
            {quests.map((q) => {
              const mins = minutesUntilClose(q);
              return (
                <div key={q.escrowId} className="rounded-xl glass p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium">{q.title}</h3>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1.5">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {mins > 0
                            ? `closes in ${mins} min`
                            : "judging now"}
                        </span>
                        <span>{q.durationDays} days</span>
                        <span>{q.milestones.length} milestones</span>
                      </div>
                    </div>
                    <span className="actor-figure figure-md shrink-0">
                      ${q.budget}
                    </span>
                  </div>

                  {q.criteria.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {q.criteria.slice(0, 3).map((c, i) => (
                        <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                          <span className="actor-dot mt-1" aria-hidden="true" />
                          <span className="min-w-0">{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {q.applied ? (
                    <p className="text-xs text-muted-foreground mt-4">
                      You have applied. You will hear when the window closes.
                    </p>
                  ) : applyingTo === q.escrowId ? (
                    <div className="mt-4 space-y-2">
                      <Label htmlFor={`cl-${q.escrowId}`} className="text-xs">
                        Why you?
                      </Label>
                      <Textarea
                        id={`cl-${q.escrowId}`}
                        rows={3}
                        value={coverLetter}
                        onChange={(e) => setCoverLetter(e.target.value)}
                        placeholder="Answer the criteria above specifically — Autopilot scores generic applications lower."
                        className="text-sm resize-none"
                      />
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setApplyingTo(null);
                            setCoverLetter("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || coverLetter.trim().length < 10}
                          onClick={() => void sendApplication(q.escrowId)}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          Apply
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-4"
                      onClick={() => setApplyingTo(q.escrowId)}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Earnings, and the button that gets the money out.
 *
 * Withdrawal is given more prominence than the balance itself, on purpose. A
 * managed wallet is a way to start without a wallet, not a place to keep
 * savings, and the interface should keep saying so rather than making custody
 * comfortable.
 */
function Earnings({
  worker,
  onWithdrawn,
}: {
  worker: Worker;
  onWithdrawn: () => void;
}) {
  const { toast } = useToast();
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  /* null means the daemon could not read it, which is not the same as zero.
     Showing 0.00 for an unreadable balance is a wrong number presented as a
     right one, and this is the screen where that matters most. */
  const balanceKnown = worker.balance !== null && worker.balance !== undefined;
  const balance = balanceKnown ? Number(worker.balance) : 0;
  const validDest = /^0x[a-fA-F0-9]{40}$/.test(destination.trim());
  const validAmount = Number(amount) > 0 && Number(amount) <= balance;

  async function send() {
    setBusy(true);
    try {
      await withdraw({
        workerId: worker.id,
        destination: destination.trim(),
        amountUsdc: amount,
      });
      toast({
        title: "Sent",
        description: `${amount} USDC is on its way to your own wallet.`,
      });
      setOpen(false);
      setAmount("");
      setDestination("");
      onWithdrawn();
    } catch (e) {
      toast(toastError("Could not withdraw", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="actor-human rounded-2xl actor-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Earned
          </div>
          <div className="actor-figure figure-lg mt-1">
            {balanceKnown ? `$${balance.toFixed(2)}` : "—"}
            <span className="text-sm font-sans font-medium text-muted-foreground ml-2">
              USDC
            </span>
          </div>
          {!balanceKnown && (
            <p className="text-xs text-muted-foreground mt-1">
              Could not read your balance just now. It is not zero — try again in
              a moment.
            </p>
          )}
          <div className="text-xs text-muted-foreground mt-2 font-mono">
            {worker.address.slice(0, 10)}…{worker.address.slice(-6)}
            {worker.mode === "managed" && " · held for you"}
          </div>
        </div>

        {worker.mode === "managed" && (
          <Button
            variant="outline"
            onClick={() => setOpen((v) => !v)}
            disabled={balance <= 0}
          >
            <Wallet className="h-4 w-4 mr-2" aria-hidden="true" />
            Withdraw
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-5 pt-5 border-t border-border/40 space-y-3">
          <p className="text-sm text-muted-foreground">
            Send to a wallet you control. We hold the keys to this one, so it is
            not somewhere to leave money.
          </p>
          <div className="grid sm:grid-cols-[1fr_8rem] gap-3">
            <div>
              <Label htmlFor="dest" className="text-xs">
                Your address
              </Label>
              <Input
                id="dest"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="0x…"
                className="mt-1.5 font-mono text-sm"
              />
            </div>
            <div>
              <Label htmlFor="amt" className="text-xs">
                USDC
              </Label>
              <Input
                id="amt"
                type="number"
                step="0.01"
                max={balance}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1.5 tabular-nums"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || !validDest || !validAmount}
              onClick={() => void send()}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Send
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

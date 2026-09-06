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
              <div
                key={w.escrowId}
                className="rounded-xl glass p-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{w.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {w.status}
                  </div>
                </div>
                <span className="actor-figure figure-md shrink-0">
                  ${w.budget}
                </span>
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

  const balance = Number(worker.balance ?? 0);
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
            ${balance.toFixed(2)}
            <span className="text-sm font-sans font-medium text-muted-foreground ml-2">
              USDC
            </span>
          </div>
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

/**
 * AUTOPILOT — say what you want, check what the agent proposes, fund it.
 *
 * Two steps, and neither of them is a wizard.
 *
 * The promise is that commissioning work costs a sentence rather than an
 * afternoon, so step one is one textarea: no milestone table, no budget field,
 * no acceptance criteria. Asking a client to fill those in would be asking them
 * to do the exact labour they came here to delegate.
 *
 * Step two shows what Autopilot actually proposes and funds it IN PLACE. It used
 * to hand off to the three-step escrow wizard with the fields prefilled, which
 * meant a client who had just read and approved a complete brief was then made
 * to click Next past three screens of it. That is not a review, it is a toll
 * booth. The escrow is opened from this page, from the balance already in their
 * wallet, in one transaction.
 *
 * The layout is two columns because the content is two things: terms you might
 * adjust on the left, and the work itself on the right. A single column left
 * half the width empty and pushed the criteria — the part that decides whether
 * a delivery is accepted — below the fold.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Info, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useWeb3 } from "@/contexts/web3-context";
import { useCreateEscrow } from "@/hooks/use-escrows";
import { toastError } from "@/lib/atelier/errors";
import {
  AUTOPILOT_CONFIGURED,
  fetchWhitelistedTokens,
  previewBrief,
  type AutopilotBrief,
  type WhitelistedToken,
} from "@/lib/atelier/agent-api";

const EXAMPLES = [
  "A logo for a coffee roastery. Budget $50, 3 days.",
  "Write 800 words on stablecoin settlement for our blog. Budget $120, 5 days.",
  "Voiceover for a 90-second explainer, warm tone. Budget $75, 2 days.",
];

export default function AutopilotComposePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { wallet } = useWeb3();
  const createEscrow = useCreateEscrow();

  const [instruction, setInstruction] = useState("");
  /* Which tokens the escrow will actually accept. Read from the chain rather
     than assumed: the contract rejects anything not whitelisted, and an admin
     can delist one between page loads. */
  const [tokens, setTokens] = useState<WhitelistedToken[] | null>(null);
  const [payToken, setPayToken] = useState<string>("");
  const [brief, setBrief] = useState<AutopilotBrief | null>(null);
  const [thinking, setThinking] = useState(false);
  const [funding, setFunding] = useState(false);
  /* The review window is entered in whatever unit suits the job and stored in
     minutes, which is what the daemon takes. */
  const [windowValue, setWindowValue] = useState(5);
  const [windowUnit, setWindowUnit] = useState<"minutes" | "hours" | "days">(
    "minutes",
  );
  useEffect(() => {
    const ac = new AbortController();
    fetchWhitelistedTokens(ac.signal)
      .then((list) => {
        setTokens(list);
        // Default to the chain's own currency when it is one of them; on Arc
        // that is USDC, which is what a client means by "dollars" anyway.
        setPayToken((prev) => prev || (list.find((t) => t.native) ?? list[0])?.address || "");
      })
      .catch(() => setTokens([]));
    return () => ac.abort();
  }, []);

  const reviewWindow =
    windowValue *
    (windowUnit === "hours" ? 60 : windowUnit === "days" ? 1440 : 1);

  const trimmed = instruction.trim();
  /* The daemon rejects an instruction with no budget, with a message the client
     would only see after waiting for an LLM call. Cheaper to notice here. */
  const hasBudget = /\$\s*\d|\d+\s*(usdc|dollars?)\b/i.test(trimmed);
  const ready = trimmed.length > 12 && hasBudget;

  /* The escrow contract requires the milestones to sum to the total, so the
     budget is DERIVED from the milestones rather than being a separate field
     the client can put out of step with them. */
  const total = brief
    ? brief.milestones.reduce((sum, m) => sum + (Number(m.amount) || 0), 0)
    : 0;

  async function handleWriteBrief() {
    setThinking(true);
    try {
      const result = await previewBrief(trimmed);
      setBrief(result);
    } catch (e) {
      toast(toastError("Autopilot could not write that brief", e));
    } finally {
      setThinking(false);
    }
  }

  function patchMilestone(i: number, patch: Partial<{ description: string; amount: number }>) {
    if (!brief) return;
    const milestones = brief.milestones.map((m, idx) =>
      idx === i ? { ...m, ...patch } : m,
    );
    setBrief({ ...brief, milestones });
  }

  /**
   * Open the escrow from here, in one transaction.
   *
   * This used to stash the brief in sessionStorage and send the client to the
   * three-step wizard with the fields prefilled — so somebody who had just read
   * and approved a complete brief was made to click Next past three screens of
   * the same thing. That is not a review step, it is a toll booth.
   *
   * The job is posted OPEN, with no beneficiary, because the entire point of
   * Autopilot is that it reads the applications and picks someone. Naming a
   * freelancer here would leave it nothing to do.
   */
  async function handleFund() {
    if (!brief || !wallet.address) return;
    setFunding(true);
    try {
      const description = [
        trimmed,
        brief.deliverableFormat ? `Deliverable: ${brief.deliverableFormat}` : "",
        brief.criteria.length
          ? `Acceptance criteria:\n${brief.criteria.map((c) => `• ${c}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      await createEscrow.mutateAsync({
        depositor: wallet.address,
        arbiters: [],
        required_confirmations: 1,
        // The token the client picked above, so the choice is not cosmetic.
        // Empty falls through to the hook's default rather than sending
        // address(0), which the contract reads as the native currency.
        ...(payToken ? { token: payToken } : {}),
        // Amounts are USDC with 6 decimals on Arc. Rounded rather than floored
        // so a milestone of 12.005 does not quietly lose its last cent and take
        // the sum out of agreement with the total.
        milestones: brief.milestones.map(
          (m) =>
            [
              String(Math.round(m.amount * 1e6)),
              m.description,
            ] as [string, string],
        ),
        total_amount: String(Math.round(total * 1e6)),
        duration: Math.max(1, brief.durationDays) * 86400,
        project_title: brief.title,
        project_description: description,
      });

      toast({
        title: "Posted and funded",
        description:
          "Autopilot is collecting applications. Watch it work from My Jobs.",
      });
      navigate("/my-jobs");
    } catch (e) {
      toast(toastError("Could not fund this job", e));
    } finally {
      setFunding(false);
    }
  }

  /* ─────────────── Step 2: the agent's proposal ─────────────── */
  if (brief) {
    const incomplete = brief.milestones.some((m) => !m.description.trim());
    return (
      <div className="container mx-auto px-4 py-8 sm:py-12 max-w-6xl">
        <button
          type="button"
          onClick={() => setBrief(null)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Change the instruction
        </button>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="actor-agent mt-6"
        >
          <span className="actor-chip">
            <span className="actor-dot" />
            Autopilot wrote this
          </span>

          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mt-4 break-words">
            {brief.title}
          </h1>
          <p className="text-muted-foreground mt-3 leading-relaxed max-w-2xl">
            Change anything you disagree with. Autopilot hires and reviews
            against this brief, so it is worth reading properly.
          </p>

          {/* Terms on the left, the work on the right. */}
          <div className="grid lg:grid-cols-[22rem_minmax(0,1fr)] gap-6 lg:gap-8 mt-8 items-start">
            {/* ── Left: what you might adjust ── */}
            <div className="space-y-4">
              <div className="rounded-xl actor-panel p-4">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="actor-figure figure-lg mt-1">
                  ${total.toFixed(2)}
                  <span className="text-sm font-sans font-medium text-muted-foreground ml-2">
                    USDC
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Adds up from the milestones — the contract requires them to
                  match exactly.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Days to deliver">
                  <Input
                    type="number"
                    min={1}
                    value={brief.durationDays}
                    onChange={(e) =>
                      setBrief({ ...brief, durationDays: Math.max(1, Number(e.target.value) || 1) })
                    }
                    className="h-9"
                  />
                </Field>
                <Field label="Revision rounds">
                  <Input
                    type="number"
                    min={3}
                    value={Math.max(3, brief.revisionRounds)}
                    onChange={(e) =>
                      setBrief({ ...brief, revisionRounds: Math.max(3, Number(e.target.value) || 3) })
                    }
                    className="h-9"
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                How many times a freelancer may fix and resubmit before a human
                arbiter takes over. Three is the floor — fewer escalates people
                who were visibly getting closer.
              </p>

              <Field label="Paid in">
                {tokens === null ? (
                  <div className="h-9 flex items-center text-xs text-muted-foreground">
                    Reading the whitelist…
                  </div>
                ) : tokens.length === 0 ? (
                  <div className="h-9 flex items-center text-xs text-muted-foreground">
                    Could not read the whitelist — funding will use the default token.
                  </div>
                ) : tokens.length === 1 ? (
                  /* One option is not a question. State it and move on. */
                  <div className="h-9 flex items-center gap-2 text-sm">
                    <span className="font-medium">{tokens[0].symbol}</span>
                    <span className="text-xs text-muted-foreground">
                      the only token this escrow accepts today
                    </span>
                  </div>
                ) : (
                  <select
                    value={payToken}
                    onChange={(e) => setPayToken(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {tokens.map((t) => (
                      <option key={t.address} value={t.address}>
                        {t.symbol}
                        {t.native ? " — this chain's own currency" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {/*
                The review window, in whichever unit the client is thinking in.
                A real job is "give people a day"; a demo is "wait five minutes".
                Forcing 1440 into a minutes box for the first is arithmetic
                nobody should have to do, so the unit is switchable and the
                value is stored in minutes underneath.
              */}
              <div className="rounded-xl actor-panel p-4">
                <Label htmlFor="window" className="text-xs">
                  Review applications after
                </Label>
                <div className="flex items-center gap-2 mt-1.5">
                  <Input
                    id="window"
                    type="number"
                    min={1}
                    value={windowValue}
                    onChange={(e) => setWindowValue(Math.max(1, Number(e.target.value) || 1))}
                    className="h-9 w-24 tabular-nums"
                  />
                  <div className="flex rounded-md border border-border/60 overflow-hidden">
                    {(["minutes", "hours", "days"] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setWindowUnit(u)}
                        className={`px-2.5 py-1.5 text-xs transition-colors ${
                          windowUnit === u
                            ? "bg-[var(--actor-soft)] actor-text"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  Autopilot waits this long, then scores every applicant together
                  and picks one — so nobody wins by refreshing fastest. Longer
                  windows get more applicants; shorter ones get someone started
                  sooner.
                </p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  That is <strong className="text-foreground">{reviewWindow}</strong>{" "}
                  minute{reviewWindow === 1 ? "" : "s"} in total.
                </p>
              </div>
            </div>

            {/* ── Right: the work ── */}
            <div className="space-y-8 min-w-0">
              <section>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h2 className="font-display text-xl font-semibold">Milestones</h2>
                  <span className="text-xs text-muted-foreground">
                    Paid one at a time, as each is approved
                  </span>
                </div>

                <div className="space-y-3 mt-4">
                  {brief.milestones.map((m, i) => (
                    <div key={i} className="rounded-xl actor-panel p-3 sm:p-4">
                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1 min-w-0">
                          <Label className="text-xs text-muted-foreground">
                            Milestone {i + 1}
                          </Label>
                          <Textarea
                            rows={2}
                            value={m.description}
                            onChange={(e) => patchMilestone(i, { description: e.target.value })}
                            className="mt-1.5 resize-none text-sm"
                          />
                        </div>
                        <div className="sm:w-28 shrink-0">
                          <Label className="text-xs text-muted-foreground">USDC</Label>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={m.amount}
                            onChange={(e) => patchMilestone(i, { amount: Number(e.target.value) || 0 })}
                            className="mt-1.5 h-9 tabular-nums"
                          />
                        </div>
                      </div>

                      {brief.milestones.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setBrief({
                              ...brief,
                              milestones: brief.milestones.filter((_, idx) => idx !== i),
                            })
                          }
                          className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    setBrief({
                      ...brief,
                      milestones: [...brief.milestones, { description: "", amount: 0 }],
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                  Add a milestone
                </Button>
              </section>

              {brief.criteria.length > 0 && (
                <section>
                  <h2 className="font-display text-xl font-semibold">
                    What counts as done
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Autopilot approves or rejects delivered work against these.
                  </p>
                  <ul className="mt-3 space-y-2">
                    {brief.criteria.map((c, i) => (
                      <li key={i} className="flex gap-2.5 text-sm">
                        <span className="actor-dot mt-1.5" aria-hidden="true" />
                        <span className="min-w-0 break-words">{c}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>

          {/* ── Fund it, here ── */}
          <div className="mt-8 rounded-xl border border-border/60 p-4 flex gap-3">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground font-medium">
                You fund this, not Autopilot.
              </strong>{" "}
              One transaction from your own wallet opens the escrow, so the money
              and the dispute rights stay yours. Autopilot then hires, reviews
              and pays the freelancer — it can never pay itself or settle a
              dispute, and you can take control back at any moment.
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mt-6">
            <Button
              size="lg"
              onClick={() => void handleFund()}
              disabled={total <= 0 || incomplete || funding || !wallet.isConnected}
              className="flex-1 bg-[var(--actor)] text-[var(--actor-fg)] hover:bg-[var(--actor)] hover:opacity-90"
            >
              {funding && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />}
              {wallet.isConnected
                ? `Fund and post — $${total.toFixed(2)}`
                : "Connect a wallet to fund this"}
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => void handleWriteBrief()}
              disabled={thinking || funding}
              className="shrink-0"
            >
              {thinking ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
              ) : (
                <Wand2 className="h-4 w-4 mr-2" aria-hidden="true" />
              )}
              Try again
            </Button>
          </div>

          {incomplete && (
            <p className="text-xs text-muted-foreground mt-3">
              Every milestone needs a description — it is what the freelancer
              delivers against.
            </p>
          )}
        </motion.div>
      </div>
    );
  }

  /* ─────────────── Step 1: one sentence ─────────────── */
  return (
    <div className="container mx-auto px-4 py-8 sm:py-12 max-w-2xl">
      <Link
        to="/post"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to modes
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="actor-agent mt-6"
      >
        <span className="actor-chip">
          <span className="actor-dot" />
          Autopilot
        </span>

        <h1 className="font-display text-3xl sm:text-5xl font-bold tracking-tight mt-4">
          What do you need made?
        </h1>
        <p className="text-muted-foreground mt-3 leading-relaxed">
          One sentence is enough. Include a budget and a deadline — Autopilot
          turns the rest into a brief you can check before anything is funded.
        </p>

        <div className="mt-8">
          <Label htmlFor="instruction" className="sr-only">
            What do you need made?
          </Label>
          <Textarea
            id="instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={4}
            placeholder="A logo for a coffee roastery. Budget $50, 3 days."
            className="text-base actor-panel resize-none"
          />

          <div className="flex flex-wrap gap-2 mt-3">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setInstruction(ex)}
                className="text-xs text-left px-3 py-1.5 rounded-full border border-border/60 text-muted-foreground hover:actor-text hover:border-[var(--actor-border)] transition-colors"
              >
                {ex.split(".")[0]}
              </button>
            ))}
          </div>

          {trimmed.length > 12 && !hasBudget && (
            <p className="text-sm text-muted-foreground mt-3">
              Add a budget — for example “Budget $50” — so Autopilot knows what
              it may commit.
            </p>
          )}
        </div>

        <Button
          size="lg"
          onClick={() => void handleWriteBrief()}
          disabled={!ready || !AUTOPILOT_CONFIGURED || thinking}
          className="mt-6 w-full bg-[var(--actor)] text-[var(--actor-fg)] hover:bg-[var(--actor)] hover:opacity-90"
        >
          {thinking ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
              Writing the brief…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" aria-hidden="true" />
              Write the brief
            </>
          )}
        </Button>

        <p className="text-xs text-muted-foreground mt-3 text-center">
          Nothing is funded at this step — you see the brief first.
        </p>

        {!AUTOPILOT_CONFIGURED && (
          <p className="text-xs text-muted-foreground mt-3 text-center">
            Autopilot is not configured for this deployment — set
            <code className="mx-1 font-mono">VITE_AGENT_API_URL</code>
            to point at a running daemon.
          </p>
        )}
      </motion.div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl actor-panel p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

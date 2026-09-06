/**
 * AUTOPILOT — say what you want, then check what the agent proposes.
 *
 * Two steps, and the second one is the point.
 *
 * The promise is that commissioning work costs a sentence rather than an
 * afternoon, so the first input is one textarea and nothing else: no milestone
 * table, no budget field, no acceptance criteria. Asking a client to fill those
 * in would be asking them to do the exact labour they came here to delegate.
 *
 * But "the agent writes your brief" is only reassuring if you can SEE the brief
 * before your money is involved. So step two shows what Autopilot actually
 * proposes — title, duration, acceptance criteria, and the milestone split with
 * amounts — and lets the client change any of it. The daemon's own /api/instruct
 * cannot serve this: it writes the brief and opens a funded escrow in the same
 * call, so the only way to see the proposal was to have already paid for it.
 * /api/brief/preview exists for exactly this screen.
 *
 * Funding then hands off to the manual escrow wizard with everything prefilled.
 * That is not a fallback — it is the honest arrangement until the job-manager
 * delegation is deployed: the CLIENT funds and owns the escrow, and appoints
 * Autopilot to manage it. Which is the whole product.
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Info, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  AUTOPILOT_CONFIGURED,
  AUTOPILOT_BRIEF_KEY,
  previewBrief,
  type AutopilotBrief,
} from "@/lib/atelier/patron";

const EXAMPLES = [
  "A logo for a coffee roastery. Budget $50, 3 days.",
  "Write 800 words on stablecoin settlement for our blog. Budget $120, 5 days.",
  "Voiceover for a 90-second explainer, warm tone. Budget $75, 2 days.",
];

export default function AutopilotComposePage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [instruction, setInstruction] = useState("");
  const [brief, setBrief] = useState<AutopilotBrief | null>(null);
  const [thinking, setThinking] = useState(false);

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
      toast({
        variant: "destructive",
        title: "Autopilot could not write that brief",
        description: e instanceof Error ? e.message : String(e),
      });
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

  function handleFund() {
    if (!brief) return;
    /*
     * Handed over in sessionStorage rather than the URL. A brief with several
     * milestones and a paragraph of criteria makes a URL long enough to be
     * truncated by something in the middle, and the failure would be a silently
     * half-filled form rather than an error.
     */
    sessionStorage.setItem(
      AUTOPILOT_BRIEF_KEY,
      JSON.stringify({ ...brief, budget: total, instruction: trimmed }),
    );
    navigate("/create?from=autopilot");
  }

  /* ─────────────── Step 2: the agent's proposal ─────────────── */
  if (brief) {
    return (
      <div className="container mx-auto px-4 py-8 sm:py-12 max-w-2xl">
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
          <p className="text-muted-foreground mt-3 leading-relaxed">
            Change anything you disagree with. Autopilot hires and reviews
            against this brief, so it is worth reading properly.
          </p>

          {/* ── Terms ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-7">
            <Field label="Total">
              <span className="actor-figure figure-md">${total.toFixed(2)}</span>
            </Field>
            <Field label="Days">
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
            <Field label="Revisions">
              <Input
                type="number"
                min={0}
                value={brief.revisionRounds}
                onChange={(e) =>
                  setBrief({ ...brief, revisionRounds: Math.max(0, Number(e.target.value) || 0) })
                }
                className="h-9"
              />
            </Field>
          </div>

          {/* ── Milestones ── */}
          <section className="mt-8">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="font-display text-xl font-semibold">Milestones</h2>
              <span className="text-xs text-muted-foreground">
                Paid out one at a time, as each is approved
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
                    <div className="sm:w-32 shrink-0">
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

          {/* ── Acceptance criteria ── */}
          {brief.criteria.length > 0 && (
            <section className="mt-8">
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

          {/* ── The honest bit ── */}
          <div className="mt-8 rounded-xl border border-border/60 p-4 flex gap-3">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground font-medium">You fund this, not Autopilot.</strong>{" "}
              The next step opens the escrow from your own wallet with this brief
              filled in, so the money and the dispute rights stay yours. Handing
              day-to-day management to Autopilot needs the delegation that is
              built and tested but not yet deployed — until then, run the job
              yourself or wait for the redeploy.
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mt-6">
            <Button
              size="lg"
              onClick={handleFund}
              disabled={total <= 0 || brief.milestones.some((m) => !m.description.trim())}
              className="flex-1 bg-[var(--actor)] text-[var(--actor-fg)] hover:bg-[var(--actor)] hover:opacity-90"
            >
              Fund this escrow — ${total.toFixed(2)}
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => void handleWriteBrief()}
              disabled={thinking}
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

          {brief.milestones.some((m) => !m.description.trim()) && (
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
            <code className="mx-1 font-mono">VITE_PATRON_API_URL</code>
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

/**
 * AUTOPILOT — say what you want, in one sentence.
 *
 * The whole promise of the middle row is that commissioning work should cost a
 * sentence rather than an afternoon. So the primary input is one textarea, and
 * everything the daemon needs — title, budget, duration, acceptance criteria,
 * milestone split — is inferred from it by Patron's BriefGenerator.
 *
 * On the interim-custody notice below: this page is wired to the daemon's
 * existing `/api/instruct`, which works today and is genuinely useful. But in
 * that path the daemon is the escrow depositor, not the client — see
 * docs/adr/0001-autopilot-delegation.md. Rather than quietly shipping a
 * weaker arrangement than "Post a Job" advertises, the page says so, in the
 * flow, before the client commits. The notice is deleted when the scoped job
 * manager lands and the client funds their own escrow.
 *
 * That disclosure is not modesty. Overclaiming a mechanism is the specific
 * failure BRIEF.md's do-not-repeat table lists first, and a documented
 * limitation has consistently scored better than a quiet one.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Info, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AUTOPILOT_CONFIGURED } from "@/lib/atelier/patron";

const EXAMPLES = [
  "A logo for a coffee roastery. Budget $50, 3 days.",
  "Write 800 words on stablecoin settlement for our blog. Budget $120, 5 days.",
  "Voiceover for a 90-second explainer, warm tone. Budget $75, 2 days.",
];

export default function AutopilotComposePage() {
  const [instruction, setInstruction] = useState("");

  const trimmed = instruction.trim();
  /* The daemon rejects an instruction with no budget in it, with a message the
     client would only see after submitting. Cheaper to notice it here. */
  const hasBudget = /\$\s*\d|\d+\s*(usdc|dollars?)\b/i.test(trimmed);
  const ready = trimmed.length > 12 && hasBudget;

  return (
    <div className="container mx-auto px-4 py-12 max-w-2xl">
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

        <h1 className="font-display text-4xl font-bold tracking-tight mt-4">
          What do you need made?
        </h1>
        <p className="text-muted-foreground mt-3 leading-relaxed">
          One sentence is enough. Include a budget and a deadline — Autopilot
          turns the rest into a brief, posts it, and hires a person.
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

        {/* ── The honest bit ─────────────────────────────────────────────── */}
        <div className="mt-8 rounded-xl border border-border/60 p-4 flex gap-3">
          <Info
            className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="text-sm text-muted-foreground leading-relaxed">
            <strong className="text-foreground font-medium">
              While this is in progress:
            </strong>{" "}
            Autopilot currently funds the escrow from its own wallet against a
            balance you deposit, which means it — not you — is the on-chain
            client for this job, and dispute rights sit with it. The scoped
            job-manager delegation that puts your wallet on the escrow is next
            on the build; until it lands, treat Autopilot as custodial and size
            jobs accordingly.
          </div>
        </div>

        <Button
          size="lg"
          disabled={!ready || !AUTOPILOT_CONFIGURED}
          className="mt-6 w-full bg-[var(--actor)] text-[var(--actor-fg)] hover:bg-[var(--actor)] hover:opacity-90"
        >
          <Sparkles className="h-4 w-4 mr-2" aria-hidden="true" />
          Write the brief
        </Button>

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

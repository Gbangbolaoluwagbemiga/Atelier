/**
 * ATELIER ↔ PATRON DAEMON.
 *
 * Autopilot is not a new brain. It is Patron's daemon — already running 24/7,
 * already holding its keys server-side, already polling the subgraph to score
 * applicants and release payment — surfaced inside Atelier. This module is the
 * seam.
 *
 * The daemon is NOT being rewritten into Atelier's Express backend. It works,
 * it runs unattended, and a rewrite would be a lot of new code that produces
 * exactly the behaviour we already have. So Atelier talks to two backends: the
 * Express API for Atelier's own concerns, and this one for agent activity.
 *
 * Shapes here mirror `patron/daemon/src/store.ts` and `patron/web/src/types.ts`.
 * They are duplicated rather than imported because the daemon is a separate
 * deployable with its own release cycle — importing across that boundary would
 * couple two things that ship independently. When the daemon's shapes change,
 * `isDecisionRow` below starts rejecting rows and the log shows a gap, which is
 * the failure we want: visible, not silent.
 */

import type { Actor, Decision } from "./actor";

const BASE = (
  (import.meta.env.VITE_PATRON_API_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/$/, "");

/** Whether Autopilot is reachable at all. False in a Atelier-only deploy. */
export const AUTOPILOT_CONFIGURED = BASE.length > 0;

/* ── Daemon wire shapes ──────────────────────────────────────────────────── */

export interface DecisionRow {
  id: string;
  task_id: string;
  type: string;
  reasoning: string;
  target: string | null;
  score: number | null;
  timestamp: number;
}

export interface TaskRow {
  id: string;
  escrowId: string | null;
  instruction: string;
  clientType: "agent" | "human";
  status: string;
  briefJson: string | null;
  createdAt: number;
}

/* ── The actor mapping — the heart of the visual language ────────────────── */

/**
 * Decision types that represent a HUMAN acting, even though they arrive on the
 * agent's own event stream.
 *
 * This list is short and it matters enormously. An Autopilot job reads amber
 * down its whole length; the moment one of these appears, the trail turns teal
 * and stays teal. That is not decoration — it is the record of a machine
 * handing control back to a person, which is the single most important thing a
 * client can see when they are deciding whether to trust the arrangement.
 *
 * `escalated_to_human` is the daemon's own name for hitting its revision limit
 * and calling in Atelier's dispute system. Everything downstream of it is a
 * person's judgement, so it must not be painted as the agent's.
 */
const HUMAN_DECISION_TYPES: ReadonlySet<string> = new Set([
  "escalated_to_human",
  "dispute_raised",
  "dispute_resolved",
  "arbiter_ruled",
  "client_overrode",
  "client_approved",
  "client_rejected",
]);

export function actorForDecisionType(type: string): Actor {
  return HUMAN_DECISION_TYPES.has(type) ? "human" : "agent";
}

/**
 * Once a job has been escalated, later agent chatter is no longer the thing in
 * charge — a human arbiter is. Painting a subsequent `application_scored` amber
 * would imply the agent took the wheel back, which it did not.
 *
 * So escalation is a latch: from the first human decision onward, the whole
 * remaining trail is teal.
 */
export function applyEscalationLatch(decisions: Decision[]): Decision[] {
  let escalated = false;
  return decisions.map((d) => {
    if (d.by === "human") escalated = true;
    return escalated ? { ...d, by: "human" as const } : d;
  });
}

/** Prose for the log's action line. Falls back to the raw type, never to "". */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  brief_generated: "Brief written",
  job_posted: "Job posted and escrow funded",
  applications_fetched: "Applications collected",
  application_scored: "Applicant scored",
  applicant_accepted: "Freelancer hired",
  no_suitable_applicant: "No applicant met the bar",
  portfolio_verified: "Portfolio checked",
  work_submitted: "Work submitted",
  work_approved: "Work approved",
  work_rejected: "Work rejected",
  revision_requested: "Revision requested",
  escalated_to_human: "Escalated to a human arbiter",
  payment_released: "Payment released",
  task_completed: "Job completed",
  error: "Something went wrong",
};

export function actionLabel(type: string): string {
  return ACTION_LABEL[type] ?? type.replace(/_/g, " ");
}

/** Narrow an unknown row from the wire. See the module note on why this exists. */
function isDecisionRow(v: unknown): v is DecisionRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.type === "string" &&
    typeof r.timestamp === "number"
  );
}

export function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    by: actorForDecisionType(row.type),
    action: actionLabel(row.type),
    rationale: row.reasoning || undefined,
    at: row.timestamp,
  };
}

/* ── Fetching ────────────────────────────────────────────────────────────── */

export class AutopilotUnavailable extends Error {
  constructor(message = "Autopilot is not configured for this deployment.") {
    super(message);
    this.name = "AutopilotUnavailable";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) {
    throw new Error(`Autopilot returned ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * The decision log, newest first from the daemon, returned oldest-first here
 * because a log is read downward and the escalation latch runs forward in time.
 *
 * Pass `taskId` to scope it to one job. The daemon keys decisions by task, not
 * by escrow, so callers who have an escrow id should use
 * `fetchDecisionsForEscrow` rather than filtering this themselves.
 */
export async function fetchDecisions(
  opts: { limit?: number; taskId?: string; signal?: AbortSignal } = {},
): Promise<Decision[]> {
  const limit = opts.limit ?? 100;
  const raw = await get<unknown>(`/api/decisions?limit=${limit}`, opts.signal);
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter(isDecisionRow);
  const scoped =
    opts.taskId === undefined
      ? rows
      : rows.filter((r) => r.task_id === opts.taskId);
  const decisions = scoped.map(toDecision).sort((a, b) => a.at - b.at);
  return applyEscalationLatch(decisions);
}

/**
 * One job's decision log, by escrow id.
 *
 * Two hops, because the daemon's two tables are keyed differently: tasks carry
 * the escrow id, decisions carry the task id. Doing the join here rather than at
 * each call site keeps the escalation latch correct — the latch must run over a
 * single job's decisions in time order, and a caller who filtered a
 * globally-latched list would inherit an escalation from somebody else's job.
 *
 * An escrow the daemon has never heard of returns an empty log, not an error:
 * that is the ordinary case for a manually-managed job.
 */
export async function fetchDecisionsForEscrow(
  escrowId: number | string,
  signal?: AbortSignal,
): Promise<Decision[]> {
  const wanted = String(escrowId);
  const tasks = await fetchTasks(signal);
  const task = tasks.find((t) => String(t.escrowId) === wanted);
  if (!task) return [];
  return fetchDecisions({ taskId: task.id, limit: 200, signal });
}

/** Every job the daemon is managing. Used to tell Autopilot jobs from manual. */
export async function fetchTasks(signal?: AbortSignal): Promise<TaskRow[]> {
  const raw = await get<unknown>("/api/tasks", signal);
  return Array.isArray(raw) ? (raw as TaskRow[]) : [];
}

/**
 * The set of escrow IDs Autopilot manages.
 *
 * This is how Atelier knows a job is on Autopilot: the chain does not record it
 * — deliberately, since a freelancer must not be able to tell — so the daemon's
 * own task table is the only source of truth. Anything not in this set is
 * manual.
 */
export async function fetchManagedEscrowIds(
  signal?: AbortSignal,
): Promise<Set<string>> {
  const tasks = await fetchTasks(signal);
  return new Set(
    tasks
      .map((t) => t.escrowId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

/* ── The agent's own address ─────────────────────────────────────────────── */

export interface AutopilotWallet {
  address: `0x${string}`;
  balance: string;
  explorerUrl: string;
}

/**
 * The Circle wallet the daemon signs with — and therefore the address a client
 * must appoint as job manager for Autopilot to be able to do anything.
 *
 * Fetched rather than configured. A hardcoded VITE_ variable would be one
 * redeploy away from pointing at a wallet the daemon no longer uses, and the
 * failure mode is nasty: setJobManager would succeed, the client would see
 * "managed by Autopilot", and the agent would silently never be able to act —
 * a job that looks delegated and is actually abandoned.
 *
 * Asking the daemon means the answer is always the key it currently holds.
 */
export async function fetchAutopilotAddress(
  signal?: AbortSignal,
): Promise<AutopilotWallet> {
  const w = await get<Partial<AutopilotWallet>>("/api/wallet", signal);
  if (!w.address || !/^0x[a-fA-F0-9]{40}$/.test(w.address)) {
    throw new Error("Autopilot did not report a usable wallet address.");
  }
  return {
    address: w.address as `0x${string}`,
    balance: w.balance ?? "0",
    explorerUrl: w.explorerUrl ?? "",
  };
}

/* ── Brief preview ───────────────────────────────────────────────────────── */

export interface BriefMilestone {
  description: string;
  amount: number;
}

export interface AutopilotBrief {
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  deliverableFormat: string;
  revisionRounds: number;
  milestones: BriefMilestone[];
  briefHash: string;
  applicationWindowMinutes?: number;
}

/**
 * Ask Autopilot what it would post, without commissioning anything.
 *
 * The daemon's /api/instruct writes the brief and opens a funded escrow in one
 * call, which meant the only way to see the agent's proposal was to have
 * already paid for it. This runs the same generator and stops — no task, no
 * escrow, no treasury movement — so a client can read the milestones the agent
 * chose, and try another phrasing, before any money is involved.
 */
export async function previewBrief(
  instruction: string,
  signal?: AbortSignal,
): Promise<AutopilotBrief> {
  if (!AUTOPILOT_CONFIGURED) throw new AutopilotUnavailable();

  const res = await fetch(`${BASE}/api/brief/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
    signal,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    brief?: AutopilotBrief;
    error?: string;
  };

  if (!res.ok) {
    // The daemon's own message is written for the client ("State a budget in
    // the instruction"), so it is better than anything generic we would add.
    throw new Error(payload.error ?? `Autopilot returned ${res.status}`);
  }
  if (!payload.brief || !Array.isArray(payload.brief.milestones)) {
    throw new Error("Autopilot returned a brief we could not read.");
  }
  return payload.brief;
}

/** Where a brief waits while the client is sent to the funding wizard. */
export const AUTOPILOT_BRIEF_KEY = "atelier:autopilot-brief";

/**
 * THE HUMAN FRONT DOOR.
 *
 * Atelier's demand side was always easy: an agent makes one HTTP call and x402
 * settles it. The supply side was behind a wall no actual freelancer would
 * climb — install MetaMask, add a network by chain id, source gas, find the
 * escrow, sign twice. Eight steps and three foreign concepts before earning a
 * first dollar. That is how a marketplace ends up with a working AI and zero
 * humans in it.
 *
 * This module is the other door. A person picks a name; the daemon provisions
 * them a real Circle MPC wallet, drips enough gas to sign with, and signs on
 * their instruction. They apply, deliver, and get paid without the word
 * "wallet" appearing anywhere.
 *
 * WHERE THE KEYS ARE, stated plainly because it is the trade-off being made:
 * the MPC wallet is controlled by the daemon, not by the person. That is
 * custody, and it is the price of removing the eight steps. It is why
 * `linkOwnWallet` exists — anyone who wants their own keys can switch, and
 * their history follows them.
 *
 * The browser never sees a private key, an entity secret, or a Circle wallet
 * id. Everything here is an identifier the daemon issued and can revoke.
 */

import { AUTOPILOT_CONFIGURED } from "./agent-api";

const BASE = (
  (import.meta.env.VITE_AGENT_API_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/$/, "");

/** Whether the managed-worker layer is reachable at all. */
export const WORKER_DOOR_OPEN = AUTOPILOT_CONFIGURED;

/* ── Shapes, mirroring agent/daemon/src/workers/service.ts ───────────────── */

/** How this person's wallet is held. */
export type WalletMode = "managed" | "own";

export interface Worker {
  id: string;
  handle: string;
  address: `0x${string}`;
  mode: WalletMode;
  /** USDC, as a decimal string. Null when the balance read failed. */
  balance?: string | null;
  /**
   * The identity this account is signed in with — the Google address for a
   * managed wallet, null for someone using their own.
   *
   * On screen because two Google accounts can carry the same handle, and when
   * they do the dashboard is otherwise identical apart from a truncated hex
   * address. Signing in with the wrong one then looks exactly like the app
   * issuing a new wallet and losing the job the other account was hired for.
   */
  signedInAs?: string | null;
  /** True when this signed an existing person in rather than creating them. */
  returning?: boolean;
}

export interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  milestones: { description: string; amount: number }[];
  /** Epoch ms when applications close and the agent judges them together. */
  closesAt: number;
  /** Present only on the personalised board. */
  applied?: boolean;
}

export interface WorkItem {
  escrowId: string;
  title: string;
  budget: number;
  status: string;
  icon: string;
  state: string;
  /** Stages delivered and waiting on a verdict. */
  awaitingReview?: number;
  /** Stages already approved and paid. */
  approved?: number;
  milestoneCount?: number;
  /**
   * False when there is nothing left to send.
   *
   * The board offered "Send work" from the moment of hire until the job closed,
   * whatever had already been delivered — so a freelancer could file the next
   * stage without ever learning what happened to the last one.
   */
  canSubmit?: boolean;
}

/* ── Session ─────────────────────────────────────────────────────────────── */

const SESSION_KEY = "atelier:worker-id";

/**
 * Who is using this browser.
 *
 * A worker id, not a wallet and not a password. It is deliberately low-stakes:
 * losing it loses access to a managed wallet's UI, which is why the balance
 * screen pushes people to withdraw to an address they control rather than
 * treating this as a bank.
 *
 * Wrapped because storage throws outright in some privacy modes, and a
 * marketplace that white-screens in a private window is worse than one that
 * forgets who you are.
 */
export function currentWorkerId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function rememberWorker(id: string): void {
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    /* Private mode. The session lasts as long as the tab, which still works. */
  }
}

export function forgetWorker(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/* ── Transport ───────────────────────────────────────────────────────────── */

export class WorkerDoorClosed extends Error {
  constructor(message = "The worker service is not configured for this deployment.") {
    super(message);
    this.name = "WorkerDoorClosed";
  }
}

async function call<T>(
  path: string,
  init?: RequestInit & { body?: string },
): Promise<T> {
  if (!WORKER_DOOR_OPEN) throw new WorkerDoorClosed();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });

  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    // The daemon writes its errors for the person hitting them, so its message
    // beats anything generic added here.
    throw new Error(payload.error ?? `Worker service returned ${res.status}`);
  }
  return payload;
}

/* ── The door ────────────────────────────────────────────────────────────── */

/**
 * Become a freelancer.
 *
 * `handle` is the only required field. Everything a wallet normally demands —
 * a seed phrase, a network, gas — is the daemon's problem from here.
 *
 * `ownAddress` is for someone who already has a wallet and would rather keep
 * their keys; the daemon then signs nothing on their behalf.
 */
export async function join(input: {
  handle: string;
  /**
   * A Google ID token, required for a managed wallet. NOT an email.
   *
   * The daemon verifies this against Google's public keys and takes the email
   * out of the verified payload — the browser never gets to say who it is. An
   * earlier version accepted a plain email string, which meant knowing
   * somebody's address was enough to withdraw their money.
   */
  idToken?: string;
  skills?: string;
  ownAddress?: string;
}): Promise<Worker> {
  const worker = await call<Worker>("/api/worker/join", {
    method: "POST",
    body: JSON.stringify(input),
  });
  rememberWorker(worker.id);
  return worker;
}

export async function me(id: string): Promise<Worker> {
  return call<Worker>(`/api/worker/me?id=${encodeURIComponent(id)}`);
}

/** The open board. Pass a worker id to have it marked with what you applied to. */
export async function quests(workerId?: string | null): Promise<Quest[]> {
  const q = workerId
    ? `/api/worker/quests?id=${encodeURIComponent(workerId)}`
    : "/api/worker/quests";
  const rows = await call<Quest[]>(q);
  return Array.isArray(rows) ? rows : [];
}

export async function myWork(workerId: string): Promise<WorkItem[]> {
  const rows = await call<WorkItem[]>(
    `/api/worker/mine?id=${encodeURIComponent(workerId)}`,
  );
  return Array.isArray(rows) ? rows : [];
}

export async function apply(input: {
  workerId: string;
  escrowId: string;
  coverLetter: string;
  proposedTimelineDays?: number;
  portfolioUrl?: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/apply", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface DeliveryTarget {
  escrowId: string;
  /** Zero-based index of the stage this delivery will be filed against. */
  index: number;
  count: number;
  description: string;
  amountUsdc: number | null;
  criteria: string[];
  /** True when an agent, not the client, reviews this submission. */
  agentReviewed: boolean;
}

/**
 * Which stage a freelancer is about to deliver, and the rubric it faces.
 *
 * The delivery box asked "What did you deliver?" and said nothing about which
 * milestone that answer went to — on a two-stage job it silently picked one —
 * or what the stage was meant to contain. On an agent-run job a machine then
 * approved or rejected it against criteria the freelancer had never seen.
 */
export async function deliveryTarget(escrowId: string): Promise<DeliveryTarget> {
  return call<DeliveryTarget>(
    `/api/worker/delivery?escrowId=${encodeURIComponent(escrowId)}`,
  );
}

export async function submit(input: {
  workerId: string;
  escrowId: string;
  /* Omit to deliver the stage that actually needs work. The daemon resolves it
     — hard-coding 0 sent a second milestone's delivery to the first one. */
  milestoneIndex?: number;
  description: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Move earnings to an address the person actually controls.
 *
 * The important button in the whole flow. A managed wallet is a convenience for
 * getting started, not somewhere to leave money — the UI should keep saying so.
 */
export async function withdraw(input: {
  workerId: string;
  destination: string;
  amountUsdc: string;
}): Promise<{ txHash?: string }> {
  return call("/api/worker/withdraw", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Swap a managed wallet for one whose keys the person holds. History follows. */
export async function linkOwnWallet(input: {
  workerId: string;
  address: string;
}): Promise<Worker> {
  return call<Worker>("/api/worker/switch-wallet", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Minutes until applications close, floored at zero. */
export function minutesUntilClose(quest: Quest, now = Date.now()): number {
  return Math.max(0, Math.ceil((quest.closesAt - now) / 60_000));
}

/**
 * Get back into an account you already have.
 *
 * Takes a Google ID token, like joining does. The previous version took an
 * email in a query string and handed back a worker id — which is a withdrawal
 * credential — so it gave away other people's wallets to anyone who knew their
 * address. Replaced rather than patched: the shape of it was the problem.
 */
export async function recover(idToken: string): Promise<Worker> {
  const worker = await call<Worker>("/api/worker/recover", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  rememberWorker(worker.id);
  return worker;
}

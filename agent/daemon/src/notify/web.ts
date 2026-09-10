import { config } from "../config.js";
import type { AgentEvent } from "../agent/AgentClient.js";
import * as atelier from "../web3/atelier.js";

/**
 * THE OTHER HALF OF EVERY MESSAGE THE AGENT ALREADY SENDS.
 *
 * When the agent hires someone or releases a payment, it tells them on
 * Telegram. Web users were told nothing at all — not because anyone decided
 * that, but because of where notifications are written from: the browser of
 * whoever performed the action. That works when a person clicks Approve. When
 * the agent approves, there is no browser, so nobody is told.
 *
 * The effect was that Autopilot — the feature whose whole promise is that you
 * do not have to watch the job — was the one mode where you had to watch the
 * job, unless you happened to be on Telegram.
 *
 * WHY IT LISTENS TO EVENTS RATHER THAN LIVING AT THE CALL SITES
 *
 * The agent already emits an event for every consequential thing it does, and
 * the Telegram side is built on those. Hanging this off the same events means
 * the two channels cannot drift: a new event type is either handled for both or
 * neither, and there is no path where the bot says a freelancer was hired and
 * the web app disagrees.
 *
 * WHY IT NEVER THROWS
 *
 * A notification is a courtesy on top of an on-chain fact that has already
 * happened. If the API is down, the hire still stands and the money has still
 * moved; failing the agent's loop over an undelivered message would turn a
 * cosmetic outage into a stalled hire.
 */

/** The vocabulary the web app's notification centre renders. */
type WebNotificationType =
  | "milestone"
  | "dispute"
  | "escrow"
  | "application"
  | "message"
  | "rating";

interface WebNotification {
  to: string;
  type: WebNotificationType;
  title: string;
  message: string;
}

/** Resolved from the chain, not the local task store. */
async function clientOf(escrowId: string): Promise<string | null> {
  try {
    const esc = await atelier.getEscrow(BigInt(escrowId));
    const depositor = (esc as { depositor?: string }).depositor;
    return depositor && depositor !== ZERO ? depositor : null;
  } catch {
    return null;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Who needs to hear about this, and what it says.
 *
 * Returns an empty list for events that are progress rather than news —
 * "scoring applicants", "fetching from the subgraph". Those belong in the live
 * feed for someone who is watching; pushing them as notifications trains people
 * to ignore the bell, and the bell is how they learn they were paid.
 */
export async function recipientsFor(event: AgentEvent): Promise<WebNotification[]> {
  const id = event.escrowId;
  if (!id) return [];

  const out: WebNotification[] = [];
  const worker = event.decision?.target;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  switch (event.type) {
    case "applicant_accepted": {
      if (worker) {
        out.push({
          to: worker,
          type: "application",
          title: "You got the job",
          message:
            "The budget is already locked in escrow and cannot be taken back — not even by the agent that hired you. Submit your work when it is ready.",
        });
      }
      const client = await clientOf(id);
      if (client) {
        out.push({
          to: client,
          type: "application",
          title: "Someone has been hired for your commission",
          message: worker
            ? `${short(worker)} scored highest against your brief. Every applicant's score and the reasoning is on the job.`
            : "The agent hired the strongest applicant against your brief.",
        });
      }
      break;
    }

    case "no_suitable_applicant": {
      const client = await clientOf(id);
      if (client) {
        out.push({
          to: client,
          type: "application",
          title: "Nobody cleared the bar yet",
          message:
            "No applicant met your brief's threshold, so the commission stays open and your money stays where it is.",
        });
      }
      break;
    }

    /*
     * The freelancer's money moved. This is the single most important thing the
     * bell has ever had to say, and it was the one it could not say at all when
     * the agent was the one approving.
     */
    case "payment_released": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const paid = (esc as { beneficiary?: string } | null)?.beneficiary;
      if (paid && paid !== ZERO) {
        out.push({
          to: paid,
          type: "milestone",
          title: "You have been paid",
          message: event.amountUsdc
            ? `$${event.amountUsdc} USDC has been released to you for an approved milestone.`
            : "A milestone was approved and the payment has been released to you.",
        });
      }
      break;
    }

    case "revision_requested":
    case "work_rejected": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const who = (esc as { beneficiary?: string } | null)?.beneficiary;
      if (who && who !== ZERO) {
        out.push({
          to: who,
          type: "milestone",
          title: "Changes requested on your work",
          message: event.message.slice(0, 400),
        });
      }
      break;
    }

    /* Both sides: the freelancer needs to stop waiting, the client needs to act. */
    case "escalated_to_human": {
      const esc = await atelier.getEscrow(BigInt(id)).catch(() => null);
      const who = (esc as { beneficiary?: string } | null)?.beneficiary;
      const client = await clientOf(id);
      if (who && who !== ZERO) {
        out.push({
          to: who,
          type: "dispute",
          title: "Your submission needs a human decision",
          message: "The agent has handed this milestone to the client rather than deciding it.",
        });
      }
      if (client) {
        out.push({
          to: client,
          type: "dispute",
          title: "A milestone needs your decision",
          message: "The agent could not settle this one against your brief and has passed it to you.",
        });
      }
      break;
    }

    default:
      return [];
  }

  return out;
}

/** Post one notification. Resolves either way; never rejects. */
async function post(n: WebNotification, escrowId: string): Promise<boolean> {
  if (!config.apiUrl) return false;
  try {
    const res = await fetch(`${config.apiUrl}/v1/notifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiSecret ? { authorization: `Bearer ${config.apiSecret}` } : {}),
      },
      body: JSON.stringify({
        wallet_address: n.to,
        type: n.type,
        title: n.title,
        message: n.message,
        action_url: `${config.publicAppUrl}/jobs/${escrowId}`,
        data: { escrowId, source: "autopilot" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Deliver everything this event owes to the web app.
 * @returns how many were accepted, for the caller's logs. Never throws.
 */
export async function notifyWeb(event: AgentEvent): Promise<number> {
  try {
    const list = await recipientsFor(event);
    if (list.length === 0) return 0;
    const results = await Promise.all(list.map((n) => post(n, event.escrowId!)));
    return results.filter(Boolean).length;
  } catch {
    return 0;
  }
}

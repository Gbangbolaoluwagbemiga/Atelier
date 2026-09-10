import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../src/agent/AgentClient.js";

/**
 * WHO GETS TOLD WHEN THE AGENT ACTS.
 *
 * The bug this covers is not that a message looked wrong — it is that for web
 * users there was no message. Notifications are written from the acting party's
 * browser, and when the agent hires or pays there is no browser, so Autopilot
 * was the one mode where a client had to sit and watch the job.
 *
 * Two properties matter more than any wording:
 *
 *   the right person is told, and nobody else is
 *   the agent's loop survives the notification failing
 *
 * The second is why every path here resolves rather than throws. A hire that
 * already happened on-chain must not be undone by an unreachable API.
 */

const getEscrow = vi.fn();
vi.mock("../src/web3/atelier.js", () => ({ getEscrow }));
vi.mock("../src/config.js", () => ({
  config: {
    apiUrl: "https://api.test",
    apiSecret: "s3cret",
    publicAppUrl: "https://app.test",
  },
}));

const { notifyWeb, recipientsFor } = await import("../src/notify/web.js");

const CLIENT = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function event(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "applicant_accepted",
    message: "Hired 0x2222…",
    escrowId: "5",
    timestamp: Date.now(),
    decision: {
      id: "d1",
      taskId: "5",
      type: "applicant_accepted",
      reasoning: "Highest comparative score.",
      target: WORKER,
      timestamp: Date.now(),
    },
    ...over,
  } as AgentEvent;
}

beforeEach(() => {
  getEscrow.mockReset();
  getEscrow.mockResolvedValue({ depositor: CLIENT, beneficiary: WORKER });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201 })));
});

describe("a hire", () => {
  it("tells the freelancer they got it", async () => {
    const to = (await recipientsFor(event())).find((n) => n.to === WORKER);
    expect(to?.title).toMatch(/you got the job/i);
  });

  /* The person who paid had to keep a tab open to learn about their own money. */
  it("tells the client too", async () => {
    const to = (await recipientsFor(event())).find((n) => n.to === CLIENT);
    expect(to?.title).toMatch(/hired/i);
  });

  it("tells nobody else", async () => {
    const list = await recipientsFor(event());
    expect(new Set(list.map((n) => n.to))).toEqual(new Set([WORKER, CLIENT]));
  });
});

describe("a payment", () => {
  it("tells the freelancer, and names the amount", async () => {
    const list = await recipientsFor(
      event({ type: "payment_released", amountUsdc: "4", decision: undefined }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].to).toBe(WORKER);
    expect(list[0].message).toContain("$4");
  });

  /* An amount we do not have must not become "$undefined". */
  it("still says they were paid when the amount is unknown", async () => {
    const list = await recipientsFor(
      event({ type: "payment_released", amountUsdc: undefined, decision: undefined }),
    );
    expect(list[0].message).toMatch(/released to you/i);
    expect(list[0].message).not.toMatch(/undefined|NaN/);
  });

  it("says nothing when the escrow has no freelancer to pay", async () => {
    getEscrow.mockResolvedValue({ depositor: CLIENT, beneficiary: ZERO });
    const list = await recipientsFor(event({ type: "payment_released", decision: undefined }));
    expect(list).toEqual([]);
  });
});

describe("an escalation", () => {
  it("reaches both sides, because both have to stop waiting", async () => {
    const list = await recipientsFor(event({ type: "escalated_to_human", decision: undefined }));
    expect(new Set(list.map((n) => n.to))).toEqual(new Set([WORKER, CLIENT]));
    expect(list.every((n) => n.type === "dispute")).toBe(true);
  });
});

/**
 * Progress is not news. Pushing "scoring applicants…" to the bell teaches
 * people to ignore it, and the bell is how they find out they were paid.
 */
describe("what is deliberately not a notification", () => {
  it.each(["applications_fetched", "application_scored", "brief_generated", "work_submitted"])(
    "stays quiet on %s",
    async (type) => {
      expect(await recipientsFor(event({ type: type as AgentEvent["type"] }))).toEqual([]);
    },
  );

  it("stays quiet on an event with no escrow attached", async () => {
    expect(await recipientsFor(event({ escrowId: undefined }))).toEqual([]);
  });
});

describe("what it sends", () => {
  it("authenticates, and points the link at the job", async () => {
    await notifyWeb(event());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.test/v1/notifications");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body).action_url).toBe("https://app.test/jobs/5");
  });

  it("marks the source, so a client can see the agent did it", async () => {
    await notifyWeb(event());
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).data.source).toBe("autopilot");
  });
});

/**
 * The agent's loop pays people. It must survive anything this module can hit.
 */
describe("when it cannot deliver", () => {
  it("does not throw when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(notifyWeb(event())).resolves.toBe(0);
  });

  it("does not throw when the API rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(notifyWeb(event())).resolves.toBe(0);
  });

  it("does not throw when the chain read fails", async () => {
    getEscrow.mockRejectedValue(new Error("rpc down"));
    await expect(notifyWeb(event({ type: "payment_released", decision: undefined }))).resolves.toBe(0);
  });

  /* Still delivers to the freelancer even if the client cannot be resolved. */
  it("delivers what it can when only part of the lookup fails", async () => {
    getEscrow.mockResolvedValue({ depositor: ZERO, beneficiary: WORKER });
    expect(await notifyWeb(event())).toBe(1);
  });
});

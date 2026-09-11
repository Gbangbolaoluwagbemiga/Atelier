import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * SENDING THE WORK — the step a hired freelancer could not take.
 *
 * The board listed a hired job with the line "You were hired — send your work"
 * and offered nothing to send it with. The daemon endpoint existed, the client
 * function existed, and the row was display-only, so the only way to deliver
 * from the web was to go and use the Telegram bot instead.
 */

const myWork = vi.fn();
const quests = vi.fn();
const me = vi.fn();
const submit = vi.fn();
const deliveryTarget = vi.fn();

vi.mock("@/lib/atelier/worker", () => ({
  myWork: (id: string) => myWork(id),
  quests: (id: string) => quests(id),
  me: (id: string) => me(id),
  submit: (input: unknown) => submit(input),
  deliveryTarget: (id: string) => deliveryTarget(id),
  apply: vi.fn(),
  withdraw: vi.fn(),
  minutesUntilClose: () => 0,
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const { WorkerBoard } = await import("@/components/atelier/worker-board");

const WORKER = {
  id: "w1",
  handle: "cdev",
  address: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423",
  mode: "managed",
  balance: "0.05",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  quests.mockResolvedValue([]);
  me.mockResolvedValue(WORKER);
  submit.mockResolvedValue({ txHash: "0xtx" });
  deliveryTarget.mockResolvedValue({
    escrowId: "7",
    index: 1,
    count: 2,
    description: "Backend script to audit pending status entries",
    amountUsdc: 2,
    criteria: ["Screenshot confirming the role update", "No new issues introduced"],
    agentReviewed: true,
    previousFeedback: null,
  });
  myWork.mockResolvedValue([
    { escrowId: "7", title: "fireball", budget: 5, status: "You were hired — send your work", icon: "🔨", state: "hired" },
  ]);
});

describe("a hired freelancer delivering", () => {
  it("offers a way to send the work, not just a line telling them to", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: /send work/i })).toBeInTheDocument();
  });

  it("submits what they wrote, letting the daemon pick the milestone", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Figma link: example.com/f");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    const arg = submit.mock.calls[0][0];
    expect(arg).toMatchObject({ workerId: "w1", escrowId: "7", description: "Figma link: example.com/f" });
    // Hard-coding 0 filed a second milestone's delivery against the first.
    expect(arg.milestoneIndex).toBeUndefined();
  });

  it("will not send an empty delivery", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(screen.getByRole("button", { name: /submit for review/i })).toBeDisabled();
  });

  it("says the work is on-chain and awaiting review", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Done");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].title).toMatch(/submitted/i);
  });

  it("offers nothing to send on a job that is finished and paid", async () => {
    myWork.mockResolvedValue([
      { escrowId: "7", title: "fireball", budget: 5, status: "Finished and paid", icon: "✅", state: "completed" },
    ]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("fireball")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });

  it("offers nothing to send on a job they only applied for", async () => {
    myWork.mockResolvedValue([
      { escrowId: "9", title: "other", budget: 2, status: "Applied, waiting on the agent", icon: "⏳", state: "applied" },
    ]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });
});


/**
 * TELLING THEM WHAT THEY ARE DELIVERING, AND WHAT IT FACES.
 *
 * The box asked "What did you deliver?" and nothing else. On a two-stage job it
 * silently chose a milestone; on an agent-run job a machine then approved or
 * rejected the answer against criteria the freelancer had never been shown.
 */
describe("what the delivery box tells them", () => {
  it("names the stage and its share of the money", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/milestone 2 of 2/i)).toBeInTheDocument();
    expect(screen.getByText(/audit pending status entries/i)).toBeInTheDocument();
    expect(screen.getByText("$2")).toBeInTheDocument();
  });

  it("shows the criteria, and says an agent is the one marking them", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/an agent approves or rejects against/i)).toBeInTheDocument();
    expect(screen.getByText(/Screenshot confirming the role update/)).toBeInTheDocument();
  });

  it("attributes the criteria to the client when no agent reviews", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 1, description: "The whole job",
      amountUsdc: 5, criteria: ["Delivered as SVG"], agentReviewed: false,
    });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/the client is looking for/i)).toBeInTheDocument();
    expect(screen.queryByText(/an agent approves/i)).not.toBeInTheDocument();
  });

  it("says the other stages stay funded, so nobody thinks this ends the job", async () => {
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/the rest stay\s+funded/i)).toBeInTheDocument();
  });

  it("does not claim a stage count on a single-stage job", async () => {
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 1, description: "The whole job",
      amountUsdc: 5, criteria: [], agentReviewed: false,
    });
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/pays in one stage/i)).toBeInTheDocument();
    expect(screen.queryByText(/milestone 1 of/i)).not.toBeInTheDocument();
  });

  it("still lets them deliver when the detail cannot be loaded", async () => {
    // Better to submit without the context than to be unable to submit at all.
    deliveryTarget.mockRejectedValue(new Error("offline"));
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));
    await userEvent.type(screen.getByRole("textbox"), "Done");
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
  });
});


/**
 * WAITING, WITHOUT WORRYING.
 *
 * A stage with the reviewer and a stage nobody has looked at are the same
 * silence from the freelancer's side. So is an agent that answers in minutes
 * and a client who answers when they next open the tab. The board said nothing
 * about any of it, and let them send the next stage anyway — which is how
 * somebody delivers twice without ever receiving a verdict.
 */
describe("a stage already with the reviewer", () => {
  const WAITING = {
    escrowId: "7", title: "fireball", budget: 5,
    status: "1 with the reviewer — the next stage opens once this one is decided",
    icon: "⏳", state: "hired", awaitingReview: 1, approved: 0, needsRevision: 0,
    milestoneCount: 2, canSubmit: false, reviewer: "agent" as const,
  };

  it("holds the button rather than inviting a second delivery", async () => {
    myWork.mockResolvedValue([WAITING]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText("fireball")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send work/i })).not.toBeInTheDocument();
  });

  it("says an agent is reviewing, and that it is quick", async () => {
    myWork.mockResolvedValue([WAITING]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/autopilot is reviewing/i)).toBeInTheDocument();
    expect(screen.getByText(/few minutes/i)).toBeInTheDocument();
  });

  it("warns that a human reviewer can take longer", async () => {
    myWork.mockResolvedValue([{ ...WAITING, reviewer: "client" }]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/client reviews this one themselves/i)).toBeInTheDocument();
  });
});

describe("a stage sent back for changes", () => {
  const SENT_BACK = {
    escrowId: "7", title: "fireball", budget: 5,
    status: "Changes requested — revise and send it again",
    icon: "✏️", state: "hired", awaitingReview: 0, approved: 0, needsRevision: 1,
    milestoneCount: 2, canSubmit: true, reviewer: "agent" as const,
  };

  it("lets them send again, and says the money is still theirs to win", async () => {
    myWork.mockResolvedValue([SENT_BACK]);
    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByRole("button", { name: /send work/i })).toBeInTheDocument();
    expect(screen.getByText(/still locked in escrow for you/i)).toBeInTheDocument();
  });

  it("shows the reviewer's reason — the only part they can act on", async () => {
    myWork.mockResolvedValue([SENT_BACK]);
    deliveryTarget.mockResolvedValue({
      escrowId: "7", index: 0, count: 2, description: "Stage one",
      amountUsdc: 3, criteria: [], agentReviewed: true,
      previousFeedback: "No deliverable was included — send a link to the work itself.",
    });

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /send work/i }));

    expect(await screen.findByText(/why this came back/i)).toBeInTheDocument();
    expect(screen.getByText(/send a link to the work itself/i)).toBeInTheDocument();
  });
});

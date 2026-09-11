import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PICKING UP A JOB A CLIENT HANDED OVER IN THE APP — AND PUTTING IT BACK DOWN.
 *
 * The delegation was real on-chain and completely inert for weeks: the app said
 * "Autopilot is running this job", the contract would have allowed it, and the
 * poller never looked because it only iterates its own task table. A client sat
 * watching an agent that had never heard of their job.
 *
 * Three things here have each already cost something real:
 *
 *   a revoked manager keeps its log forever, so the event is not the answer
 *   a job already in progress is a legitimate hand-off, not one to ignore
 *   every number comes from the escrow, never from the client's prose
 *
 * The last one shipped. The bot advertised a $50 job paying $10 and $40 while
 * the contract held 5 USDC split 1 and 4, because the description said "Budget
 * $50" and the brief was regenerated from the description.
 */

const AGENT = "0x000000000000000000000000000000000000A6E7";
const CLIENT = "0x1111111111111111111111111111111111111111";

const readContract = vi.fn();
const getBlockNumber = vi.fn(async () => 100n);
const getLogs = vi.fn(async () => [] as unknown[]);
const insertTask = vi.fn();
const deleteTask = vi.fn();
const listTasks = vi.fn(() => [] as any[]);
const generateBrief = vi.fn();

vi.mock("../src/web3/atelier.js", () => ({
  getPublicClient: () => ({ readContract, getBlockNumber, getLogs }),
}));
vi.mock("../src/circle/circleSigner.js", () => ({
  createCircleSigner: () => ({ address: AGENT }),
}));
const getPollerText = vi.fn(() => null as string | null);
const setPollerText = vi.fn();
vi.mock("../src/store.js", () => ({ insertTask, deleteTask, listTasks, getPollerText, setPollerText }));
vi.mock("../src/agent/BriefGenerator.js", () => ({ generateBrief }));
vi.mock("../src/config.js", () => ({
  config: {
    atelierAddress: "0x00000000000000000000000000000000000A7E11",
    atelierDeployBlock: 0n,
    logRangeLimit: 50n,
  },
}));

const { adoptDelegatedJobs } = await import("../src/agent/adoptDelegated.js");

const PENDING = 0, IN_PROGRESS = 1, RELEASED = 3;

function escrow(over: Record<string, unknown> = {}) {
  return {
    depositor: CLIENT,
    beneficiary: "0x0000000000000000000000000000000000000000",
    totalAmount: 5_000_000n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3 * 86400),
    status: PENDING,
    isOpenJob: true,
    projectTitle: "Coffee Roastery Logo",
    projectDescription: "A logo for a coffee roastery. Budget $50, 3 days.",
    ...over,
  };
}

/** The chain answers: we manage escrow 7, and it looks like `esc`. */
function chainSays(opts: { manager?: string; esc?: Record<string, unknown>; milestones?: any[] } = {}) {
  getLogs.mockResolvedValue([{ args: { escrowId: 7n } }]);
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "jobManager") return opts.manager ?? AGENT;
    if (functionName === "getEscrow") return escrow(opts.esc);
    if (functionName === "getMilestones")
      return opts.milestones ?? [
        { amount: 1_000_000n, requirements: "Concepts", description: "" },
        { amount: 4_000_000n, requirements: "Final files", description: "" },
      ];
    throw new Error(`unexpected read: ${functionName}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getBlockNumber.mockResolvedValue(100n);
  getLogs.mockResolvedValue([]);
  listTasks.mockReturnValue([]);
  generateBrief.mockResolvedValue({
    brief: { title: "Logo", budget: 50, durationDays: 3, criteria: ["vector"], milestones: [{ description: "All of it", amount: 50 }] },
  });
});

describe("finding what is ours", () => {
  it("adopts an escrow that names us as manager", async () => {
    chainSays();
    expect(await adoptDelegatedJobs()).toBe(1);
    expect(insertTask).toHaveBeenCalledOnce();
    expect(insertTask.mock.calls[0][0]).toMatchObject({ id: "delegated-7", escrowId: "7", clientAddress: CLIENT });
  });

  /* The event says we were appointed once. The mapping says whether we still
     are, and acting on the log alone is the agent working a job the client
     already took back. */
  it("ignores an escrow whose manager was revoked", async () => {
    chainSays({ manager: "0x0000000000000000000000000000000000000000" });
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it("ignores an escrow handed to a different manager", async () => {
    chainSays({ manager: "0x9999999999999999999999999999999999999999" });
    expect(await adoptDelegatedJobs()).toBe(0);
  });

  it("does not adopt the same job twice", async () => {
    chainSays();
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it("windows the log scan, because the RPC refuses a wide range", async () => {
    chainSays();
    await adoptDelegatedJobs();
    // 0–100 at a 50-block limit is three windows, never one call for the lot.
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of getLogs.mock.calls) {
      expect(Number(args.toBlock) - Number(args.fromBlock)).toBeLessThanOrEqual(50);
    }
  });
});

describe("which jobs are worth taking", () => {
  it("takes one with a freelancer already working, and goes straight to reviewing", async () => {
    chainSays({ esc: { status: IN_PROGRESS, beneficiary: "0x2222222222222222222222222222222222222222" } });
    expect(await adoptDelegatedJobs()).toBe(1);
    expect(insertTask.mock.calls[0][0].status).toBe("active");
  });

  it("posts a job with nobody hired yet", async () => {
    chainSays();
    await adoptDelegatedJobs();
    expect(insertTask.mock.calls[0][0].status).toBe("posted");
  });

  it("leaves a settled job alone — there is nothing left to decide", async () => {
    chainSays({ esc: { status: RELEASED } });
    expect(await adoptDelegatedJobs()).toBe(0);
  });
});

/**
 * The shipped bug. A client routinely edits the milestones before funding, so
 * the prose and the contract disagree — and only one of them can pay anyone.
 */
describe("what the job is worth", () => {
  it("takes every number from the escrow, not the client's description", async () => {
    chainSays();
    await adoptDelegatedJobs();

    const brief = JSON.parse(insertTask.mock.calls[0][0].briefJson);
    expect(brief.budget).toBe(5);
    expect(brief.milestones).toEqual([
      { description: "Concepts", amount: 1 },
      { description: "Final files", amount: 4 },
    ]);
    expect(brief.budget).not.toBe(50);
  });

  it("falls back to the milestone's description when it has no requirements", async () => {
    chainSays({ milestones: [{ amount: 2_000_000n, requirements: "", description: "Draft" }] });
    await adoptDelegatedJobs();
    expect(JSON.parse(insertTask.mock.calls[0][0].briefJson).milestones[0].description).toBe("Draft");
  });

  it("skips the job rather than adopting one it cannot price", async () => {
    chainSays();
    generateBrief.mockRejectedValue(new Error("model down"));
    expect(await adoptDelegatedJobs()).toBe(0);
    expect(insertTask).not.toHaveBeenCalled();
  });
});

/**
 * Taking a job back has to work as immediately as handing it over. The task row
 * outlived the revocation, so Browse Jobs kept showing "AUTOPILOT MANAGED" on a
 * job the agent was already locked out of.
 */
describe("giving a job back", () => {
  it("drops the task row when the client revokes", async () => {
    getLogs.mockResolvedValue([]);
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  it("keeps a job commissioned through the API, which is not ours to forget", async () => {
    getLogs.mockResolvedValue([]);
    listTasks.mockReturnValue([{ id: "task-abc", escrowId: "9" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("keeps a delegated job we still manage", async () => {
    chainSays();
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  /*
   * Revocation is not the only way a job stops being work. jobManager stays set
   * on a cancelled escrow forever, so the sweep above never noticed — and the
   * agent went on advertising `delegated-4`, status "posted", for a job that had
   * been cancelled and that the chain refused every call on.
   */
  it("releases a job the client has cancelled, even though we still manage it", async () => {
    chainSays({ esc: { status: 6 } });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  it("releases a job that has completed", async () => {
    chainSays({ esc: { status: 2 } });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).toHaveBeenCalledWith("delegated-7");
  });

  /* A failed read is not evidence that a job ended. */
  it("keeps the task when the escrow cannot be read", async () => {
    chainSays();
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "jobManager") return AGENT;
      throw new Error("rpc down");
    });
    listTasks.mockReturnValue([{ id: "delegated-7", escrowId: "7" }]);
    await adoptDelegatedJobs();
    expect(deleteTask).not.toHaveBeenCalled();
  });
});

describe("when there is no agent wallet", () => {
  it("does nothing rather than failing the poll", async () => {
    vi.resetModules();
    vi.doMock("../src/circle/circleSigner.js", () => ({
      createCircleSigner: () => { throw new Error("no Circle credentials"); },
    }));
    const { adoptDelegatedJobs: fresh } = await import("../src/agent/adoptDelegated.js");
    await expect(fresh()).resolves.toBe(0);
    vi.doUnmock("../src/circle/circleSigner.js");
  });
});

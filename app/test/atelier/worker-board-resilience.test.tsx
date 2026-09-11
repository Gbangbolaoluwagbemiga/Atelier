import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * ONE BAD READ MUST NOT EMPTY THE BOARD.
 *
 * The board loaded three things at once — the open jobs, your work, and your
 * balance — inside a single `Promise.all` with one catch around it. That makes
 * the page exactly as reliable as its least reliable read: a blink from the
 * open-jobs list threw away a perfectly good answer about the work on your
 * bench, and the board rendered "Nothing on your bench right now".
 *
 * That sentence, shown to somebody who has a funded job and money owed, is the
 * worst thing this page can say. It is a confident answer assembled out of a
 * failure — the same shape that made a freelancer's finished job disappear
 * twice before, one layer down each time.
 */

const myWork = vi.fn();
const quests = vi.fn();
const me = vi.fn();

vi.mock("@/lib/atelier/worker", () => ({
  myWork: (id: string) => myWork(id),
  quests: (id: string) => quests(id),
  me: (id: string) => me(id),
  submit: vi.fn(),
  deliveryTarget: vi.fn(),
  uploadAuth: vi.fn(),
  apply: vi.fn(),
  withdraw: vi.fn(),
  minutesUntilClose: () => 0,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/api", () => ({
  isApiConfigured: () => true,
  uploadMilestoneFileWithAuth: vi.fn(),
}));

const { WorkerBoard } = await import("@/components/atelier/worker-board");

const WORKER = {
  id: "w1",
  handle: "cdev",
  address: "0x8289da3f656fb9afb94e1074c7e88f0ad98ac423",
  mode: "managed",
  balance: "1.02",
} as never;

const THE_JOB = {
  escrowId: "7",
  title: "fireball",
  budget: 3,
  status: "All 2 stage(s) approved and paid",
  icon: "✅",
  state: "completed",
};

beforeEach(() => {
  vi.clearAllMocks();
  quests.mockResolvedValue([]);
  me.mockResolvedValue(WORKER);
  myWork.mockResolvedValue([THE_JOB]);
});

describe("the board when one read fails", () => {
  it("still shows your work when the open-jobs list fails", async () => {
    quests.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/fireball/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing on your bench/i)).not.toBeInTheDocument();
  });

  it("still shows your work when the balance read fails", async () => {
    // Exactly the reported case: the RPC was rate-limiting, so the balance came
    // back unreadable — and the whole dashboard reported an empty bench.
    me.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    expect(await screen.findByText(/fireball/)).toBeInTheDocument();
  });

  it("does not claim an empty bench when the work read itself failed", async () => {
    myWork.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={() => {}} />);

    await waitFor(() =>
      expect(screen.queryByText(/Nothing on your bench/i)).not.toBeInTheDocument(),
    );
  });

  it("passes on the balance it did get, even though another read failed", async () => {
    const onWorkerChanged = vi.fn();
    quests.mockRejectedValue(new Error("rate limit exceeded"));

    render(<WorkerBoard worker={WORKER} onWorkerChanged={onWorkerChanged} />);

    await waitFor(() => expect(onWorkerChanged).toHaveBeenCalledWith(WORKER));
  });
});

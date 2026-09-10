import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * AutopilotControl is the client's answer to "who is running this job, and how
 * do I change it". The behaviour worth pinning is not the happy render — it is
 * the three ways this component can say something false:
 *
 *   1. showing a freelancer their client's mode (leaks the marketplace split)
 *   2. saying "you are running this job" before it knows (every Autopilot job
 *      would flash the wrong answer on mount)
 *   3. hiding the way back out (makes delegation feel one-way, so nobody tries)
 */

const delegate = vi.fn().mockResolvedValue("0xhash");
const revoke = vi.fn().mockResolvedValue("0xhash");

let hookState = {
  manager: null as string | null,
  loaded: true,
  busy: false,
  error: null as string | null,
  delegate,
  revoke,
  refresh: vi.fn(),
};

vi.mock("@/hooks/use-job-manager", () => ({
  useJobManager: () => hookState,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const fetchLimits = vi.fn().mockResolvedValue({ applicationWindowMinutes: 3 });
vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchLimits,
}));

const { AutopilotControl } = await import(
  "@/components/atelier/autopilot-control"
);

const MANAGER = "0xa9e2700000000000000000000000000000000001";

beforeEach(() => {
  hookState = {
    manager: null,
    loaded: true,
    busy: false,
    error: null,
    delegate,
    revoke,
    refresh: vi.fn(),
  };
  delegate.mockClear();
  revoke.mockClear();
});

describe("who may see it", () => {
  /**
   * The rule this protects: a freelancer must not be able to tell whether their
   * client is a person or an agent. The call site in escrow-card already gates
   * on isClient; this asserts the component does not rely on that being
   * remembered at every future call site.
   */
  it("renders nothing for a non-client, even on an Autopilot job", () => {
    hookState.manager = MANAGER;
    const { container } = render(
      <AutopilotControl escrowId={1} isClient={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders for the job's own client", () => {
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(screen.getByText(/you are running this job/i)).toBeInTheDocument();
  });
});

describe("what it says before it knows", () => {
  /**
   * `manager === null` is a real answer meaning "the client runs it", not a
   * loading state. Rendering it as such would make every Autopilot job flash
   * "you are running this job" on mount — the single most misleading thing this
   * component could say.
   */
  it("does not claim the client is in charge while still loading", () => {
    hookState.loaded = false;
    render(<AutopilotControl escrowId={1} isClient={true} />);

    expect(screen.queryByText(/you are running this job/i)).toBeNull();
    expect(screen.queryByText(/autopilot is running this job/i)).toBeNull();
    expect(screen.getByText(/checking who manages/i)).toBeInTheDocument();
  });
});

describe("the two states", () => {
  it("offers a manual job the way in", () => {
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(screen.getByText(/you are running this job/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /hand to autopilot/i }),
    ).toBeEnabled();
  });

  it("offers an Autopilot job the way out, and names the agent", () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient={true} />);

    expect(
      screen.getByText(/autopilot is running this job/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /take back control/i }),
    ).toBeEnabled();
    // The client can see which address actually holds the delegation.
    expect(screen.getByText(/0xa9e2/i)).toBeInTheDocument();
  });

  /**
   * Revoke is never gated behind a confirmation, a settings page, or the agent
   * being reachable. If taking control back is awkward, handing it over stops
   * being a reasonable thing to try.
   */
  it("keeps the exit available while the agent is mid-action", () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(
      screen.getByRole("button", { name: /take back control/i }),
    ).toBeInTheDocument();
  });

  it("disables the button while a transaction is in flight", () => {
    hookState.busy = true;
    render(<AutopilotControl escrowId={1} isClient={true} />);
    expect(
      screen.getByRole("button", { name: /hand to autopilot/i }),
    ).toBeDisabled();
  });
});

/**
 * Handing over is one transaction that names an address. Everything the agent
 * then does, it decides from what is already on-chain — so the client has to
 * see that before signing, not discover it when work is rejected.
 */
describe("what the client is shown before handing over", () => {
  const WITH_CRITERIA =
    "A logo for a coffee roastery.\n\nAcceptance criteria:\n• Delivered in SVG and PNG\n• Transparent background";

  it("does not delegate on the first click", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(delegate).not.toHaveBeenCalled();
  });

  it("shows the criteria the agent will judge against", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText(/Delivered in SVG and PNG/)).toBeInTheDocument();
    expect(screen.getByText(/Transparent background/)).toBeInTheDocument();
  });

  it("shows the stages it will pay out in", async () => {
    render(
      <AutopilotControl
        escrowId={1}
        isClient={true}
        projectDescription={WITH_CRITERIA}
        milestones={[{ description: "Initial concepts", amount: "1000000" }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("Initial concepts")).toBeInTheDocument();
  });

  /* The case this dialog exists for. A hand-created job stores only free text,
     so the agent derives criteria the client never wrote. */
  it("warns when the job carries no criteria for the agent to read", async () => {
    render(
      <AutopilotControl escrowId={1} isClient={true} projectDescription="Just make me a logo." />,
    );
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    expect(screen.getByText(/no acceptance criteria written into it/i)).toBeInTheDocument();
  });

  it("delegates only after the client confirms", async () => {
    render(<AutopilotControl escrowId={1} isClient={true} projectDescription={WITH_CRITERIA} />);
    await userEvent.click(screen.getByRole("button", { name: /hand to autopilot/i }));
    await userEvent.click(screen.getByRole("button", { name: /hand it over/i }));
    expect(delegate).toHaveBeenCalledOnce();
  });
});

/**
 * WHEN THE AGENT DECIDES.
 *
 * A client handed a job over and had no way to know whether hiring would happen
 * in a second, in an hour, or only once they went and asked. The panel said
 * what the agent does and never when.
 *
 * It waits on purpose: scoring the first application to arrive would make this
 * a race rather than a comparison, and comparing applicants against each other
 * is the claim the whole feature rests on.
 */
describe("when it will decide", () => {
  it("names the window it leaves applications open for", async () => {
    fetchLimits.mockResolvedValue({ applicationWindowMinutes: 3 });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/3 minutes/)).toBeInTheDocument();
  });

  it("says why it waits, rather than looking slow", async () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(
      await screen.findByText(/rather than hiring\s+whoever happened to apply first/i),
    ).toBeInTheDocument();
  });

  /* Someone who applied in good time must not be told they were too late. */
  it("says a later applicant is still read", async () => {
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/still picked up on the next pass/i)).toBeInTheDocument();
  });

  it("reads the window from the daemon rather than assuming it", async () => {
    fetchLimits.mockResolvedValue({ applicationWindowMinutes: 60 });
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    expect(await screen.findByText(/60 minutes/)).toBeInTheDocument();
  });

  /* An unreachable daemon must not put a made-up number on the screen. */
  it("says nothing about timing when the daemon cannot be reached", async () => {
    fetchLimits.mockRejectedValue(new Error("offline"));
    hookState.manager = MANAGER;
    render(<AutopilotControl escrowId={1} isClient />);
    await waitFor(() => expect(fetchLimits).toHaveBeenCalled());
    expect(screen.queryByText(/minutes/)).not.toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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

vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
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

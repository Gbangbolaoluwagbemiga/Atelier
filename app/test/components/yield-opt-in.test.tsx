import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * THE SWITCH THAT TURNS THE "🌱 EARNING" BADGE ON.
 *
 * These two pieces are one feature and were shipped as half of one: the badge
 * reads `escrowDeployed`, and until this control existed nothing in the app
 * could ever make that number non-zero. The badge was therefore invisible on
 * every job, on every page, and no test caught it — because the badge had no
 * test either.
 *
 * So the thing being pinned down here is not "does the switch render". It is:
 *
 *   the switch is offered only when flipping it can actually lead somewhere
 *   the badge appears only when money is genuinely out earning
 *
 * Both directions matter. A control that does nothing wastes a client's time;
 * a badge promising a bonus that never arrives costs a freelancer money they
 * were counting on.
 */

const getYieldStatus = vi.fn();
const setYieldOptIn = vi.fn().mockResolvedValue("0xhash");

vi.mock("wagmi", () => ({ useWriteContract: () => ({ writeContractAsync: vi.fn() }) }));
vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class {
    getYieldStatus = getYieldStatus;
    setYieldOptIn = setYieldOptIn;
  },
}));

const { YieldOptIn } = await import("@/components/atelier/yield-opt-in");

const LIVE = { available: true, optedIn: false, deployed: 0n, freelancerShareBP: 6000 };

function panel(props: Record<string, unknown> = {}) {
  return render(<YieldOptIn escrowId={4} isClient status="active" {...props} />);
}

beforeEach(() => {
  setYieldOptIn.mockClear();
  getYieldStatus.mockResolvedValue({ ...LIVE });
});

describe("when the switch is offered", () => {
  it("appears once a controller and a venue both exist", async () => {
    panel();
    expect(await screen.findByTestId("yield-opt-in")).toBeInTheDocument();
  });

  /* This is the live testnet state today: a controller is set, but no adapter
     is configured for the token, so opting in could not deploy a cent. */
  it("stays hidden when there is no venue to invest in", async () => {
    getYieldStatus.mockResolvedValue({ ...LIVE, available: false });
    panel();
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-opt-in")).not.toBeInTheDocument();
  });

  it("is never shown to the freelancer, whose money this is not", async () => {
    panel({ isClient: false });
    await waitFor(() => expect(screen.queryByTestId("yield-opt-in")).not.toBeInTheDocument());
  });

  it("is not offered on a job with nothing left to invest", async () => {
    panel({ status: "completed" });
    await waitFor(() => expect(screen.queryByTestId("yield-opt-in")).not.toBeInTheDocument());
  });
});

describe("what it tells the client", () => {
  it("names the freelancer's actual share, read from the contract", async () => {
    panel();
    expect(await screen.findByText(/60% of anything beyond that/i)).toBeInTheDocument();
  });

  it("says the fee is covered before anyone else is paid", async () => {
    panel();
    expect(await screen.findByText(/covers your platform fee\s*first/i)).toBeInTheDocument();
  });

  it("shows how much is out earning, in dollars rather than raw units", async () => {
    getYieldStatus.mockResolvedValue({ ...LIVE, optedIn: true, deployed: 4_250_000n });
    panel();
    expect(await screen.findByTestId("yield-deployed")).toHaveTextContent("$4.25");
  });

  it("says nothing about a deployed amount when nothing is deployed", async () => {
    panel();
    await screen.findByTestId("yield-opt-in");
    expect(screen.queryByTestId("yield-deployed")).not.toBeInTheDocument();
  });
});

describe("flipping it", () => {
  it("asks the contract to opt in", async () => {
    panel();
    await userEvent.click(await screen.findByTestId("yield-switch"));
    await waitFor(() => expect(setYieldOptIn).toHaveBeenCalled());
    expect(setYieldOptIn.mock.calls[0].slice(0, 2)).toEqual([4, true]);
  });

  it("can be switched back off, since consent is not one-way", async () => {
    getYieldStatus.mockResolvedValue({ ...LIVE, optedIn: true });
    panel();
    await userEvent.click(await screen.findByTestId("yield-switch"));
    await waitFor(() => expect(setYieldOptIn).toHaveBeenCalled());
    expect(setYieldOptIn.mock.calls[0][1]).toBe(false);
  });
});

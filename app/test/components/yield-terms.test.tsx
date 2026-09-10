import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * THE YIELD SHARE IS A TERM OF THE JOB, NOT A SETTING ON IT.
 *
 * It used to be a switch on the job page, live for the whole life of the
 * escrow. A freelancer reads "this escrow earns while you work and 60% of what
 * it earns is yours" on the board and applies partly because of it — so a
 * client able to flip that off after hiring would be changing the deal after
 * the other side accepted, with no recourse and no notice.
 *
 * It is now asked once while posting, and the contract refuses to let it change
 * once anybody is hired. These two suites are the two halves of that: the
 * question at the start, and the statement of the answer afterwards.
 */

const getYieldStatus = vi.fn();

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: "0xC11E27", isConnected: true } }),
}));
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: class { getYieldStatus = getYieldStatus; },
}));

const { YieldOptIn } = await import("@/components/atelier/yield-opt-in");
const { YieldChoice } = await import("@/components/create/yield-choice");

const EARNING = { available: true, optedIn: true, deployed: 0n, freelancerShareBP: 6000 };

beforeEach(() => {
  getYieldStatus.mockReset();
  getYieldStatus.mockResolvedValue({ ...EARNING });
});

/**
 * Open the chip's tooltip.
 *
 * Radix renders the content twice — once visibly, once in a visually-hidden
 * node for screen readers — so every assertion on tooltip text uses the
 * `All` queries. Matching one would be matching an implementation detail of
 * which copy came first.
 *
 * `userEvent.hover` is not enough: Radix's trigger opens on `pointermove` with
 * a non-touch pointerType, which hover does not dispatch. Focus is sent too, so
 * this covers the keyboard path a screen-reader user takes as well as the mouse
 * one — and if either ever stops working, these go red.
 */
async function openTooltip(chip: HTMLElement) {
  fireEvent.pointerMove(chip, { pointerType: "mouse" });
  fireEvent.focus(chip);
}

describe("choosing, while the job is being posted", () => {
  function choice(props: Record<string, unknown> = {}) {
    const onChange = vi.fn();
    render(<YieldChoice value={false} onChange={onChange} fee={1.25} {...props} />);
    return onChange;
  }

  /* "Enable yield optimisation" is a feature name. "Your fee comes back out of
     what the escrow earns" is a reason, and it is the actual decision. */
  it("frames it as who pays the fee, and names the amount", () => {
    choice();
    expect(screen.getByTestId("yield-choice-fee")).toHaveTextContent("$1.25");
  });

  it("says out loud that it cannot be changed later", () => {
    choice();
    expect(screen.getByText(/cannot be changed after someone is hired/i)).toBeInTheDocument();
  });

  /* A client should know they are agreeing to the freelancer's share before
     they agree to it, not discover it at settlement. */
  it("states the freelancer's share up front", () => {
    choice();
    expect(screen.getByTestId("yield-choice-yield")).toHaveTextContent(/60%/);
  });

  it("defaults to the client paying, never to opting in silently", () => {
    choice();
    expect(screen.getByTestId("yield-choice-fee")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("yield-choice-yield")).toHaveAttribute("aria-checked", "false");
  });

  it("reports the choice when the client picks the escrow route", async () => {
    const onChange = choice();
    await userEvent.click(screen.getByTestId("yield-choice-yield"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("can be changed back while still on this screen", async () => {
    const onChange = choice({ value: true });
    await userEvent.click(screen.getByTestId("yield-choice-fee"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("mentions the 🌱 tag only once the client has chosen it", () => {
    const { rerender } = render(<YieldChoice value={false} onChange={() => {}} fee={1} />);
    expect(screen.queryByTestId("yield-choice-note")).not.toBeInTheDocument();
    rerender(<YieldChoice value onChange={() => {}} fee={1} />);
    expect(screen.getByTestId("yield-choice-note")).toBeInTheDocument();
  });
});

/**
 * The chip is four words; the detail lives on hover.
 *
 * It used to be a paragraph in a bordered box halfway down the card, restating
 * the mechanism to a client who had already agreed to it when they posted the
 * job — on every card, pushing what actually needs attention further down. A
 * standing fact is not news, and news is what earns vertical space.
 */
describe("stating it, once the job exists", () => {
  const panel = (props: Record<string, unknown> = {}) =>
    render(<YieldOptIn escrowId={5} status="active" {...props} />);

  it("is a short chip, not a paragraph", async () => {
    panel();
    const chip = await screen.findByTestId("yield-status");
    expect(chip).toHaveTextContent(/^Escrow yield$/);
  });

  it("is reachable to a screen reader without hovering anything", async () => {
    panel();
    expect(await screen.findByLabelText(/earns while the job runs/i)).toBeInTheDocument();
  });

  it("keeps the detail out of the way until someone asks for it", async () => {
    panel();
    await screen.findByTestId("yield-status");
    expect(screen.queryByText(/60% of anything beyond that/i)).not.toBeInTheDocument();
  });

  it("explains the split on hover", async () => {
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByText(/60% of anything beyond that/i)).length).toBeGreaterThan(0);
  });

  it("says on hover that the term was fixed when the job was posted", async () => {
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByText(/fixed since/i)).length).toBeGreaterThan(0);
  });

  it("shows how much is out earning, in dollars", async () => {
    getYieldStatus.mockResolvedValue({ ...EARNING, deployed: 4_250_000n });
    panel();
    await openTooltip(await screen.findByTestId("yield-status"));
    expect((await screen.findAllByTestId("yield-deployed"))[0]).toHaveTextContent("$4.25");
  });

  /* The whole point of the change upstream: there is nothing here to click. */
  it("offers no control to change it", async () => {
    panel();
    await screen.findByTestId("yield-status");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /* A job that behaves like every other job has nothing to tell anyone. */
  it("renders nothing at all on a job that does not earn", async () => {
    getYieldStatus.mockResolvedValue({ ...EARNING, optedIn: false });
    panel();
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-status")).not.toBeInTheDocument();
  });

  it("renders nothing once the job has settled", async () => {
    panel({ status: "completed" });
    await waitFor(() => expect(getYieldStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("yield-status")).not.toBeInTheDocument();
  });
});

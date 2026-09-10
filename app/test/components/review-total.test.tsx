import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * THE NUMBER THE WALLET IS ABOUT TO ASK FOR.
 *
 * A client posting a 5 USDC job chose "let the escrow earn it", read a line
 * saying the platform fee was "covered by what the escrow earns", and then
 * watched their wallet request 5.1250. Nothing on the review page added up to
 * that figure, so the only available conclusion was that something was out of
 * sync.
 *
 * Nothing was out of sync. `createEscrow` charges budget + fee unconditionally
 * — the escrow contract has no idea the yield controller exists — and the copy
 * was describing a refund that arrives later, out of earnings, as though it
 * were a bill avoided now.
 *
 * So the last thing this page shows before the signature is the same number the
 * signature is for.
 */

vi.mock("wagmi", () => ({ useWriteContract: () => ({ writeContractAsync: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ReviewStep } = await import("@/components/create/review-step");

function review(over: Record<string, unknown> = {}) {
  return render(
    <ReviewStep
      formData={{
        projectTitle: "kairos",
        projectDescription: "A payment firewall.",
        duration: "10",
        totalBudget: "5",
        beneficiary: "",
        token: "",
        useNativeToken: true,
        isOpenJob: true,
        yieldOptIn: false,
        milestones: [
          { description: "Admin panel", amount: "2" },
          { description: "Analytics service", amount: "3" },
        ],
        ...over,
      } as never}
      onConfirm={() => {}}
      onYieldChange={() => {}}
      isSubmitting={false}
      isContractPaused={false}
    />,
  );
}

describe("what the client is told they will pay", () => {
  it("shows budget plus fee, which is what the wallet asks for", () => {
    review();
    // 5.00 + 2.5% = 5.1250 — the exact figure in the approval dialog.
    expect(screen.getByTestId("approval-total")).toHaveTextContent("5.1250");
  });

  it("shows the fee as its own line, so the total can be checked", () => {
    review();
    expect(screen.getByText(/platform fee \(2\.5%\)/i)).toBeInTheDocument();
    expect(screen.getByText("0.13")).toBeInTheDocument();
  });

  /* The bug in one assertion: choosing yield must not change the total. */
  it("charges the same whether or not the escrow is put to work", () => {
    const first = review();
    const withoutYield = screen.getByTestId("approval-total").textContent;
    first.unmount();

    review({ yieldOptIn: true });
    expect(screen.getByTestId("approval-total")).toHaveTextContent(withoutYield!);
  });

  it("never claims the fee is covered, since it is charged either way", () => {
    review({ yieldOptIn: true });
    expect(screen.queryByText(/covered by what the escrow earns/i)).not.toBeInTheDocument();
  });

  /* What opting in actually buys: a refund, arriving as earnings do. */
  it("explains the fee comes back out of earnings when yield is on", () => {
    review({ yieldOptIn: true });
    expect(screen.getByText(/comes back to you out of what the escrow earns/i)).toBeInTheDocument();
  });

  it("says nothing about a refund when the escrow just waits", () => {
    review();
    expect(screen.queryByText(/comes back to you out of/i)).not.toBeInTheDocument();
  });
});

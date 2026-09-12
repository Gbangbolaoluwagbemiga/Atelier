import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * THE EDITOR APPEARS WHEN THE CHAIN CAN ACTUALLY DO IT.
 *
 * The source is ahead of the proxy: setMilestones is written and tested, and
 * the deployed implementation does not have it yet. Shipping the button anyway
 * would give a client a control that reverts, and a revert on a job holding
 * their money is the worst place to discover a version mismatch.
 *
 * So the app asks the chain. A deployed contract's dispatch table carries the
 * selector of every function it answers, which makes its presence in the
 * runtime bytecode a direct answer to "is this live yet" — and unlike calling
 * and catching the revert, it costs nothing and cannot be confused with a guard
 * legitimately refusing somebody who has already started work.
 */

const getBytecode = vi.fn();
const getStorageAt = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: () => ({ getBytecode, getStorageAt }) };
});
vi.mock("@/providers/WalletProvider", () => ({ arcTestnet: { id: 5042002 } }));

const { ContractService, SET_MILESTONES_SELECTOR } = await import("@/lib/web3/contract-service");

/** A dispatch table with the selector in it, and one without. */
const WITH = `0x6080604052${SET_MILESTONES_SELECTOR}8063aabbccdd`;
const WITHOUT = "0x6080604052806312345678638063aabbccdd";

/** The implementation address, as a proxy stores it: left-padded to 32 bytes. */
const IMPL = "0x16789a37a359d141e7fdfd64fa4fb317446c93f6";
const SLOT_VALUE = `0x${"0".repeat(24)}${IMPL.slice(2)}`;

beforeEach(() => {
  vi.clearAllMocks();
  getStorageAt.mockResolvedValue(SLOT_VALUE);
});

describe("detecting whether milestone editing is deployed", () => {
  it("says yes when the selector is in the bytecode", async () => {
    getBytecode.mockResolvedValue(WITH);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(true);
  });

  it("says no against the implementation that predates it", async () => {
    getBytecode.mockResolvedValue(WITHOUT);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });

  it("is case-insensitive, because bytecode casing is not guaranteed", async () => {
    getBytecode.mockResolvedValue(WITH.toUpperCase().replace("0X", "0x"));
    expect(await new ContractService().supportsMilestoneEditing()).toBe(true);
  });

  it("hides the editor rather than guessing when the read fails", async () => {
    // A rate-limited RPC must not produce a button that reverts. Unknown is not
    // yes — and unlike the reads elsewhere in this app, the safe default here is
    // to show less, because the cost of being wrong lands on a funded escrow.
    getBytecode.mockRejectedValue(new Error("rate limit exceeded"));
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });

  it("treats an address with no code as not supporting it", async () => {
    getBytecode.mockResolvedValue(undefined);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });
});


/**
 * IT HAS TO LOOK BEHIND THE PROXY.
 *
 * The first version read the proxy's own bytecode and answered "no" for every
 * function, including addJobFunds, which is unarguably deployed. A UUPS proxy's
 * code is the delegating stub; the dispatch table lives in the implementation.
 *
 * The unit tests passed anyway, because they fed the checker a made-up string.
 * Only asking the real chain showed it up — which is why this one asserts on
 * WHERE it looked, not just on what it concluded.
 */
describe("looking behind the proxy", () => {
  it("reads the implementation's code, not the proxy's", async () => {
    getBytecode.mockResolvedValue(WITH);

    await new ContractService("0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE").supportsMilestoneEditing();

    expect(getStorageAt).toHaveBeenCalled();
    expect(getBytecode).toHaveBeenCalledWith({ address: IMPL });
  });

  it("falls back to the address itself when nothing is proxied", async () => {
    // A bare deployment keeps its dispatch table in its own code.
    getStorageAt.mockResolvedValue(`0x${"0".repeat(64)}`);
    getBytecode.mockResolvedValue(WITH);

    const addr = "0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE";
    expect(await new ContractService(addr).supportsMilestoneEditing()).toBe(true);
    expect(getBytecode).toHaveBeenCalledWith({ address: addr });
  });

  it("still answers no when the implementation predates the function", async () => {
    getBytecode.mockResolvedValue(WITHOUT);
    expect(await new ContractService().supportsMilestoneEditing()).toBe(false);
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * WHICH JOBS AUTOPILOT RUNS — two sources, one answer.
 *
 * The board reads the daemon's task table: one request for the whole page
 * instead of an RPC call per card. That is the right trade and it means the
 * board lags a hand-over by the agent's next sweep.
 *
 * My Jobs reads the chain directly, so it is instant. The two live on separate
 * routes, so a client who delegates and then walks to the board sees their own
 * action undone by a slower source — badge gone, exactly what it looked like
 * before the delegation.
 */

const fetchManagedEscrowIds = vi.fn();
vi.mock("@/lib/atelier/agent-api", () => ({
  AUTOPILOT_CONFIGURED: true,
  fetchManagedEscrowIds: (s?: AbortSignal) => fetchManagedEscrowIds(s),
}));

const knownJobManagers = vi.fn();
vi.mock("@/hooks/use-job-manager", () => ({
  JOB_MANAGER_EVENT: "atelier:job-manager",
  knownJobManagers: () => knownJobManagers(),
}));

const { useManagedEscrows } = await import("@/hooks/use-managed-escrows");

beforeEach(() => {
  vi.clearAllMocks();
  fetchManagedEscrowIds.mockResolvedValue(new Set<string>());
  knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set() });
});

describe("merging what this browser already knows", () => {
  it("shows a delegation the daemon has not swept yet", async () => {
    fetchManagedEscrowIds.mockResolvedValue(new Set<string>());
    knownJobManagers.mockReturnValue({ managed: new Set(["8"]), unmanaged: new Set() });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.managed.has("8")).toBe(true));
  });

  it("hides a revocation the daemon still lists", async () => {
    // The other direction matters just as much: the agent is locked out
    // on-chain the moment it is revoked, so advertising it is a false claim.
    fetchManagedEscrowIds.mockResolvedValue(new Set(["8"]));
    knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set(["8"]) });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.managed.has("8")).toBe(false);
  });

  it("keeps the daemon's answer for jobs this browser has not read", async () => {
    // Someone else's delegation is the daemon's to report, and it is right.
    fetchManagedEscrowIds.mockResolvedValue(new Set(["2", "5"]));
    knownJobManagers.mockReturnValue({ managed: new Set(), unmanaged: new Set() });

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.managed.size).toBe(2));
    expect(result.current.managed.has("2")).toBe(true);
  });

  it("still shows nothing when the daemon is unreachable and nothing is known", async () => {
    // A missing badge under-claims, which is the safe direction for a label a
    // freelancer relies on.
    fetchManagedEscrowIds.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useManagedEscrows());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.managed.size).toBe(0);
  });
});

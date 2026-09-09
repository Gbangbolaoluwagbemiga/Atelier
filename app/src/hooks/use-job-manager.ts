/**
 * Reading and changing who manages a job.
 *
 * The on-chain `jobManager` is the authority here, not the agent daemon's task
 * table. The daemon knows what it BELIEVES it manages; the contract knows what
 * it will actually let the agent do. When they disagree — a client revoked
 * management and the daemon has not polled since — the contract is right.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { useWeb3 } from "@/contexts/web3-context";
import { contractService } from "@/lib/web3/contract-service";
import { humanizeError } from "@/lib/atelier/errors";
import {
  AUTOPILOT_CONFIGURED,
  fetchAutopilotAddress,
} from "@/lib/atelier/agent-api";

export interface JobManagerState {
  /** The managing agent's address, or null when the client runs the job. */
  manager: string | null;
  /** True once we know — `manager === null` is a real answer, not "loading". */
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** Hand this job to Autopilot. Resolves to the transaction hash. */
  delegate: () => Promise<string>;
  /** Take it back. Effective on the agent's very next call. */
  revoke: () => Promise<string>;
  refresh: () => Promise<void>;
}

export function useJobManager(escrowId: number | null): JobManagerState {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  /* Held in a ref so settle() can call the current refresh without the two
     depending on each other and rebuilding on every render. */
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  /**
   * Wait for the transaction to be mined before believing anything about it.
   *
   * writeContractAsync resolves when a transaction is SUBMITTED, so refreshing
   * straight afterwards read the chain as it was before the call landed. The
   * UI then reported the opposite of what had just happened -- "you are running
   * this job again" while the agent was still the manager on-chain, or the
   * reverse after delegating -- and the only way to find out which was true was
   * to reload.
   */
  const settle = useCallback(
    async (hash: `0x${string}`) => {
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await refreshRef.current();
      return hash;
    },
    [publicClient],
  );

  const [manager, setManager] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (escrowId === null) {
      setManager(null);
      setLoaded(true);
      return;
    }
    const current = await contractService.getJobManager(escrowId);
    setManager(current);
    setLoaded(true);
  }, [escrowId]);

  refreshRef.current = refresh;

  useEffect(() => {
    /* Reset before refetching. Without this, switching from an Autopilot job to
       a manual one briefly renders the previous job's manager as this one's. */
    setLoaded(false);
    setManager(null);
    void refresh();
  }, [refresh]);

  const delegate = useCallback(async () => {
    if (escrowId === null) throw new Error("No job selected.");
    if (!AUTOPILOT_CONFIGURED) {
      throw new Error("Autopilot is not configured for this deployment.");
    }
    setBusy(true);
    setError(null);
    try {
      // Ask the daemon which key it currently signs with, rather than trusting
      // a build-time constant that could be a redeploy out of date.
      const { address } = await fetchAutopilotAddress();

      if (address.toLowerCase() === wallet.address?.toLowerCase()) {
        throw new Error(
          "Autopilot reports your own address as its wallet — refusing to delegate.",
        );
      }

      const hash = await contractService.setJobManager(
        { escrow_id: escrowId, manager: address },
        writeContractAsync,
      );
      return await settle(hash);
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [escrowId, wallet.address, writeContractAsync, settle]);

  const revoke = useCallback(async () => {
    if (escrowId === null) throw new Error("No job selected.");
    setBusy(true);
    setError(null);
    try {
      const hash = await contractService.revokeJobManager(
        escrowId,
        writeContractAsync,
      );
      return await settle(hash);
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [escrowId, writeContractAsync, settle]);

  return { manager, loaded, busy, error, delegate, revoke, refresh };
}

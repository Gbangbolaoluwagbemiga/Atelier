/**
 * Which jobs Autopilot is running.
 *
 * Read from the agent's own task table rather than from the chain, and that is
 * a deliberate trade. The on-chain `jobManager` is authoritative about what the
 * agent is PERMITTED to do; the task table is authoritative about what it is
 * actually doing. For a badge on a job card the second is the useful one — and
 * reading it costs one request instead of one RPC call per job on the board.
 *
 * Fails soft to an empty set. The daemon being unreachable should mean no
 * badges, not a broken marketplace: a missing badge under-claims, and
 * under-claiming is the safe direction for a label a freelancer relies on.
 */

import { useEffect, useState } from "react";
import {
  AUTOPILOT_CONFIGURED,
  fetchManagedEscrowIds,
} from "@/lib/atelier/agent-api";

export function useManagedEscrows(): {
  managed: Set<string>;
  loaded: boolean;
} {
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!AUTOPILOT_CONFIGURED) {
      setLoaded(true);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    fetchManagedEscrowIds(controller.signal)
      .then((ids) => {
        if (!cancelled) setManaged(ids);
      })
      .catch(() => {
        /* Unreachable agent means no badges, not a broken board. */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return { managed, loaded };
}

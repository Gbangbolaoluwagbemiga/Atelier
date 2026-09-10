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
 *
 * WHY IT POLLS
 *
 * It used to read once on mount and never again, with no way to ask it to look
 * again. So handing a job to Autopilot changed nothing on the board: the job
 * list refetched happily, the badge stayed missing, and the only thing that
 * brought it back was a full page reload — which remounted the hook. The
 * Refresh button spun and could not have helped.
 *
 * Two things have to move before the badge is right, and only one of them is
 * ours. Delegation is on-chain immediately; the daemon only learns about it on
 * its next sweep, which runs every fifteen seconds. So this polls rather than
 * fetching once, and the interval is set below that sweep — the answer cannot
 * arrive before the agent has it, and there is no point asking faster than it
 * can change.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AUTOPILOT_CONFIGURED,
  fetchManagedEscrowIds,
} from "@/lib/atelier/agent-api";

/** Below the daemon's own 15s adoption sweep — see the note above. */
const POLL_MS = 10_000;

export function useManagedEscrows(): {
  managed: Set<string>;
  loaded: boolean;
  /** Ask again now. Wired to the board's Refresh, which otherwise did nothing. */
  refresh: () => void;
} {
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!AUTOPILOT_CONFIGURED) {
      setLoaded(true);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    const read = () =>
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

    void read();
    const timer = setInterval(() => void read(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [tick]);

  return { managed, loaded, refresh };
}

/**
 * The managed-wallet session, for chrome that needs to know somebody is signed
 * in without a wallet.
 *
 * Separate from useWeb3 on purpose. Web3 context answers "is a wallet
 * connected"; this answers "is a person signed in", and on Atelier those are
 * different questions with different answers — the whole managed-worker door
 * exists because the second can be yes while the first is no.
 *
 * Polls rather than subscribing, because the balance changes when a milestone
 * is approved somewhere else entirely and there is no event to listen for from
 * here.
 */

import { useCallback, useEffect, useState } from "react";
import {
  WORKER_DOOR_OPEN,
  currentWorkerId,
  forgetWorker,
  me as fetchMe,
  type Worker,
} from "@/lib/atelier/worker";

export function useManagedWorker(): Worker | null {
  const [worker, setWorker] = useState<Worker | null>(null);

  const load = useCallback(async () => {
    const id = currentWorkerId();
    if (!WORKER_DOOR_OPEN || !id) {
      setWorker(null);
      return;
    }
    try {
      setWorker(await fetchMe(id));
    } catch {
      /* A wiped dev database leaves a stale id behind. Clear it rather than
         showing an address that no longer exists. */
      forgetWorker();
      setWorker(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return worker;
}

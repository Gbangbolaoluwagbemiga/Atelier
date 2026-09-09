// Reads from the Atelier subgraph, or from the chain when there isn't one.
import { config } from "../config.js";
import { applicationsFromChain, escrowFromChain } from "./chain-fallback.js";

export function isGraphConfigured(): boolean {
  return Boolean(config.graphUrl);
}

/**
 * True for reads the hire loop cannot proceed without.
 *
 * Matched on the query's operation name rather than the whole string so
 * whitespace or a field reordering does not quietly drop a query back onto the
 * throwing path — which is the failure this exists to prevent.
 */
function singleEscrowRead(query: string): "applications" | "escrow" | null {
  if (query.includes("query GetJobApplications")) return "applications";
  if (query.includes("query GetJobById")) return "escrow";
  return null;
}

export async function graphQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!config.graphUrl) {
    /*
     * Without this the daemon simply stopped.
     *
     * The poller's first step for a posted job is GetJobApplications, and this
     * function threw when GRAPH_URL was unset — so with no subgraph deployed
     * nothing was ever scored and nobody was ever hired. It read as the agent
     * being idle rather than as a missing dependency, which is the worst way
     * for a dependency to be missing.
     *
     * The subgraph remains the fast path and the right answer for lists,
     * history and anything spanning escrows. These two reads concern one
     * escrow, so the chain can answer them directly and the product degrades
     * in speed instead of halting.
     */
    const kind = singleEscrowRead(query);
    const escrowId = variables?.escrowId;
    if (kind && escrowId != null) {
      return (kind === "applications"
        ? await applicationsFromChain(String(escrowId))
        : await escrowFromChain(String(escrowId))) as T;
    }
    throw new Error("GRAPH_URL is not set, and this query has no chain fallback");
  }

  const res = await fetch(config.graphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data as T;
}

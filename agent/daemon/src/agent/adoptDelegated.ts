// adoptDelegated.ts — pick up jobs a client handed to us from the app.
//
// WHY THIS EXISTS
//
// The daemon only ever worked on tasks it created itself, through /api/instruct
// or /api/hire. A client posting through Autopilot in the app takes a different
// route: they fund the escrow from their own wallet and call setJobManager,
// which names us on-chain. Nothing told the daemon.
//
// So the delegation was real and completely inert. The app reads jobManager
// from the chain and correctly said "Autopilot is running this job", the
// contract would have let us hire and approve, and the poller never looked
// because it iterates its own task table. The client watched an agent that had
// never heard of their job.
//
// This closes that gap from the chain side: find escrows where we are the
// manager, and give each one a task row so the existing poller takes it from
// there. Nothing else about the loop changes.
import { getAddress, type Abi } from "viem";
import atelierAbi from "../web3/AtelierABI.json" with { type: "json" };
import { config } from "../config.js";
import { getPublicClient } from "../web3/atelier.js";
import { createCircleSigner } from "../circle/circleSigner.js";
import * as store from "../store.js";
import { generateBrief } from "./BriefGenerator.js";

const abi = atelierAbi as Abi;

interface RawEscrow {
  depositor: string;
  beneficiary: string;
  totalAmount: bigint;
  deadline: bigint;
  status: number;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
}

/** Escrow ids currently naming `manager` on-chain, newest assignment winning. */
async function delegatedTo(manager: `0x${string}`): Promise<bigint[]> {
  const client = getPublicClient();
  const event = {
    type: "event",
    name: "JobManagerSet",
    inputs: [
      { name: "escrowId", type: "uint256", indexed: true },
      { name: "manager", type: "address", indexed: true },
    ],
  } as const;

  const latest = await client.getBlockNumber();
  const seen = new Set<bigint>();

  // Windowed because public RPCs cap a getLogs range and refuse a wide one
  // outright rather than truncating it.
  for (let from = config.atelierDeployBlock; from <= latest; from += config.logRangeLimit + 1n) {
    const to = from + config.logRangeLimit > latest ? latest : from + config.logRangeLimit;
    const logs = await client.getLogs({
      address: config.atelierAddress,
      event,
      args: { manager },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const id = (log as { args?: { escrowId?: bigint } }).args?.escrowId;
      if (id !== undefined) seen.add(id);
    }
  }

  // The event says we were appointed once; the mapping says whether we still
  // are. A revoked manager keeps its log forever, and acting on that would be
  // the agent working a job the client had already taken back.
  const still = await Promise.all(
    [...seen].map(async (id) => {
      const current = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "jobManager",
        args: [id],
      })) as string;
      return getAddress(current) === getAddress(manager) ? id : null;
    }),
  );
  return still.filter((id): id is bigint => id !== null);
}

/**
 * Give every job delegated to us a task row, so the poller can run it.
 *
 * Safe to call repeatedly: a job that already has a task is skipped, and the
 * brief is regenerated only for jobs being adopted for the first time.
 */
export async function adoptDelegatedJobs(): Promise<number> {
  let signer;
  try {
    signer = createCircleSigner();
  } catch {
    return 0; // no agent wallet configured; nothing can be delegated to us
  }

  const ids = await delegatedTo(signer.address as `0x${string}`);
  if (ids.length === 0) return 0;

  const known = new Set(store.listTasks(500).map((t) => String(t.escrowId)));
  const client = getPublicClient();
  let adopted = 0;

  for (const id of ids) {
    if (known.has(String(id))) continue;

    const esc = (await client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow",
      args: [id],
    })) as RawEscrow;

    // Only jobs still waiting for a freelancer are worth adopting. A finished
    // or cancelled escrow has nothing left for an agent to decide.
    if (esc.status !== 0) continue;

    /*
     * The client already approved a brief in the app, and it was written into
     * the escrow's own description. Regenerate the structured form from that
     * text rather than inventing a new one, so the criteria the agent scores
     * against are the criteria the client actually agreed to.
     */
    const source = `${esc.projectTitle}\n\n${esc.projectDescription}`;
    let briefJson: string;
    try {
      const { brief } = await generateBrief(source);
      briefJson = JSON.stringify(brief);
    } catch (err) {
      console.error(`[adopt] escrow ${id}: could not rebuild the brief —`, err instanceof Error ? err.message : err);
      continue;
    }

    store.insertTask({
      id: `delegated-${id}`,
      escrowId: String(id),
      instruction: source,
      clientType: "human",
      status: "posted",
      briefJson,
      clientAddress: esc.depositor,
    });
    adopted++;
    console.log(`[adopt] escrow ${id} was delegated to us in the app — now running it`);
  }
  return adopted;
}

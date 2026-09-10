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

  const tasks = store.listTasks(500);
  const known = new Set(tasks.map((t) => String(t.escrowId)));
  const client = getPublicClient();
  let adopted = 0;

  /*
   * Hand back anything the client has taken off Autopilot.
   *
   * Revoking sets jobManager to zero, and the contract refuses our next call
   * straight away — but the task row stayed, so Browse Jobs kept showing
   * "AUTOPILOT MANAGED" on a job the agent was locked out of. Only rows this
   * sweep created are dropped; a job commissioned through the API is not ours
   * to forget.
   */
  const stillOurs = new Set(ids.map(String));
  for (const t of tasks) {
    if (!t.id.startsWith("delegated-")) continue;
    if (stillOurs.has(String(t.escrowId))) continue;
    store.deleteTask(t.id);
    console.log(`[adopt] escrow ${t.escrowId} was taken back by its client — released`);
  }

  /*
   * And anything that has since ended.
   *
   * Revocation is not the only way a delegated job stops being work: a client
   * can cancel it, an arbiter can settle it, it can simply complete. The sweep
   * above only notices revocation, because it compares against who manages the
   * escrow — and jobManager stays set on a cancelled job forever.
   *
   * So the agent went on advertising a task for an escrow nobody could act on:
   * `delegated-4`, status "posted", on a job that had been cancelled. Harmless
   * to the chain, which refuses every call, and misleading everywhere a human
   * reads the agent's state.
   */
  for (const t of tasks) {
    if (!t.id.startsWith("delegated-")) continue;
    if (!stillOurs.has(String(t.escrowId))) continue; // handled above
    try {
      const esc = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "getEscrow",
        args: [BigInt(t.escrowId!)],
      })) as RawEscrow;
      if (esc.status !== 0 && esc.status !== 1) {
        store.deleteTask(t.id);
        console.log(`[adopt] escrow ${t.escrowId} has ended (status ${esc.status}) — released`);
      }
    } catch {
      // A failed read is not evidence the job ended. Leave it alone.
    }
  }

  for (const id of ids) {
    if (known.has(String(id))) continue;

    const esc = (await client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow",
      args: [id],
    })) as RawEscrow;

    /*
     * Pending and InProgress, not just Pending.
     *
     * setJobManager accepts a job at any stage, so a client can hand over one
     * that already has a freelancer working -- "you handle the reviews from
     * here" is a reasonable thing to want, and the contract allows it. Adopting
     * only Pending meant that delegation was accepted on-chain and then ignored:
     * the app said Autopilot was running the job and nothing ever happened,
     * which is the same inert hand-off this sweep exists to prevent.
     *
     * Anything past InProgress is settled and has nothing left to decide.
     */
    const PENDING = 0;
    const IN_PROGRESS = 1;
    if (esc.status !== PENDING && esc.status !== IN_PROGRESS) continue;

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

      /*
       * Every number comes from the escrow, never from the description.
       *
       * The description keeps the client's original instruction, and a client
       * routinely edits the milestones before funding — "Budget $50" in the
       * prose against 5 USDC actually locked. Regenerating from the text
       * reproduced the sentence, so the bot advertised a $50 job paying $10
       * and $40 when the contract held 5, split 1 and 4. A freelancer applying
       * to that is being told a price nobody can pay them.
       *
       * The chain is the only honest source for what a job is worth, and the
       * milestone text on it is what the client actually approved. The model's
       * output is kept only for the acceptance criteria it structured.
       */
      const onChain = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "getMilestones",
        args: [id],
      })) as readonly { amount: bigint; requirements: string; description: string }[];

      const decimals = 1e6; // USDC
      brief.milestones = onChain.map((m) => ({
        description: m.requirements || m.description,
        amount: Number(m.amount) / decimals,
      }));
      brief.budget = brief.milestones.reduce((sum, m) => sum + m.amount, 0);

      const secondsLeft = Number(esc.deadline) - Math.floor(Date.now() / 1000);
      brief.durationDays = Math.max(1, Math.ceil(secondsLeft / 86_400));

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
      // A job with a freelancer already on it skips the hiring branch and goes
      // straight to reviewing what they submit.
      status: esc.status === IN_PROGRESS ? "active" : "posted",
      briefJson,
      clientAddress: esc.depositor,
    });
    adopted++;
    console.log(`[adopt] escrow ${id} was delegated to us in the app — now running it`);
  }
  return adopted;
}

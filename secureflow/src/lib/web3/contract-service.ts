import {
  createPublicClient,
  http,
  getContract,
  decodeFunctionData,
  parseAbiItem,
  type Address,
} from "viem";
import { arcTestnet } from "@/providers/WalletProvider";
import { CONTRACTS } from "./config";
import SecureFlowABI from "./SecureFlowABI.json";

/** wagmi writeContractAsync — typed as any to stay compatible across wagmi versions */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WagmiWrite = (args: any) => Promise<`0x${string}`>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export class ContractService {
  private client;
  private contract: any; // typed loosely to avoid viem generic constraints
  readonly addr: Address;

  constructor(contractAddress: string = CONTRACTS.SECUREFLOW_ESCROW) {
    this.addr = contractAddress as Address;
    this.client = createPublicClient({
      chain: arcTestnet,
      transport: http(),
    });
    this.contract = getContract({
      address: this.addr,
      abi: SecureFlowABI.abi,
      client: this.client,
    });
  }

  /* ─── READ METHODS ─── */

  async getNextEscrowId(): Promise<number> {
    try { return Number(await this.contract.read.nextEscrowId()); } catch { return 1; }
  }

  async getEscrow(id: number) {
    try {
      const e = await this.contract.read.getEscrow([BigInt(id)]);
      return {
        depositor: e.depositor,
        beneficiary: e.beneficiary,
        token: e.token,
        totalAmount: e.totalAmount,
        paidAmount: e.paidAmount,
        deadline: e.deadline,
        status: e.status,
        workStarted: e.workStarted,
        platformFee: e.platformFee,
        isOpenJob: e.isOpenJob,
        projectTitle: e.projectTitle,
        projectDescription: e.projectDescription,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Batch-fetch multiple escrows in a single multicall3 RPC round trip.
   * Falls back to sequential individual reads for any IDs that fail.
   */
  async getEscrowsBatch(ids: number[]): Promise<Record<number, Awaited<ReturnType<typeof this.getEscrow>>>> {
    if (ids.length === 0) return {};

    try {
      const calls = ids.map((id) => ({
        address: this.addr,
        abi: SecureFlowABI.abi as any,
        functionName: "getEscrow" as const,
        args: [BigInt(id)] as const,
      }));

      const results = await this.client.multicall({ contracts: calls, allowFailure: true });

      const out: Record<number, Awaited<ReturnType<typeof this.getEscrow>>> = {};
      for (let i = 0; i < ids.length; i++) {
        const r = results[i];
        if (r.status === "success" && r.result) {
          const e = r.result as any;
          out[ids[i]] = {
            depositor: e.depositor,
            beneficiary: e.beneficiary,
            token: e.token,
            totalAmount: e.totalAmount,
            paidAmount: e.paidAmount,
            deadline: e.deadline,
            status: e.status,
            workStarted: e.workStarted,
            platformFee: e.platformFee,
            isOpenJob: e.isOpenJob,
            projectTitle: e.projectTitle,
            projectDescription: e.projectDescription,
          };
        } else {
          // individual fallback
          out[ids[i]] = await this.getEscrow(ids[i]);
        }
      }
      return out;
    } catch {
      // full fallback — sequential
      const out: Record<number, Awaited<ReturnType<typeof this.getEscrow>>> = {};
      await Promise.all(ids.map(async (id) => { out[id] = await this.getEscrow(id); }));
      return out;
    }
  }

  /**
   * Batch-fetch milestones for multiple escrows in one multicall round trip.
   */
  async getMilestonesBatch(ids: number[]): Promise<Record<number, any[]>> {
    if (ids.length === 0) return {};

    try {
      const calls = ids.map((id) => ({
        address: this.addr,
        abi: SecureFlowABI.abi as any,
        functionName: "getMilestones" as const,
        args: [BigInt(id)] as const,
      }));

      const results = await this.client.multicall({ contracts: calls, allowFailure: true });

      const out: Record<number, any[]> = {};
      for (let i = 0; i < ids.length; i++) {
        const r = results[i];
        out[ids[i]] = r.status === "success" && Array.isArray(r.result) ? (r.result as any[]) : [];
      }
      return out;
    } catch {
      const out: Record<number, any[]> = {};
      await Promise.all(ids.map(async (id) => { out[id] = await this.getMilestones(id); }));
      return out;
    }
  }

  async getMilestones(id: number) {
    try {
      return await this.contract.read.getMilestones([BigInt(id)]);
    } catch (error) {
      return [];
    }
  }

  /**
   * Recover the original milestone descriptions a client typed at job creation.
   *
   * The contract overwrites `Milestone.description` in `submitMilestone`, and
   * there is no `MilestoneCreated` event that captured the original brief.
   * To recover it we:
   *   1. Find the `EscrowCreated` log for this escrowId — gives the txHash.
   *   2. Fetch that transaction's input calldata.
   *   3. Decode `createEscrow(...)` to read the `milestoneDescriptions` arg.
   *
   * Returns `null` if the originals can't be recovered (e.g. log not found,
   * decode fails, or the deployment predates the current ABI shape).
   */
  async getOriginalMilestoneDescriptions(
    escrowId: number,
  ): Promise<string[] | null> {
    const event = parseAbiItem(
      "event EscrowCreated(uint256 indexed escrowId, address indexed depositor, address indexed beneficiary, address[] arbiters, uint256 requiredConfirmations, uint256 totalAmount, uint256 platformFee, address token, uint256 deadline, bool isOpenJob)",
    );
    const log = (msg: string, extra?: unknown) =>
      // eslint-disable-next-line no-console
      console.warn(`[secureflow:milestone-recovery] esc=${escrowId} ${msg}`, extra ?? "");
    try {
      // The public drpc RPC caps eth_getLogs ranges aggressively (sometimes
      // as little as 1k blocks). Walk backwards in small chunks and fall back
      // to even smaller windows if the call is rejected.
      const latest = await this.client.getBlockNumber();
      const CHUNK = 1000n;
      const MAX_BLOCKS = 500_000n;
      const minBlock = latest > MAX_BLOCKS ? latest - MAX_BLOCKS : 0n;
      let txHash: `0x${string}` | null = null;
      let toBlock = latest;
      let scannedChunks = 0;
      while (toBlock >= minBlock) {
        const fromBlock = toBlock > CHUNK ? toBlock - CHUNK : 0n;
        try {
          const logs = await this.client.getLogs({
            address: this.contract.address,
            event,
            args: { escrowId: BigInt(escrowId) },
            fromBlock,
            toBlock,
          });
          scannedChunks++;
          if (logs.length > 0 && logs[0].transactionHash) {
            txHash = logs[0].transactionHash;
            log(`found log at block ${logs[0].blockNumber}`);
            break;
          }
        } catch (e) {
          log(`getLogs failed for range ${fromBlock}-${toBlock}`, e);
          // Don't give up — try a smaller window on next iteration.
        }
        if (fromBlock === 0n) break;
        toBlock = fromBlock - 1n;
      }
      if (!txHash) {
        log(`no EscrowCreated log found after scanning ${scannedChunks} chunks (latest=${latest}, minBlock=${minBlock})`);
        return null;
      }
      const tx = await this.client.getTransaction({ hash: txHash });
      if (!tx?.input) {
        log("transaction has no input data");
        return null;
      }
      const decoded = decodeFunctionData({
        abi: SecureFlowABI.abi,
        data: tx.input,
      });
      if (decoded.functionName !== "createEscrow") {
        log(`unexpected functionName: ${decoded.functionName}`);
        return null;
      }
      // createEscrow signature: (beneficiary, token, totalAmount, durationDays,
      //   arbiters, requiredConfirmations, milestoneAmounts,
      //   milestoneDescriptions, projectTitle, projectDescription)
      const args = decoded.args as unknown[] | undefined;
      const descriptions = args?.[7];
      if (!Array.isArray(descriptions)) {
        log("milestoneDescriptions arg is not an array", descriptions);
        return null;
      }
      log(`recovered ${descriptions.length} descriptions`);
      return descriptions.map((d) => String(d));
    } catch (e) {
      log("unexpected error during recovery", e);
      return null;
    }
  }

  async getReputation(addr: string): Promise<number> {
    try { return Number(await this.contract.read.reputation([addr as Address])); } catch { return 0; }
  }

  async getOwner(): Promise<string | null> {
    try { 
      return await this.contract.read.owner() as string;
    } catch (error) {
      return null;
    }
  }

  async isAuthorizedArbiter(addr: string): Promise<boolean> {
    try { return await this.contract.read.authorizedArbiters([addr as Address]); } catch { return false; }
  }

  async getUserEscrows(addr: string): Promise<number[]> {
    try {
      const ids = await this.contract.read.getUserEscrows([addr as Address]);
      return (ids as bigint[]).map(Number);
    } catch { return []; }
  }

  async isPaused(): Promise<boolean> {
    try { return await this.contract.read.paused(); } catch { return false; }
  }

  async getFeeCollector(): Promise<string> {
    try { return await this.contract.read.feeCollector() as string; } catch { return ""; }
  }

  async getPlatformFeeBP(): Promise<number> {
    try { return Number(await this.contract.read.platformFeeBP()); } catch { return 0; }
  }

  async getTotalFeesByToken(tokenAddress: string): Promise<string> {
    try { 
      const fees = await this.contract.read.totalFeesByToken([tokenAddress as Address]);
      return fees.toString();
    } catch { return "0"; }
  }

  async getTotalEscrows(): Promise<number> {
    try { return Math.max(0, Number(await this.contract.read.nextEscrowId()) - 1); } catch { return 0; }
  }

  /** Returns all currently authorized arbiters (enumerable on-chain). */
  async getAuthorizedArbiters(): Promise<string[]> {
    try { return await this.contract.read.getArbiters() as string[]; } catch { return []; }
  }

  async isJobCreationPaused(_addr?: string): Promise<boolean> {
    return this.isPaused();
  }

  async getWhitelistedTokens(): Promise<string[]> {
    // Not enumerable from contract — return empty; populate from admin UI events if needed
    return [];
  }

  async getApplications(escrowId: number): Promise<unknown[]> {
    try {
      return await this.contract.read.getEscrowApplications([BigInt(escrowId)]) as unknown[];
    } catch { return []; }
  }

  async getApplicationDetails(escrowId: number): Promise<Array<{
    freelancer: string;
    coverLetter: string;
    proposedTimeline: number;
  }>> {
    try {
      // Get the list of freelancers who applied from storage
      const addresses = await this.contract.read.getEscrowApplications([BigInt(escrowId)]) as string[];
      
      if (addresses.length === 0) {
        return [];
      }

      const applications: Array<{
        freelancer: string;
        coverLetter: string;
        proposedTimeline: number;
      }> = [];

      // Get current block number
      const currentBlock = await this.client.getBlockNumber();
      
      // Arc Testnet RPC limit: max 10000 blocks per query
      // Search last 9000 blocks to stay under limit
      const fromBlock = currentBlock > 9000n ? currentBlock - 9000n : 0n;

      // Get ApplicationSubmitted events for this escrow
      const { parseEventLogs } = await import('viem');
      
      try {
        const logs = await this.client.getLogs({
          address: this.contract.address as Address,
          fromBlock,
          toBlock: 'latest'
        });

        // Parse the events
        const parsedLogs = parseEventLogs({
          abi: SecureFlowABI.abi,
          logs: logs as any[]
        });

        for (const log of parsedLogs) {
          if ((log as any).eventName === 'ApplicationSubmitted') {
            const args = (log as any).args as {
              escrowId: bigint;
              freelancer: string;
              coverLetter: string;
              proposedTimeline: bigint;
            };

            // Only include applications for this escrow
            if (Number(args.escrowId) !== escrowId) {
              continue;
            }

            applications.push({
              freelancer: args.freelancer.toLowerCase(),
              coverLetter: args.coverLetter || '',
              proposedTimeline: Number(args.proposedTimeline) || 0
            });
          }
        }

        // If we found events but some addresses are missing, add them with empty data
        for (const addr of addresses) {
          const found = applications.find(app => app.freelancer.toLowerCase() === addr.toLowerCase());
          if (!found) {
            applications.push({
              freelancer: addr,
              coverLetter: '',
              proposedTimeline: 0
            });
          }
        }

      } catch (eventError) {
        // Fallback: decode transactions
        const allLogs = await this.client.getLogs({
          address: this.contract.address as Address,
          fromBlock,
          toBlock: 'latest'
        });

        for (const freelancerAddress of addresses) {
          let found = false;
          
          for (const log of allLogs) {
            try {
              const tx = await this.client.getTransaction({
                hash: log.transactionHash as `0x${string}`
              });

              if (tx.from.toLowerCase() !== freelancerAddress.toLowerCase()) {
                continue;
              }

              const { decodeFunctionData } = await import('viem');
              const decoded = decodeFunctionData({
                abi: SecureFlowABI.abi,
                data: tx.input
              });

              if (decoded.functionName === 'applyToJob') {
                const [txEscrowId, coverLetter, proposedTimeline] = decoded.args as [bigint, string, bigint];
                
                if (Number(txEscrowId) === escrowId) {
                  applications.push({
                    freelancer: freelancerAddress,
                    coverLetter: coverLetter || '',
                    proposedTimeline: Number(proposedTimeline) || 0
                  });
                  found = true;
                  break;
                }
              }
            } catch (txError) {
              continue;
            }
          }

          if (!found) {
            applications.push({
              freelancer: freelancerAddress,
              coverLetter: '',
              proposedTimeline: 0
            });
          }
        }
      }

      return applications;
    } catch (error) {
      // Final fallback: return addresses with empty data
      try {
        const addresses = await this.contract.read.getEscrowApplications([BigInt(escrowId)]) as string[];
        return addresses.map((addr: string) => ({
          freelancer: addr,
          coverLetter: '',
          proposedTimeline: 0
        }));
      } catch (fallbackError) {
        return [];
      }
    }
  }

  async hasUserApplied(escrowId: number, addr: string): Promise<boolean> {
    try {
      return await this.contract.read.hasApplied([BigInt(escrowId), addr as Address]);
    } catch { return false; }
  }

  /** All ratings received by an address, from the contract. */
  async getRatingsForAddress(addr: string): Promise<unknown[]> {
    try {
      return await this.contract.read.getRatingsForAddress([addr as Address]) as unknown[];
    } catch { return []; }
  }

  /**
   * Returns average rating (×100) and count.
   * e.g. { averageX100: 450, count: 10 } → 4.50 stars from 10 ratings.
   */
  async getAverageRating(addr: string): Promise<{ averageX100: number; count: number }> {
    try {
      const result = await this.contract.read.getAverageRating([addr as Address]);
      return { averageX100: Number(result[0]), count: Number(result[1]) };
    } catch { return { averageX100: 0, count: 0 }; }
  }

  /** Rating a specific rater gave in an escrow. */
  async getRating(escrowId: number, rater?: string): Promise<unknown> {
    if (!rater) return null;
    try {
      return await this.contract.read.getRating([BigInt(escrowId), rater as Address]);
    } catch { return null; }
  }

  /** Badge derived from on-chain reputation count. */
  async getBadge(addr: string): Promise<string | null> {
    const rep = await this.getReputation(addr);
    if (rep >= 20) return "Expert";
    if (rep >= 10) return "Advanced";
    if (rep >= 5) return "Intermediate";
    if (rep >= 1) return "Beginner";
    return null;
  }

  async quoteDeposit(totalAmount: bigint): Promise<{ deposit: bigint; fee: bigint }> {
    try {
      const result = await this.contract.read.quoteDeposit([totalAmount]);
      return { deposit: result[0], fee: result[1] };
    } catch { return { deposit: totalAmount, fee: 0n }; }
  }

  async probeEscrowContractHealth(): Promise<{
    ok: boolean;
    jobCreationPaused: boolean;
    userMessage: string;
  }> {
    if (!CONTRACTS.SECUREFLOW_ESCROW) {
      return {
        ok: false,
        jobCreationPaused: true,
        userMessage: "Contract address not configured. Set VITE_SECUREFLOW_CONTRACT_ADDRESS in your .env file.",
      };
    }
    try {
      const paused = await this.isPaused();
      return {
        ok: true,
        jobCreationPaused: paused,
        userMessage: paused ? "The contract is currently paused by the administrator." : "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { ok: false, jobCreationPaused: true, userMessage: `Cannot reach the SecureFlow contract: ${msg}` };
    }
  }

  /* ─── WRITE METHODS (require wagmi writeContractAsync) ─── */

  async startWork(escrowId: number, _from: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({ address: this.addr, abi: SecureFlowABI.abi, functionName: "startWork", args: [BigInt(escrowId)] });
  }

  async extendDeadline(
    params: { escrow_id: number; extra_seconds: number; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    const additionalDays = BigInt(Math.max(1, Math.round(params.extra_seconds / 86400)));
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "extendDeadline",
      args: [BigInt(params.escrow_id), additionalDays],
    });
  }

  async submitMilestone(
    params: { escrow_id: number; milestone_index: number; description: string; beneficiary: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "submitMilestone",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.description],
    });
  }

  async approveMilestone(
    params: { escrow_id: number; milestone_index: number; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "approveMilestone",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index)],
    });
  }

  async rejectMilestone(
    params: { escrow_id: number; milestone_index: number; reason: string; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "rejectMilestone",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.reason],
    });
  }

  async disputeMilestone(
    params: { escrow_id: number; milestone_index: number; reason: string; disputer: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "disputeMilestone",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.reason],
    });
  }

  async raiseOverdueDispute(
    params: { escrow_id: number; reason: string; requester: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "raiseOverdueDispute",
      args: [BigInt(params.escrow_id), params.reason],
    });
  }

  async acceptFreelancer(
    params: { escrow_id: number; freelancer: string; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "acceptFreelancer",
      args: [BigInt(params.escrow_id), params.freelancer as `0x${string}`],
    });
  }

  async applyToJob(
    params: { escrow_id: number; cover_letter: string; proposed_timeline: number; freelancer: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "applyToJob",
      args: [BigInt(params.escrow_id), params.cover_letter, BigInt(params.proposed_timeline)],
    });
  }

  async submitRating(escrowId: number, score: number, review: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "submitRating",
      args: [BigInt(escrowId), score, review],
    });
  }

  async removeArbiter(arbiter: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "revokeArbiter",
      args: [arbiter as `0x${string}`],
    });
  }

  async authorizeArbiter(arbiter: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "authorizeArbiter",
      args: [arbiter as `0x${string}`],
    });
  }

  async submitEvidence(
    params: { escrow_id: number; milestone_index: number; cid: string; submitter: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "submitEvidence",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index), params.cid],
    });
  }

  async whitelistToken(token: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "whitelistToken",
      args: [token as `0x${string}`],
    });
  }

  async setPlatformFee(feeBP: number, write: WagmiWrite): Promise<`0x${string}`> {
    if (feeBP < 0 || feeBP > 10000) throw new Error("Fee must be between 0 and 100%");
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "setPlatformFee",
      args: [BigInt(feeBP)],
    });
  }

  async getCollectedFees(token: string): Promise<bigint> {
    try {
      return await this.contract.read.totalFeesByToken([token as `0x${string}`]) as bigint;
    } catch { return 0n; }
  }

  async withdrawFees(token: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "withdrawFees",
      args: [token as `0x${string}`],
    });
  }

  async deleteEscrow(escrowId: number, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "deleteEscrow",
      args: [BigInt(escrowId)],
    });
  }

  async emergencyRefundAfterDeadline(escrowId: number, _from: string, write: WagmiWrite): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "emergencyRefundAfterDeadline",
      args: [BigInt(escrowId)],
    });
  }

  async resubmitMilestone(
    params: { escrow_id: number; milestone_index: number; description: string; beneficiary: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return this.submitMilestone(params, write);
  }

  /* ─── NEW: Job Management Methods ─── */

  async cancelJob(
    params: { escrow_id: number; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "cancelJob",
      args: [BigInt(params.escrow_id)],
    });
  }

  async addJobFunds(
    params: { escrow_id: number; additional_amount: string; depositor: string; milestone_index: number; token?: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    // Arc Testnet USDC uses 6 decimals
    const amountWei = BigInt(Math.floor(parseFloat(params.additional_amount) * 1e6));

    // Get escrow to check token type
    const escrow = await this.getEscrow(params.escrow_id);
    if (!escrow) throw new Error("Escrow not found");

    const isNativeToken = escrow.token === ZERO_ADDRESS;
    const token = escrow.token as `0x${string}`;

    // Calculate total deposit (amount + platform fee)
    const { deposit } = await this.quoteDeposit(amountWei);

    // For ERC-20 tokens: approve spending first
    if (!isNativeToken) {
      const { createPublicClient, http } = await import("viem");
      const { arcTestnet } = await import("@/providers/WalletProvider");
      const { erc20Abi } = await import("@/lib/web3/abis");

      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      const allowance = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [params.depositor as `0x${string}`, this.addr],
      }) as bigint;

      if (allowance < deposit) {
        await write({
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.addr, deposit],
        });
      }
    }

    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "addJobFunds",
      args: [BigInt(params.escrow_id), amountWei, BigInt(params.milestone_index)],
      value: isNativeToken ? deposit : 0n,
    });
  }

  async withdrawJobFunds(
    params: { escrow_id: number; withdraw_amount: string; depositor: string; milestone_index: number },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    // Arc Testnet USDC uses 6 decimals
    const amountWei = BigInt(Math.floor(parseFloat(params.withdraw_amount) * 1e6));
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "withdrawJobFunds",
      args: [BigInt(params.escrow_id), amountWei, BigInt(params.milestone_index)],
    });
  }

  /* ─── NEW: Milestone Negotiation Methods ─── */

  async proposeMilestoneChange(
    params: {
      escrow_id: number;
      milestone_index: number;
      proposed_amount: string;
      proposed_description: string;
      freelancer: string;
    },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    const amountWei = BigInt(Math.floor(parseFloat(params.proposed_amount) * 1e18));
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "proposeMilestoneChange",
      args: [
        BigInt(params.escrow_id),
        BigInt(params.milestone_index),
        amountWei,
        params.proposed_description,
      ],
    });
  }

  async approveMilestoneProposal(
    params: { escrow_id: number; milestone_index: number; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "approveMilestoneProposal",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index)],
    });
  }

  async rejectMilestoneProposal(
    params: { escrow_id: number; milestone_index: number; depositor: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "rejectMilestoneProposal",
      args: [BigInt(params.escrow_id), BigInt(params.milestone_index)],
    });
  }

  /* ─── Aliases for backward-compatible callers ─── */

  async getClientRating(escrowId: number, rater?: string): Promise<unknown> {
    return this.getRating(escrowId, rater);
  }

  async getAverageClientRating(addr: string): Promise<{ averageX100: number; count: number }> {
    return this.getAverageRating(addr);
  }

  async submitClientRating(
    params: { escrow_id: number; rating: number; review: string; freelancer?: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return this.submitRating(params.escrow_id, params.rating, params.review, write);
  }

  async applyToJobGasless(
    params: { escrow_id: number; cover_letter: string; proposed_timeline: number; freelancer: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    return this.applyToJob({ ...params }, write);
  }

  async getOverdueRequest(escrowId: number): Promise<unknown> {
    const escrow = await this.getEscrow(escrowId);
    if (!escrow || escrow.status !== 4) return null;
    return escrow;
  }

  async arbiterApproveRefund(
    params: { escrow_id: number; arbiter: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    const milestones = await this.getMilestones(params.escrow_id);
    const disputedIdx = (milestones as any[]).findIndex((m: any) => Number(m.status) === 4);
    const idx = disputedIdx >= 0 ? disputedIdx : 0;
    const milestoneAmount = BigInt((milestones as any[])[idx]?.amount ?? 0);
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "resolveDispute",
      args: [BigInt(params.escrow_id), BigInt(idx), 0n, milestoneAmount],
    });
  }

  async arbiterAwardFreelancer(
    params: { escrow_id: number; arbiter: string; freelancer_amount: bigint; reason: string },
    write: WagmiWrite
  ): Promise<`0x${string}`> {
    const milestones = await this.getMilestones(params.escrow_id);
    const disputedIdx = (milestones as any[]).findIndex((m: any) => Number(m.status) === 4);
    const idx = disputedIdx >= 0 ? disputedIdx : 0;
    const milestoneAmount = BigInt((milestones as any[])[idx]?.amount ?? 0);
    const freelancerAmount = params.freelancer_amount;
    const clientAmount = milestoneAmount - freelancerAmount;
    return write({
      address: this.addr,
      abi: SecureFlowABI.abi,
      functionName: "resolveDispute",
      args: [BigInt(params.escrow_id), BigInt(idx), freelancerAmount, clientAmount, params.reason],
    });
  }
}

/** Shape returned by ContractService.getEscrow() */
export type EscrowData = NonNullable<Awaited<ReturnType<ContractService["getEscrow"]>>>;

export const contractService = new ContractService();

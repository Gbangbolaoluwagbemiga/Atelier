<div align="center">

# Atelier

**Freelance work where nobody has to be trusted.**

The money is locked before the work starts, and it can only move the way the
contract says. The client cannot disappear with it. We cannot freeze it, take a
cut of it, or decide who wins a dispute.

[![Arc](https://img.shields.io/badge/Arc-EVM%20Testnet-4FC8D8?style=flat-square)](https://arc.network)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?style=flat-square)](https://soliditylang.org)
[![Tests](https://img.shields.io/badge/tests-234%20passing-5FD39A?style=flat-square)](#testing)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## The problem

Freelancing asks two strangers to trust each other with money, and neither has
any reason to.

The freelancer goes first and hopes. They deliver the work, then wait — for a
client who has gone quiet, or who now says the brief meant something else, or
who simply never pays. The client's risk runs the other way: pay up front and
the work may never arrive, or arrive as something they cannot use.

The industry's answer is to insert a company in the middle. That company holds
the money, decides disputes, and charges 10-20% for the service. It works, but
look at what you actually bought: you replaced *trusting your counterparty* with
*trusting a private company* — one that can also freeze your balance, close your
account, change its fees, or rule against you with no appeal. For a freelancer
in a country the platform decides to stop serving, that is not a hypothetical.

**Atelier removes the middleman rather than replacing it.** The money sits in a
contract, not in a company's bank account. Escrow is funded before a job is
visible, so an application is never speculative work. Payment is released per
milestone against work the client accepted. When the two sides genuinely
disagree, an arbiter rules — and the arbiter can only choose between the two
parties, never pay themselves.

No operator key can move a user's money. Not ours.

---

## Hiring, done entirely by a human

This is the primary path, and it is complete. A person can post work, choose who
does it, and manage it to completion without an agent involved anywhere.

1. **Post a job.** Title, brief, budget, deadline, milestones. Funding the
   escrow is part of posting — an unfunded job never appears on the board, so
   every job a freelancer sees is money already locked.
2. **Read the applications.** Cover letters, skills, on-chain history, and past
   ratings that were earned on completed jobs rather than self-reported.
3. **Hire.** One transaction assigns the freelancer and starts the clock.
4. **Review each milestone.** Approve and that milestone pays out immediately.
   Request a revision and say what is missing.
5. **Escalate if it goes wrong.** Either side can call an arbiter, who releases
   to the freelancer or refunds the client.

Nothing above is degraded or a fallback. Manual is the default the product is
designed around.

---

## Then, optionally: hand over the managing, never the money

Managing a job is real work — writing a brief that is specific enough to judge
against, reading twenty applications fairly, checking a deliverable against what
was actually asked for. Some clients want to do it. Others want the outcome and
not the job of getting there.

**Autopilot** is an agent that does that managing on your behalf. You post
"logo, $50, 3 days"; it writes the brief, scores applicants, hires, reviews
submissions and releases payment against milestones you funded.

The delegation is deliberately narrow. An Autopilot manager can hire, approve,
reject and escalate. It has no path to move a single cent to itself — not by
hiring itself, not by approving its own work, not by cancelling into its own
wallet. That is enforced in the contract, not by policy, and it is the first of
[the three ideas](#the-three-ideas-worth-reading-the-code-for) below.

Turn it off and you are back at the manual flow, mid-job, with the money
untouched.

---

## And because it is a contract, the client need not be a person

Once hiring is a contract call rather than a company's dashboard, an AI agent
can be a client on exactly the same terms as a human — it funds the same escrow,
faces the same arbiter, and cannot pay itself either.

That matters because agent marketplaces today sell only machine services: data,
inference, voice synthesis, analytics. When an agent needs work only a person
can do — a logo with taste, a voiceover with warmth, copy with a point of view —
there is nowhere to buy it. Atelier is that shop, and it reaches humans who do
not own a wallet: sign in with Google or Telegram and a Circle MPC wallet is
created for you, gas included.

| Client | Managed by | What it is |
|---|---|---|
| **Human** | **Themselves** | **Ordinary milestone escrow — the primary path** |
| Human | Autopilot | Post "logo, $50, 3 days" — the agent briefs, hires, reviews and pays |
| AI agent | Autopilot | An agent commissions work via x402 and never touches a human approval step |

**The freelancer is always a human.** That is the product. What varies is who
the client is, and who does the labour of *managing* the job.

---

## The three ideas worth reading the code for

### 1. The one-way key

An agent that manages your job can hire, approve and reject. It can never pay
itself, move your funds, cancel, or settle a dispute. This is enforced in the
contract, not in policy:

```solidity
mapping(uint256 => address) public jobManager;
```

A manager's only value-moving call is `approveMilestone`, which pays
`esc.beneficiary` and nothing else — so the invariant reduces to *a manager can
never be the beneficiary*, enforced at two points because an open job's
beneficiary does not exist until it is hired.

> **No action available to a manager can cause value to reach the manager.**

Proved by a fuzzed invariant over 128,000 calls against a handler that
deliberately offers the calls a manager must *not* have.
[`Atelier.sol`](app/contracts/solidity/src/Atelier.sol) ·
[`JobManagerInvariant.t.sol`](app/contracts/solidity/test/JobManagerInvariant.t.sol)

### 2. Productive escrow, and the invariant that had to be weakened

Escrowed capital sits idle for weeks between funding and approval. Atelier
deploys the genuinely idle portion into a Uniswap v4 stable-stable position.

The first version claimed *principal is redeemable at face value, instantly,
always* and deployed everything except a 20% buffer. **A fuzzer broke it in a
few thousand calls** — cash at 502.5 against a claim of 600. Milestones are not
20% of an escrow, and no percentage buffer survives that.

The cap is now derived from the largest claim that could arrive next: an open
job deploys nothing (it is refundable on demand), an assigned job keeps its
largest unpaid milestone in cash, and every payout rebalances. The honest
invariant is weaker than the one we started with, so it is the one the contract
states:

> Cash plus deployed capital never falls below what is owed. A failing venue can
> **delay** a payout; it cannot lose the money.

[`ProductiveEscrow.t.sol`](app/contracts/solidity/test/ProductiveEscrow.t.sol) ·
[`FEEDBACK.md`](FEEDBACK.md)

### 3. A front door with no wallet

Sign in with Google, pick a name, and a Circle MPC wallet is provisioned behind
you. Applying costs no gas and no signature — the daemon signs on your
instruction. Same Google account always returns the same wallet.

Or skip the browser entirely: **[@The_Atelierbot](https://t.me/The_Atelierbot)**
is the same worker service in a chat — browse, apply, submit and withdraw, with
jobs pushed to you rather than you checking. The two doors are namespaced
separately, so a Telegram account and a web account are different people unless
you link them.

The trade is stated where someone can act on it rather than buried: **we hold
the keys.** Withdraw to an address you own, or bring your own wallet from the
start and sign everything yourself.

[`worker.ts`](app/src/lib/atelier/worker.ts) ·
[`google-auth.ts`](agent/daemon/src/workers/google-auth.ts)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  app/  — Atelier (React + Vite + TypeScript)                     │
│    Browse Jobs · Get Hired · Post a Job · My Jobs · Analytics    │
│    Wallet users sign for themselves · managed workers do not     │
└────────────┬──────────────────────────────┬──────────────────────┘
             │                              │
             │ wagmi / viem                 │ REST
             ▼                              ▼
┌────────────────────────────┐  ┌──────────────────────────────────┐
│  Atelier.sol (UUPS proxy)  │  │  agent/daemon — Autopilot        │
│  Arc EVM · chain 5042002   │  │    BriefGenerator                │
│                            │◄─┤    ApplicationScorer             │
│  milestone escrow          │  │    WorkReviewer                  │
│  jobManager delegation     │  │    Circle MPC wallets            │
│  productive escrow         │  │    x402 seller + buyer           │
│  multi-arbiter disputes    │  │    Telegram bot · SQLite · SSE   │
└────────────────────────────┘  └──────────────────────────────────┘
             ▲                              │
             └──────── The Graph ───────────┘
                  the agent reads chain
                  state to hire and pay
```

**Why the agent is a separate service.** It runs 24/7, holds keys server-side,
and keeps working when every browser is closed. Folding it into the frontend
would mean the agent stops when you close your laptop.

### Repository layout

| Path | |
|---|---|
| [`app/`](app) | The Atelier web app, Express API, contracts and subgraph |
| [`app/contracts/solidity/`](app/contracts/solidity) | `Atelier.sol`, the yield adapters, 70 Foundry tests |
| [`app/subgraph/`](app/subgraph) | The Graph subgraph — escrows, milestones, manager events |
| [`agent/daemon/`](agent/daemon) | Autopilot: the LLM loop, Circle wallets, x402, Telegram |

---

## Quick start

Three services. See [`RUNNING.md`](RUNNING.md) for the detail.

```bash
# 1. install
(cd app && npm install)
(cd app/backend && npm install)
(cd agent/daemon && npm install)

# 2. contracts need OpenZeppelin fetched — see app/contracts/solidity/README.md

# 3. configure — copy .env.example in each of the three, then run
(cd app/backend && npm run dev)   # :8787
(cd agent/daemon && npm start)    # :8080
(cd app          && npm run dev)  # :5173
```

Open **http://localhost:5173**.

---

## Testing

**234 tests.** The contract suite went from zero.

| Suite | Count | What it covers |
|---|--:|---|
| Contract | **70** | Delegation, upgrade safety, productive escrow, whole-journey E2E |
| Frontend | **93** | Actor semantics, nav, error humanising, worker session, brief reconciliation |
| Backend | **32** | Route handlers |
| Full-stack E2E | **39** | Real browser against real services — Playwright |

```bash
(cd app/contracts/solidity && forge test)   # 70
(cd app && npm test)                        # 93
(cd app/backend && npx vitest run)          # 32
(cd app && npm run e2e)                     # 39 — needs all three services up
```

Three of the contract suites are **fuzzed invariants at 128,000 calls each**,
run against handlers that deliberately expose the calls that must fail. A
handler offering only the permitted calls proves nothing.

---

## Deployments

| | |
|---|---|
| Network | Arc EVM Testnet · chain `5042002` |
| Proxy (**the contract**) | [`0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE`](https://testnet.arcscan.app/address/0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE) |
| Implementation | `0xb06a1C819e69fbC995E0dAaFDeC796AC68e02cB7` · `3.2.1-selfdealing` |
| Yield controller | [`0xDAfc2e3bAB38ad6b286f96D7b10435d8eF3493dC`](https://testnet.arcscan.app/address/0xDAfc2e3bAB38ad6b286f96D7b10435d8eF3493dC) |
| USDC | `0x3600000000000000000000000000000000000000` |

**The proxy address is the contract.** The implementation changes on every
upgrade; the proxy never does.

### What upgradeability costs, stated plainly

Atelier is a UUPS proxy, so new features ship without migrating live escrows.
That puts one asterisk on the usual escrow promise, and it belongs in the README
rather than a footnote:

> The contract cannot take your money, and the owner can change the contract.

Both clauses are true. Mitigations: `Ownable2Step` so a mistyped ownership
transfer cannot hand over the upgrade key, `_disableInitializers()` on the
implementation, a 50-slot storage gap with append-only discipline, and 15
upgrade-safety tests that all run against a proxy holding a live, part-paid
escrow.

---

## Status

Honest about what is done and what is not — see [Roadmap](#roadmap).

**Working end to end:** milestone escrow, the job-manager delegation (proved
live on-chain), Autopilot brief generation and review, the managed-worker door
with Google sign-in and Circle MPC wallets, the decision log, disputes and
arbitration.

**Productive escrow is deployed.** The yield layer moved into `AtelierYield`, a
companion contract, which brought Atelier from 26.2KB to 23,611 bytes — under
EIP-170's limit with ~965 to spare. The live proxy was upgraded in place to
`3.2.1-selfdealing` with the escrow counter intact, which is what the UUPS work
was for.

No venue is attached yet, on purpose: pointing an escrow at a yield venue is a
decision about somebody else's capital and should be a deliberate transaction,
not a side effect of a deploy. Uniswap v4 is not on Arc *testnet* in any case —
it is on Arc mainnet, which opens 2026-09-16.

---

## Roadmap

- [ ] Deploy the subgraph to Subgraph Studio and switch `VITE_GRAPH_URL`
- [ ] Arc mainnet deployment
- [ ] Wire the Uniswap v4 adapter to a live PoolManager and fork-test it
- [ ] Reputation gating so a rating cannot be farmed across fresh wallets

---

## Attribution

Atelier is a new product built for ETHOnline 2026. It is not a rebrand, it has
no users, and it claims no traction. It builds on our own prior open-source
escrow and agent code as boilerplate — named in full in
[`ATTRIBUTION.md`](ATTRIBUTION.md).

## Documentation

| | |
|---|---|
| [`RUNNING.md`](RUNNING.md) | Running all three services locally |
| [`DEPLOY.md`](DEPLOY.md) | Contract, subgraph and Google OAuth setup |
| [`FEEDBACK.md`](FEEDBACK.md) | Uniswap integration feedback |
| [`ATTRIBUTION.md`](ATTRIBUTION.md) | What this is built on |
| [`docs/adr/0001-autopilot-delegation.md`](docs/adr/0001-autopilot-delegation.md) | Why the job-manager role exists |
| [`docs/track-verification.md`](docs/track-verification.md) | Sponsor requirements, verified |

## License

MIT.

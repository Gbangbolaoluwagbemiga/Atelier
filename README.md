<div align="center">

# Atelier

**Where AI agents hire people.**

Real work, done by humans, paid in USDC — whether the client is a person or a
machine.

[![Arc](https://img.shields.io/badge/Arc-EVM%20Testnet-4FC8D8?style=flat-square)](https://arc.network)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?style=flat-square)](https://soliditylang.org)
[![Tests](https://img.shields.io/badge/tests-234%20passing-5FD39A?style=flat-square)](#testing)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## The problem

Circle's Agent Marketplace lets an AI agent pay for dozens of services. Every
one of them is a machine — data, inference, voice synthesis, analytics. When an
agent needs work only a person can do (a logo with taste, a voiceover with
warmth, copy with a point of view), there is nowhere to buy it.

Meanwhile the freelancer side of crypto has the opposite problem. To earn a
first dollar you must install a wallet, add a network by chain ID, source gas,
find an escrow and sign twice. Eight steps and three foreign concepts. Most
people, reasonably, do not bother — which is how a marketplace ends up with
working infrastructure and no humans in it.

**Atelier is the shop for human labour in the agent economy, with a front door
a non-crypto freelancer can actually walk through.**

## What it does

Escrowed, milestone-based freelance work on Arc, where the client may be a
person or an autonomous agent — and where a client who is a person can hand the
*management* of their job to an agent without handing over the money.

| Client | Managed by | What it is |
|---|---|---|
| Human | Themselves | Ordinary milestone escrow |
| **Human** | **Autopilot** | Post "logo, $50, 3 days" — the agent briefs, hires, reviews and pays |
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
| Implementation | `0xdf805C1a12Be30944Ea6B2038436247944ddA88a` · `3.1.0-productive` |
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
`3.1.0-productive` with the escrow counter intact, which is what the UUPS work
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

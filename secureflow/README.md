<div align="center">

<img src="public/secureflow-horizontal-logo.svg" alt="SecureFlow" height="60" />

**Trustless milestone-based escrow for freelance work on Arc EVM**

[![Live Demo](https://img.shields.io/badge/Live%20App-secureflow--arc.vercel.app-7D00FF?style=flat-square&logo=vercel&logoColor=white)](https://secureflow-arc.vercel.app)
[![Arc EVM](https://img.shields.io/badge/Arc-EVM%20Testnet-7D00FF?style=flat-square)](https://arc.network)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?style=flat-square&logo=solidity)](https://soliditylang.org)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Gbangbolaoluwagbemiga/Secureflow-Arc/ci.yml?style=flat-square&label=CI)](https://github.com/Gbangbolaoluwagbemiga/Secureflow-Arc/actions)

</div>

---

## Overview

SecureFlow is a decentralized freelancer marketplace built on Arc EVM. Clients deposit USDC into smart-contract escrow, define milestones with explicit deliverables and budgets, and funds are released automatically as each milestone is approved. Neither party can unilaterally move money once the contract is live — disputes go to a multi-arbiter on-chain vote.

**The problem it solves:** Traditional freelance platforms hold funds on centralized servers, charge 20%+ fees, and resolve disputes through opaque processes. SecureFlow replaces all of that with auditable on-chain logic, 2.5% platform fees, and cryptographic finality.

---

## Live Deployment

| Resource | Link |
|---|---|
| Frontend | [secureflow-arc.vercel.app](https://secureflow-arc.vercel.app) |
| Contract | [`0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59`](https://testnet.arcscan.app/address/0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59) |
| Subgraph | [Goldsky — secureflow/v1](https://api.goldsky.com/api/public/project_cmpyopkeb3cxh01v51s4wg5nc/subgraphs/secureflow/v2/gn) |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Chain | Arc EVM Testnet · ID `5042002` |
| Token | Circle USDC · `0x3600000000000000000000000000000000000000` |

---

## Features

### For Clients
- **Create escrow** — define project title, description, total budget, deadline, and per-milestone amounts in a 3-step wizard
- **Open or direct** — post a job openly (freelancers apply) or assign a specific wallet address directly
- **Milestone approval** — review each submission; approve to release funds or reject with feedback
- **Fund management** — add or reduce a milestone's budget before a freelancer is assigned (on-chain, per-milestone)
- **Deadline extension** — extend the deadline by any number of days without re-depositing
- **Cancel job** — cancel and refund with tiered penalties (0% for early cancellations, up to 15% for repeat abusers)
- **Dispute** — escalate any milestone to multi-arbiter resolution with IPFS evidence pinning
- **Emergency refund** — reclaim unspent funds 30 days after deadline if the escrow stalls
- **Rate freelancer** — 1–5 star rating after the escrow is fully released

### For Freelancers
- **Browse open jobs** — marketplace with search, filter, and milestone breakdown before applying
- **AI cover letter** — one-click draft or enhance your cover letter with Groq AI
- **Apply with attachment** — portfolio or document upload (PDF, images, docs) stored via Supabase
- **Gasless applications** — EIP-2771 meta-transactions via MinimalForwarder relayer (no gas needed)
- **Submit milestones** — attach deliverable description and file evidence to each submission
- **Resubmit** — resubmit a rejected milestone with updated work
- **Raise dispute** — escalate with on-chain evidence (IPFS CID) and written reason
- **Badge system** — Beginner → Intermediate → Advanced → Expert based on completed escrows
- **Earnings dashboard** — total earned, projects in progress, rating score, badge tier

### For Arbiters (Admins)
- **Dispute console** — view evidence from both parties, communicate via Supabase messaging
- **Multi-sig resolution** — requires `requiredConfirmations` arbiter votes; funds split by majority decision
- **Arbiter management** — owner can authorize or revoke arbiter wallets
- **Platform fee** — owner sets fee in % (stored as basis points); displayed live in admin panel
- **Token whitelist** — owner whitelists ERC-20 tokens accepted for escrow

### Platform
- **Analytics dashboard** — platform-wide stats (active escrows, total volume, completed) + per-user breakdown
- **Real-time notifications** — Supabase-backed push notifications for all state changes
- **Messages** — real-time chat between client and freelancer per escrow
- **Dark UI** — glassmorphism design with `#7D00FF` accent, built with Tailwind + shadcn/ui

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React + Vite · Vercel)                        │
│  ├── Pages: Home, Jobs, Create, Dashboard, Freelancer,  │
│  │          Analytics, Disputes, Messages, Admin         │
│  ├── Data: Goldsky subgraph (GraphQL) → RPC multicall   │
│  │         fallback                                       │
│  └── Wallet: Reown AppKit (WalletConnect v2)            │
├─────────────────────────────────────────────────────────┤
│  Backend API (Express · Railway)                         │
│  ├── /v1/ai        — Groq LLM (cover letters, drafts)   │
│  ├── /v1/gasless   — EIP-2771 relayer                   │
│  ├── /v1/upload    — Supabase file storage              │
│  ├── /v1/messages  — real-time chat                     │
│  ├── /v1/notifications — push alerts                    │
│  ├── /v1/evidence  — IPFS/Pinata pinning                │
│  ├── /v1/analytics — aggregated stats                   │
│  └── /v1/applications — application management          │
├─────────────────────────────────────────────────────────┤
│  Smart Contract (Solidity 0.8.20 · Arc EVM Testnet)     │
│  └── SecureFlow.sol — 27 functions, 29 events           │
│      OZ: Ownable2Step · ReentrancyGuard · Pausable      │
│              SafeERC20                                   │
├─────────────────────────────────────────────────────────┤
│  Indexing: Goldsky subgraph (arc-testnet)               │
│  Storage:  Supabase (messages, notifications, files)    │
│  IPFS:     Pinata (dispute evidence)                    │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui |
| Blockchain | Arc EVM Testnet (Chain ID 5042002) |
| Smart contracts | Solidity 0.8.20, Foundry, OpenZeppelin 5 |
| Wallet | Reown AppKit (WalletConnect v2) |
| Indexing | Goldsky subgraph (The Graph Protocol) |
| Backend | Node.js, Express, TypeScript (Railway) |
| AI | Groq API — `llama-3.3-70b-versatile` |
| Database | Supabase (Postgres + Realtime) |
| Storage | Supabase Storage + Pinata/IPFS |
| Gasless | EIP-2771 MinimalForwarder relayer |
| Testing | Vitest, React Testing Library, supertest |
| CI/CD | GitHub Actions + Vercel |

---

## Smart Contract Surface

<details>
<summary>All 27 functions</summary>

**Escrow lifecycle**
- `createEscrow` — create with milestones, token, deadline, arbiters
- `startWork` — freelancer accepts and begins
- `submitMilestone` — freelancer submits deliverable
- `approveMilestone` — client approves, funds released to freelancer
- `rejectMilestone` — client rejects with reason
- `emergencyRefundAfterDeadline` — reclaim surplus 30 days past deadline

**Disputes**
- `disputeMilestone` — freelancer raises a dispute on a milestone
- `raiseOverdueDispute` — dispute when client is unresponsive past deadline
- `resolveDispute` — arbiter resolves with split amounts
- `submitEvidence` — attach IPFS CID to any milestone

**Open job flow**
- `applyToJob` — freelancer applies with cover letter + timeline
- `acceptFreelancer` — client assigns from applicants

**Fund management** (before assignment)
- `addJobFunds(escrowId, amount, milestoneIndex)` — add funds, credited to specific milestone
- `withdrawJobFunds(escrowId, amount, milestoneIndex)` — reduce a milestone's budget
- `cancelJob` — cancel with tiered penalty

**Milestone negotiation**
- `proposeMilestoneChange` — freelancer proposes new amount/description
- `approveMilestoneProposal` — client approves
- `rejectMilestoneProposal` — client rejects

**Misc**
- `extendDeadline` — add days to live escrow
- `submitRating` — 1–5 star rating after release

**Admin**
- `whitelistToken` / `delistToken` — manage accepted ERC-20s
- `authorizeArbiter` / `revokeArbiter` — manage arbiters
- `setPlatformFee` — update fee in basis points (100 bp = 1%)
- `withdrawFees` — collect accumulated platform fees
- `pause` / `unpause` — emergency circuit breaker
- `quoteDeposit` — view helper: total deposit including fee

</details>

<details>
<summary>Fee model</summary>

| Scenario | Fee |
|---|---|
| Platform fee (default) | 2.5% of deposit |
| Cancellation — first 2 cancellations | 0% penalty |
| Cancellation — 3–5 | 5% of remaining balance |
| Cancellation — 6–10 | 10% |
| Cancellation — 11+ | 15% |
| Per-applicant penalty | +0.1% per application received |
| Maximum cancellation penalty | 30% |
| Penalty decay | –1% per 30 days since last cancellation |

</details>

---

## Local Development

### Prerequisites

- Node.js 20+
- [Foundry](https://getfoundry.sh)
- MetaMask or any EVM wallet
- Arc Testnet faucet funds ([faucet.testnet.arc.network](https://faucet.testnet.arc.network))

### Setup

```bash
git clone https://github.com/Gbangbolaoluwagbemiga/Secureflow-Arc
cd Secureflow-Arc

# Frontend
npm install
cp .env.example .env   # fill in your values
npm run dev            # http://localhost:5173

# Backend
cd backend
npm install
cp .env.example .env   # fill in GROQ_API_KEY, SUPABASE_*, etc.
npm run dev
```

### Environment variables

**Frontend (`.env`)**

```env
VITE_SECUREFLOW_CONTRACT_ADDRESS=0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59
VITE_USDC_TOKEN_CONTRACT=0x3600000000000000000000000000000000000000
VITE_ARC_RPC_URL=https://rpc.drpc.testnet.arc.network
VITE_ARC_CHAIN_ID=5042002
VITE_ARC_EXPLORER_URL=https://testnet.arcscan.app
VITE_REOWN_PROJECT_ID=           # WalletConnect project ID
VITE_API_URL=                    # Backend URL (Railway or localhost:8787)
VITE_API_SECRET=                 # Must match API_SECRET in backend
VITE_GRAPH_URL=                  # Goldsky subgraph endpoint (optional, RPC fallback if omitted)
```

**Backend (`backend/.env`)**

```env
API_SECRET=
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_PROJECT_ID=
RELAYER_PRIVATE_KEY=             # EIP-2771 relayer wallet
CONTRACT_ADDRESS=0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59
FRONTEND_URL=https://secureflow-arc.vercel.app
```

### Add Arc Testnet to MetaMask

| Field | Value |
|---|---|
| Network Name | Arc EVM Testnet |
| RPC URL | `https://rpc.drpc.testnet.arc.network` |
| Chain ID | `5042002` |
| Currency Symbol | `ETH` |
| Block Explorer | `https://testnet.arcscan.app` |

---

## Testing

Both the frontend and backend have a Vitest suite that runs fully mocked/isolated — no live RPC calls, no real Supabase project, no testnet gas spent.

```bash
# Frontend — component tests (Vitest + React Testing Library + jsdom)
npm test

# Backend — route tests (Vitest + supertest), real wallet signatures via viem
cd backend
npm test
```

Backend tests cover the `/v1/upload` signature + on-chain ownership auth, `/v1/notifications`, and `/v1/applications` routes. Frontend tests cover notification UX, the escrow-card Message-button gating, cancel-job applicant notifications, and evidence-submission notifications — plus a cross-package test asserting the upload auth message format stays byte-identical between frontend and backend.

---

## Contract Deployment

```bash
cd contracts/solidity

# Build
forge build

# Deploy
PRIVATE_KEY=0x... forge script script/Deploy.s.sol \
  --rpc-url https://rpc.drpc.testnet.arc.network \
  --broadcast --legacy

# Whitelist USDC (update address in script first)
PRIVATE_KEY=0x... forge script script/WhitelistUSDC.s.sol \
  --rpc-url https://rpc.drpc.testnet.arc.network \
  --broadcast --legacy
```

---

## Subgraph (Goldsky)

```bash
cd subgraph
npm install
npm run build

# Deploy (requires goldsky login)
goldsky subgraph deploy secureflow/v1 --path .
```

Endpoint: `https://api.goldsky.com/api/public/project_cmpyopkeb3cxh01v51s4wg5nc/subgraphs/secureflow/v2/gn`

The frontend automatically uses the subgraph when `VITE_GRAPH_URL` is set and silently falls back to RPC multicall if the endpoint is unreachable.

---

## Project Structure

```
SecureFlow-Arc/
├── src/                    # React frontend
│   ├── components/         # UI components (dashboard, jobs, admin, …)
│   ├── pages/              # Route pages
│   ├── hooks/              # React Query + contract hooks
│   ├── lib/
│   │   ├── graph/          # Goldsky GraphQL client + queries + normalizer
│   │   └── web3/           # ContractService, ABI, types, config
│   ├── contexts/           # Wallet, notifications, web3 providers
│   └── store/              # Zustand wallet store
├── backend/                # Express API (Railway)
│   └── src/routes/         # ai, gasless, upload, messages, …
├── contracts/solidity/     # Foundry project
│   ├── src/SecureFlow.sol  # Main contract
│   └── script/             # Deploy + whitelist scripts
├── subgraph/               # Goldsky / Graph Protocol
│   ├── schema.graphql
│   ├── subgraph.yaml
│   └── src/mapping.ts
└── .github/workflows/ci.yml
```

---

## Security

- **OpenZeppelin primitives** — `Ownable2Step`, `ReentrancyGuard`, `Pausable`, `SafeERC20`
- **Non-custodial** — funds never leave the smart contract until conditions are met
- **Role separation** — depositor, beneficiary, and arbiters are distinct roles with non-overlapping permissions
- **Reentrancy guards** on all state-changing functions that transfer value
- **Emergency pause** — owner can halt all new escrow creation and transitions
- **No upgradeability** — contract is immutable after deployment; no proxy risk
- **Signed file uploads** — milestone/application attachments require the uploader to sign a per-request message with their wallet; the backend verifies the signature and, once a job has an assigned freelancer, checks on-chain that the signer is actually the depositor or beneficiary of that escrow

To report a security issue, email [gbangbolaphilip@gmail.com](mailto:gbangbolaphilip@gmail.com).

---

## License

[Apache 2.0](LICENSE) — © 2026 SecureFlow

# BASELINE — what existed before ETHOnline 2026

**Atelier is a Continuity-track entry.** Two products existed and were live before the event
opened on **September 4, 2026**. This file records exactly what they were, so that anything not
described here is event work and can be judged as such.

The rule we are holding ourselves to: **if it is listed on this page, it does not count.**

---

## The line

Everything in commit [`f9a3f45`] and earlier is pre-existing work, vendored into this repository
unchanged. That commit is tagged:

```
pre-ethonline
```

To see only the work done during the event:

```bash
git diff pre-ethonline..HEAD          # every line written during ETHOnline 2026
git log  pre-ethonline..HEAD          # every commit made during ETHOnline 2026
```

Nothing before that tag was written during the event. The two commits that make up the baseline
(`295fcdc`, `f9a3f45`) were authored on Sept 5 because that is when the two source trees were
copied into this workspace — **the copy happened during the event; the code did not.** The
authoritative dates are the upstream commit dates below.

---

## Source repositories and exact baseline commits

Both source projects are independent, live repositories. They are vendored here as plain files,
not submodules, so that a judge can read the whole thing without cloning anything.

| Project | Upstream repository | Baseline commit | Authored |
|---|---|---|---|
| SecureFlow | `Gbangbolaoluwagbemiga/Secureflow-Arc` | `ade68edde5f9b60f406523c8357f8a6020a2bba1` | **2026-08-28** |
| Patron | `Gbangbolaoluwagbemiga/Patron` | `e403ea069949641d3e6f344c58b3de5990eb18c4` | **2026-08-17** |

Both baseline commits predate the event by **7 and 18 days** respectively. Neither repository has
received a commit since; all event work happens here, in this repository, after the tag.

---

## What was already live on September 3, 2026

### SecureFlow — escrow protocol + dApp

Milestone-based freelance escrow on Arc EVM testnet. Deployed, verified, in use.

| | |
|---|---|
| App | `secureflow-arc.vercel.app` |
| Contract | `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59` (Arc EVM Testnet, chain ID `5042002`) |
| Subgraph | Goldsky `secureflow/v2` |
| Token | Circle USDC `0x3600000000000000000000000000000000000000` |

Pre-existing scope:

- **`SecureFlow.sol`** — 1,000 lines, 27 functions, 29 events. Escrow lifecycle, milestone
  submit/approve/reject, multi-arbiter disputes with IPFS evidence, open-job apply/accept,
  per-milestone fund management, tiered cancellation penalties, ratings, admin surface.
  OpenZeppelin `Ownable2Step` / `ReentrancyGuard` / `Pausable` / `SafeERC20`.
- **React + Vite frontend** — ~32,500 lines across 11 pages (Home, Jobs, Freelancers, Create,
  Dashboard, Freelancer, Admin, Disputes, Approvals, Messages, Analytics). Tailwind + shadcn/ui,
  wagmi + Reown AppKit, dark glass design system.
- **Express backend** — ~1,800 lines. Groq-backed AI writers, EIP-2771 gasless relayer, Supabase
  upload/messages/notifications, Pinata evidence pinning, analytics.
- **Goldsky subgraph** with an RPC-multicall fallback path.
- **Test suites** — 6 Vitest specs (frontend components + lib) and 3 backend route specs.
- Foundry deploy scripts, CI via GitHub Actions, Vercel deployment config.

### Patron — AI agent that hires and pays humans

An autonomous agent built **on SecureFlow's contracts**, entered at the Encode Programmable Money
Hackathon. Deployed and running 24/7.

| | |
|---|---|
| Command center | `patron-guild.vercel.app` |
| Daemon API | `patron-daemon-production.up.railway.app` |
| Telegram | `@PatronGuildbot` |
| Escrow | the same SecureFlow contract above |

Pre-existing scope:

- **Daemon** — ~10,900 lines on raw `node:http`, running continuously.
  - `agent/` — the guild-master brain: `BriefGenerator`, `ApplicationScorer`, `WorkReviewer`,
    `VisionReviewer`, `ApplicantEvidence`, `DeliverableFacts`. Provider-agnostic structured
    outputs with zod schemas and prompt-injection defenses.
  - `circle/` — Circle Agent Wallets (MPC), x402 seller **and** buyer, Gateway settlement.
  - `workers/` — a Circle MPC wallet per human freelancer, plus the Telegram bot.
  - `graph/` — subgraph poller that drives hiring, scoring and payment decisions.
  - `web3/` — SecureFlow ABI and contract bindings.
  - SQLite persistence and an SSE event stream.
- **React command center** (`web/`) — ~7,200 lines, 8 pages. Gold-on-black, Fraunces serif,
  decision log and payment feed.
- **`/work` front door** and Telegram bot — a human takes a paid job with no wallet install.
- E2E scripts, Docker + Railway deploy config.

---

## What is explicitly NOT new work

Stated plainly so there is no ambiguity at judging:

- The `SecureFlow.sol` contract as deployed, and its deployment
- Every existing SecureFlow page, component, hook, and backend route
- The Patron daemon in its entirety — brain, Circle integration, worker wallets, Telegram bot
- The existing Goldsky subgraph and its schema
- The x402 seller/buyer plumbing and Circle Agent Wallet layer
- Both existing design systems, considered separately
- Every test listed above

---

## What counts as new work during the event

Recorded here in advance, and checkable against `git log pre-ethonline..HEAD`:

- **Atelier** — the unified product layer over both systems: app shell, routing, and one
  information architecture in which the freelancer experience is singular and only the client
  area has modes.
- **Autopilot as a client mode for human clients** — the surface neither source product has. A
  human posts a job and delegates brief-writing, applicant scoring and review to the agent, while
  still holding escrow, still able to dispute.
- **Mode as a property of a job**, carried from creation through to the decision log.
- The **merged design system** and its teal/amber semantic — teal marks a human decision, amber
  marks an agent decision — as real tokens, not a coat of paint.
- The **Autopilot job view**: agent activity and decision log surfaced inside Atelier.
- A **shared identity and reputation layer** across both client modes.
- Everything in the track portfolio: verified-human reputation gating, random arbiter selection,
  productive escrow, and the load-bearing Graph wiring.

Anything not on this list and not in the baseline above will be described honestly in the
submission as what it actually is.

---

## Known pre-existing flaws we are carrying in

Named now rather than discovered later, because the honesty is worth more than the cover:

1. **Reputation is farmable.** `submitRating` trusts any address, so one person with fifty
   wallets can manufacture a record. Pillar 1 exists to fix this.
2. **Arbiter selection is unaccountable.** Arbiters are authorized by the owner and assigned
   without a public rule, so "who picked this arbiter" has no good answer today.
3. **SecureFlow hardcodes its model IDs.** `backend/src/lib/groq.ts` pins `openai/gpt-oss-120b`
   in three constants even though `.env.example` documents a `GROQ_MODEL` variable. A Groq
   decommission has already broken this once. Patron does it correctly in `daemon/src/config.ts`.
4. **Patron holds signing keys server-side.** Deliberate — the daemon must run unattended — but
   it is a real custody surface, not a solved problem.

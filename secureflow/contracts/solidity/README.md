# SecureFlow contracts

Solidity 0.8.20 · Foundry · OpenZeppelin 5.

## Setup

`forge-std` is vendored. OpenZeppelin is not — it is declared as a submodule in
`secureflow/.gitmodules`, so fetch it once before building:

```bash
git clone --depth 1 --branch v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts \
  lib/openzeppelin-contracts
```

Then:

```bash
forge build
forge test
```

## Tests

`test/` was added during ETHOnline 2026 — the baseline had no Solidity tests at
all. It currently covers the Autopilot job-manager delegation:

| File | What it holds |
|---|---|
| `JobManagerBase.t.sol` | Shared fixture: mock USDC, the five-party cast, helpers to build a live Autopilot job |
| `JobManager.t.sol` | 20 unit tests — appointment, revocation, the permission boundary, disputes mid-Autopilot |
| `JobManagerInvariant.t.sol` | The one-way key as a fuzzed invariant, plus liveness checks proving the handler is not inert |

The invariant that matters:

> **No sequence of actions available to a manager can cause value to reach the
> manager.**

Run it alone:

```bash
forge test --match-contract JobManagerInvariantTest -vv
```

## Deployments

| Network | Address | Notes |
|---|---|---|
| Arc EVM Testnet (`5042002`) | `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59` | **Pre-ETHOnline.** Does *not* include the job manager. |

The job-manager delegation needs a redeploy before Atelier's Autopilot mode can
claim it in production — see `docs/adr/0001-autopilot-delegation.md`.

# Environment Setup

This guide describes the local setup required to run EduVault and test the main marketplace workflows.

## Prerequisites

- Node.js 20 or newer
- npm 10 or a compatible pnpm version
- Docker, if you want to run MongoDB locally through `docker compose`
- A MongoDB connection string
- Pinata credentials for IPFS uploads
- Wallet tooling for testing wallet-connected flows

## Install Dependencies

```bash
npm install
```

The repository may include multiple lockfiles while package-manager usage is being consolidated. Prefer the package manager already used by your branch or team before regenerating lockfiles.

## Configure Environment Variables

Copy the example file and fill in local values:

```bash
cp .env.example .env.local
```

Required local values for the main app are:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string used by API routes |
| `JWT_SECRET` | Secret used to sign local session tokens |
| `NEXT_PUBLIC_APP_URL` | Base URL for local links, usually `http://localhost:3000` |
| `PINATA_JWT` | Pinata API token used for uploads |
| `NEXT_PUBLIC_GATEWAY_URL` | Public gateway URL for reading pinned content |

Optional values include SMTP settings, WalletConnect project configuration, and planned Stellar/Soroban settings such as `NEXT_PUBLIC_STELLAR_NETWORK`, `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, and `NEXT_PUBLIC_SOROBAN_CONTRACT_ID`.

## Start MongoDB

Use Docker when you do not already have a local or hosted MongoDB instance:

```bash
docker compose up -d mongodb
```

Set `MONGODB_URI` in `.env.local` to the connection string exposed by your local container or hosted database.

## Run the App

```bash
npm run dev
```

Open the local app at `http://localhost:3000`.

## Useful Checks

```bash
npm run lint
npm test
npm run test:backend
npm run scan:secrets
```

Run focused checks before opening a pull request, and add broader checks when you touch shared API, storage, or workflow code.

## Operational Scripts

- `npm run indexer:stellar` starts the Stellar indexer prototype.
- `node scripts/reprocess-deadletter.mjs` retries dead-lettered indexer events.
- `npm run indexer:repair -- 100` reconciles at most 100 legacy, interrupted,
  or failed event receipts. The command is bounded and safe to rerun because
  projections are idempotent.
- `node scripts/backup-mongodb.mjs` runs the MongoDB backup helper when configured.

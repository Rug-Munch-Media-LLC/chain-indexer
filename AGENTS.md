# AGENTS.md — chain-indexer

Multi-chain event indexer for Rug Munch Media. Processes on-chain events from
EVM chains (Ethereum, BSC, Arbitrum, Base, Polygon, TRON) and Solana via
Subsquid Pipes SDK into compressed NDJSON archives.

## Where It Lives
- Source: `https://github.com/RugMunchMedia/chain-indexer`

## Open-Core Protection

This repo is open source (MIT). The code here demonstrates multi-chain indexing
patterns — it is NOT the complete RugMunch production indexing infrastructure.
The managed platform at rugmunch.io includes proprietary data pipelines and
operational tooling.

See [CONTRIBUTING.md](CONTRIBUTING.md) for our methodology approach.
for details on what information belongs in public vs private repos.

## Commands
```bash
npm install          # install deps
npm run build        # build project
npm start            # start indexing
```

## Git Policy

This repo:
- Classification: OPEN SOURCE
- Remotes: codeberg + github + gitlab + radicle (primary)
- Commits: type(scope): description
- Never commit: .env, secrets, internal IPs, security reports

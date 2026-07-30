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

## 🚨 GIT POLICY — NON-NEGOTIABLE

1. **NEVER commit .env files, credentials, API keys, or tokens**
2. **NEVER use HTTPS remotes with embedded passwords — SSH only**
3. **NEVER commit before gitleaks passes** (`gitleaks detect --no-git`)
4. **NEVER push to main without lefthook pre-commit passing**
5. **All secrets come from gopass — NEVER hardcoded**
6. **All repos must have: .gitignore, .gitleaks.toml, .lefthook.yml**
7. **Internal IPs/hostnames use [INTERNAL] placeholder in public repos**
8. **Any agent caught leaking secrets will have their work rejected**

This repo:
- Classification: OPEN SOURCE
- Remotes: codeberg + github + gitlab + radicle (primary)
- Commits: type(scope): description

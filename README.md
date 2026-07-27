# Chain Indexer

Multi-chain blockchain indexer for RugMunch Media. Streams decoded events
from EVM chains (Ethereum, BSC, Arbitrum, Base, Polygon, TRON) and Solana
via Subsquid Pipes SDK into compressed NDJSON archives.

## Architecture
- **Subsquid Pipes SDK** — streaming decoded events
- **NDJSON output** — newline-delimited JSON for streaming consumption
- **zstd compression** — level 10 compression for archival
- **R2 offsite** — compressed archives shipped to Cloudflare R2

## Quick Start

```bash
# Clone the repo
git clone https://github.com/RugMunchMedia/chain-indexer.git
cd chain-indexer

# Install dependencies
npm install

# Build
npm run build

# Start indexing
npm start
```

## Open-Core Model

This repo is open source (MIT). The code here demonstrates multi-chain indexing
patterns using Subsquid Pipes SDK. The RugMunch managed platform at rugmunch.io
includes proprietary indexing infrastructure and data pipelines.

See [OPEN-CORE.md](OPEN-CORE.md) for details.

## Chains Indexed
Ethereum, BSC, Arbitrum, Base, Polygon, TRON, Solana

## License
MIT — see [LICENSE](LICENSE)

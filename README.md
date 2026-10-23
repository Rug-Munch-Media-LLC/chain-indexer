# Chain Indexer (archived)

> Subsquid-based multi-chain indexer, archived 2026-08-08 and superseded by lite-chain-indexer.

**License:** [MIT](LICENSE) · **Canonical:** https://git.rugmunch.io/RugMunchMedia/chain-indexer
**Mirrors:** [GitHub](https://github.com/Rug-Munch-Media-LLC) · [GitLab](https://gitlab.com/rug-munch-media-group) · [Codeberg](https://codeberg.org/RugMunchMedia)

**Clone over Nostr:** `git clone nostr://npub1e97559tn2j6j02shalmn5x6xv5jt8ejlclh6sta8nln0n55whwtszyrqud/git.cryptorugmunch.com/chain-indexer` (GRASP)

> ## 🚫 ARCHIVED — 2026-08-08
>
> **This repository is archived and superseded by
> [`lite-chain-indexer`](https://git.rugmunch.io/RugMunchMedia/lite-chain-indexer)**, the canonical
> production indexing pipeline.
>
> **Why:** the Subsquid-based pipeline has fatal production bugs — streams
> always restart from genesis, there is zero reorg handling, and the rclone
> sync step is dangerous when run against live archives. `lite-chain-indexer`
> fixes all three and is strictly superior.
>
> **Do not run, deploy, or extend this code.** See [ARCHIVED.md](ARCHIVED.md)
> for the full archival record and death reasons. The repo is kept read-only
> for reference.

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

# Chain Indexer

Multi-chain blockchain indexer for RugMunch Media. Streams decoded events
from EVM chains (Ethereum, BSC, Arbitrum, Base, Polygon, TRON) and Solana
via Subsquid Pipes SDK into compressed NDJSON archives.

## Architecture
- **Subsquid Pipes SDK** — streaming decoded events
- **NDJSON output** — newline-delimited JSON for streaming consumption
- **zstd compression** — level 10 compression for archival
- **R2 offsite** — compressed archives shipped to Cloudflare R2

## Chains Indexed
Ethereum, BSC, Arbitrum, Base, Polygon, TRON, Solana

## License
MIT — see [LICENSE](LICENSE)

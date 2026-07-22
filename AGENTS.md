# chain-indexer

Multi-chain event indexer for Rug Munch Media. Processes on-chain events, stores normalized data, and feeds the analytics pipeline.

## Git Policy

See the master Git Policy at /root/AGENTS.md. This repo:
- Classification: OPEN SOURCE
- Remotes: forgejo + codeberg + gitlab + radicle
- Push: git push forgejo main && git push codeberg main && git push gitlab main && rad sync
- Commits: type(scope): description
- Never commit: .env, secrets, internal IPs, security reports

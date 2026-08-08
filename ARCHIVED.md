# ARCHIVED — chain-indexer

**Archival date:** 2026-08-08
**Status:** READ-ONLY / archived. Do not run, deploy, or extend.
**Replacement:** [`lite-chain-indexer`](/srv/work/repos/lite-chain-indexer) — the
canonical production indexing pipeline.

## Summary

The `chain-indexer` repo (Subsquid Pipes SDK based multi-chain indexer) has been
formally archived. `lite-chain-indexer` is strictly superior and supersedes it
as the canonical production pipeline. This repo is kept only as a historical
reference.

## Death Reasons (from audit)

1. **Subsquid streams always restart from genesis.** There is no durable
   checkpoint/cursor persistence across restarts, so every restart re-plays the
   full chain from block 0. This makes the pipeline impractical and wasteful at
   production scale.

2. **Zero reorg handling.** The pipeline does not detect or handle chain
   reorganizations. Indexed archives can contain stale/orphaned blocks with no
   mechanism to roll back or reconcile, producing corrupt or inconsistent data.

3. **rclone sync danger on archives.** The `rclone` sync step used to ship
   archives offsite is unsafe when run against live/actively-written archives —
   it can delete or overwrite data mid-write, risking partial or lost archives.

## Replacement

`lite-chain-indexer` (`/srv/work/repos/lite-chain-indexer`) addresses all three
failures: durable checkpoints, reorg handling, and safe archive shipping. It is
the canonical production pipeline for RugMunch Media indexing.

## Actions

- README.md updated with an ARCHIVED banner (2026-08-08).
- No systemd services were stopped (ops action owned by root).
- No git commit made in this archival step.

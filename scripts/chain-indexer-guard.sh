#!/bin/bash
# chain-indexer-guard.sh — THE one chain-indexer data lifecycle. No other
# compress/backup/cleanup jobs may exist for this data (no double-bake).
#
# Every 4h: COMPRESS raw jsonl -> SHIP to R2 -> VERIFY -> TORCH local -> CAP.
# 6 backups/day, 6 torches/day, permanent archives in R2 (r2:backups/chain-indexer/).

set -u
DATA=/srv/data/chain-indexer
R2_DEST=r2:backups/chain-indexer
LOG=/var/log/chain-indexer-guard.log
MAX_DIR_MB=12288       # 12G hard cap
TRIM_TO_MB=8192        # trim target when cap hit
RAW_AGE_MIN=240        # raw jsonl older than 4h gets compressed+shipped
MIN_FREE_MB=5120

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
free_mb() { df -m / | awk 'NR==2{print $4}'; }
dir_mb() { du -sm "$DATA" 2>/dev/null | cut -f1; }

# ── 0. emergency: disk critically full ──
if [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; then
  log "CRITICAL: $(free_mb)MB free — emergency raw trim"
  find "$DATA" -name "*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | head -200 | cut -d' ' -f2- | xargs -r rm -f
fi

# ── 1. COMPRESS: raw jsonl older than 4h -> .zst (temp inside data dir) ──
export TMPDIR="$DATA/.tmp"; mkdir -p "$TMPDIR"
find "$DATA" -name "*.jsonl" -not -path "*/.tmp/*" -mmin +$RAW_AGE_MIN -type f 2>/dev/null | while read -r f; do
  zstd -q -f --rm "$f" 2>>"$LOG" && log "compressed: $f" || log "WARN: zstd failed $f"
done
rm -rf "$TMPDIR"

# ── 2+3. SHIP to R2 with verification (copy + check) ──
R2_OK=false
if command -v rclone >/dev/null && rclone lsd r2: >/dev/null 2>&1; then
  R2_OK=true
else
  log "CRITICAL: rclone/r2 unavailable — ship AND cap-delete of .zst suspended this run"
fi
if [ "$R2_OK" = true ]; then
  rclone copy "$DATA" "$R2_DEST" --include "*/" --include "*.jsonl.zst" --exclude "*" \
    --s3-upload-cutoff 100M --transfers 8 --log-level ERROR 2>>"$LOG"
  if [ $? -eq 0 ]; then
    log "shipped .zst batch to $R2_DEST"
    # ── 4. TORCH: delete only files verified present in R2 ──
    rclone lsf "$R2_DEST" --recursive --files-only 2>/dev/null | sort > /tmp/r2_manifest.txt
    find "$DATA" -name "*.jsonl.zst" -type f 2>/dev/null | while read -r f; do
      rel="${f#$DATA/}"
      if grep -qxF "$rel" /tmp/r2_manifest.txt; then
        rm -f "$f" && log "torched (verified in R2): $rel"
      else
        log "KEEP (not yet in R2): $rel"
      fi
    done
  else
    log "WARN: rclone ship failed — keeping local .zst, retry next run"
  fi
else
  log "WARN: rclone missing — .zst staying local"
fi

# ── 5. raw stragglers older than 2 days: delete (never archive-worthy) ──
find "$DATA" -name "*.jsonl" -mtime +2 -delete 2>>"$LOG"
find "$DATA" -type d -empty -delete 2>/dev/null

# ── 6. hard cap: raw .jsonl first; .zst ONLY if R2-verified; else ALERT ──
SIZE=$(dir_mb)
if [ "$SIZE" -gt "$MAX_DIR_MB" ]; then
  log "CAP: ${SIZE}MB > ${MAX_DIR_MB}MB — trimming raw .jsonl (oldest first)"
  find "$DATA" -name "*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- | while read -r f; do
    [ "$(dir_mb)" -le "$TRIM_TO_MB" ] && break
    rm -f "$f" && log "cap-trimmed raw: $f"
  done
  SIZE=$(dir_mb)
  if [ "$SIZE" -gt "$MAX_DIR_MB" ]; then
    if [ "$R2_OK" = true ]; then
      rclone lsf "$R2_DEST" --recursive --files-only 2>/dev/null | sort > /tmp/r2_manifest_cap.txt
      find "$DATA" -name "*.jsonl.zst" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- | while read -r f; do
        [ "$(dir_mb)" -le "$TRIM_TO_MB" ] && break
        rel="${f#$DATA/}"
        if grep -qxF "$rel" /tmp/r2_manifest_cap.txt; then
          rm -f "$f" && log "cap-trimmed (R2-verified): $rel"
        fi
      done
    fi
    SIZE=$(dir_mb)
    [ "$SIZE" -gt "$MAX_DIR_MB" ] && log "CRITICAL: still ${SIZE}MB over cap — unverified archives PRESERVED, manual action required" && logger -t chain-indexer-guard "CRITICAL: ${SIZE}MB over cap, unverified archives preserved"
  fi
fi

log "done: data=$(dir_mb)MB free=$(free_mb)MB"

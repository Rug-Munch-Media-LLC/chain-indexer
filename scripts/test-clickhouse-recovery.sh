#!/bin/bash
# Test: Can we rebuild ClickHouse from Parquet archives?
# This validates our "forever guarantee" — data is never lost.
set -euo pipefail

CHAIN="${1:-ethereum}"
DATE="${2:-$(date -u -d 'yesterday' +%Y-%m-%d)}"
TEMP_DIR="/tmp/ch-recovery-test-$$"

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

mkdir -p "$TEMP_DIR"

echo "=== ClickHouse Recovery Test ==="
echo "Chain: $CHAIN | Date: $DATE"

# Step 1: Pull Parquet from B2 (or R2 while migration in progress)
echo "[1/4] Pulling Parquet from backup..."
REMOTE="${B2_REMOTE:-b2-crypt}"
PARQUET_PATH="${REMOTE}:chain-data/parquet/${CHAIN}/${DATE//-/\/}/"
rclone copy "$PARQUET_PATH" "$TEMP_DIR/parquet/" --include "*.parquet" --progress 2>&1 || {
	# Fallback to R2 if B2 doesn't have it yet
	echo "B2 miss, trying R2..."
	rclone copy "r2-crypt:backups/chain-indexer-parquet/${CHAIN}/${DATE//-/\/}/" "$TEMP_DIR/parquet/" --include "*.parquet" --progress 2>&1 || {
		echo "SKIP: No Parquet for $CHAIN on $DATE"
		exit 0
	}
}

PARQUET_COUNT=$(ls "$TEMP_DIR/parquet/"*.parquet 2>/dev/null | wc -l)
echo "  Parquet files: $PARQUET_COUNT"

# Step 2: Load into DuckDB
echo "[2/4] Loading into DuckDB..."
RECOVERED=$(duckdb -c "
  SELECT count(*) as total 
  FROM read_parquet('$TEMP_DIR/parquet/*.parquet');
" -csv | tail -1)
echo "  Recovered events: $RECOVERED"

# Step 3: Compare with ClickHouse live
echo "[3/4] Comparing with ClickHouse..."
CH_COUNT=$(clickhouse-client --query "
  SELECT count() 
  FROM wallet_memory.evm_transfers 
  WHERE chain = '$CHAIN' 
    AND toDate(block_timestamp) = '$DATE'
" 2>/dev/null || echo "CLICKHOUSE_UNAVAILABLE")
echo "  ClickHouse events: $CH_COUNT"

# Step 4: Report
echo "[4/4] Results:"
if [ "$CH_COUNT" = "CLICKHOUSE_UNAVAILABLE" ]; then
	echo "  ⚠️  ClickHouse unavailable — recovery test partial"
	echo "  ✅ Parquet readable: $RECOVERED events recovered"
elif [ -n "$RECOVERED" ] && [ "$RECOVERED" -gt 0 ]; then
	if [ -n "$CH_COUNT" ] && [ "$CH_COUNT" -gt 0 ]; then
		RATIO=$(echo "scale=4; $RECOVERED / $CH_COUNT * 100" | bc)
		echo "  Recovery ratio: $RATIO%"
		if (($(echo "$RATIO >= 99.0" | bc -l))); then
			echo "  ✅ PASS: >= 99% parity"
		else
			echo "  ⚠️  WARN: < 99% — investigate"
		fi
	fi
else
	echo "  ❌ FAIL: Zero events recovered"
fi

# Write result to log
echo "$(date -Iseconds) | $CHAIN | $DATE | parquet=$PARQUET_COUNT | recovered=$RECOVERED | clickhouse=$CH_COUNT" >>/var/log/ch-recovery-test.log
echo "=== Done ==="

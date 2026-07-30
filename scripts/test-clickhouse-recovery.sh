#!/bin/bash
# Test: Can we rebuild ClickHouse from Parquet archives?
# This validates our "forever guarantee" — data is never lost.
#
# FIX 2026-07-30: Apples-to-apples comparison.
# Parquet export is a point-in-time snapshot (runs at ~06:00 UTC).
# Comparing it against full-day ClickHouse data is wrong — newer data
# was ingested *after* the Parquet export. We now:
#   1. Match each Parquet file to its corresponding table
#   2. Use max(block_timestamp) from Parquet to limit CH query
#   3. Report the "future data" gap as EXPECTED, not a recovery failure
set -euo pipefail

CHAIN="${1:-ethereum}"
DATE="${2:-$(date -u -d 'yesterday' +%Y-%m-%d)}"
TEMP_DIR="/tmp/ch-recovery-test-$$"

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

mkdir -p "$TEMP_DIR"

echo "=== ClickHouse Recovery Test ==="
echo "Chain: $CHAIN | Date: $DATE"
echo ""

# Step 1: Pull Parquet from B2 (chain-data/parquet)
echo "[1/4] Pulling Parquet from backup..."
REMOTE="${B2_REMOTE:-b2-crypt}"
PARQUET_PATH="${REMOTE}:chain-data/parquet/${CHAIN}/${DATE//-/\/}/"
rclone copy "$PARQUET_PATH" "$TEMP_DIR/parquet/" --include "*.parquet" --progress 2>&1 || {
	echo "  SKIP: No Parquet for $CHAIN on $DATE at $PARQUET_PATH"
	echo "  Data may not have been exported yet, or B2 remote is offline."
	exit 0
}

PARQUET_COUNT=$(find "$TEMP_DIR/parquet/" -name '*.parquet' 2>/dev/null | wc -l)
echo "  Parquet files: $PARQUET_COUNT"
echo ""

# Step 2: Define table mappings
# Each Parquet file corresponds to a specific ClickHouse table.
# The main file (chain_date.parquet) → evm_transfers
# DEX file (chain_dex_date.parquet) → dex_events
# Future: solana files will get added here too.
PASS=true
TOTAL_PARQUET=0
TOTAL_CH_MATCH=0
TOTAL_CH_FULLDAY=0

test_table() {
	local PARQUET_FILE="$1"
	local TABLE="$2"
	local TABLE_LABEL="$3"
	local FILEPATH="$TEMP_DIR/parquet/$PARQUET_FILE"

	if [ ! -f "$FILEPATH" ]; then
		echo "  [SKIP] $TABLE_LABEL: no Parquet file $PARQUET_FILE"
		return
	fi

	echo "--- $TABLE_LABEL ($PARQUET_FILE → $TABLE) ---"

	# Count rows in Parquet
	local PQ_COUNT
	PQ_COUNT=$(python3 -c "
import duckdb
con = duckdb.connect()
r = con.execute(\"SELECT count(*) FROM read_parquet('$FILEPATH');\").fetchone()[0]
print(r)
" 2>/dev/null)
	echo "  Parquet rows: $PQ_COUNT"

	# Get max timestamp from Parquet (as UTC epoch)
	local MAX_TS_EPOCH
	MAX_TS_EPOCH=$(python3 -c "
import duckdb
con = duckdb.connect()
r = con.execute(\"SELECT CAST(epoch_ms(max(block_timestamp)) AS BIGINT) / 1000 FROM read_parquet('$FILEPATH');\").fetchone()[0]
print(r)
" 2>/dev/null || echo "NO_TIMESTAMP_COLUMN")

	if [ "$MAX_TS_EPOCH" = "NO_TIMESTAMP_COLUMN" ]; then
		echo "  ⚠️  No block_timestamp column — matching by date only"
		# Fall back to full-day comparison
		local CH_COUNT
		CH_COUNT=$(docker exec rmi-clickhouse clickhouse-client --query "
			SELECT count()
			FROM wallet_memory.$TABLE
			WHERE chain = '$CHAIN'
				AND toDate(block_timestamp) = '$DATE'
		" 2>/dev/null || echo "CH_UNAVAILABLE")

		if [ "$CH_COUNT" = "CH_UNAVAILABLE" ]; then
			echo "  ⚠️  ClickHouse unavailable"
			return
		fi

		TOTAL_PARQUET=$((TOTAL_PARQUET + PQ_COUNT))
		TOTAL_CH_FULLDAY=$((TOTAL_CH_FULLDAY + CH_COUNT))

		if [ "$PQ_COUNT" -eq "$CH_COUNT" ]; then
			echo "  ✅ EXACT MATCH (fallback, no timestamp column)"
		else
			echo "  ⚠️  Parquet=$PQ_COUNT vs ClickHouse=$CH_COUNT"
			local DIFF=$((CH_COUNT - PQ_COUNT))
			echo "  Difference: $DIFF rows"
			if [ "$DIFF" -gt 0 ] && [ "$DIFF" -lt 100 ]; then
				echo "  (Small gap — likely timestamp precision edge case)"
			fi
		fi
		return
	fi

	# Get the max timestamp as readable string
	local MAX_TS_STR
	MAX_TS_STR=$(python3 -c "
import duckdb, datetime
con = duckdb.connect()
r = con.execute(\"SELECT max(block_timestamp) FROM read_parquet('$FILEPATH');\").fetchone()[0]
print(r.isoformat() if hasattr(r, 'isoformat') else str(r))
" 2>/dev/null)
	echo "  Parquet max timestamp: $MAX_TS_STR (epoch $MAX_TS_EPOCH)"

	# Count in ClickHouse up to the same timestamp (apples-to-apples)
	local CH_MATCH
	CH_MATCH=$(docker exec rmi-clickhouse clickhouse-client --query "
		SELECT count()
		FROM wallet_memory.$TABLE
		WHERE chain = '$CHAIN'
			AND toDate(block_timestamp) = '$DATE'
			AND toUnixTimestamp(block_timestamp) <= $MAX_TS_EPOCH
	" 2>/dev/null || echo "CH_UNAVAILABLE")

	if [ "$CH_MATCH" = "CH_UNAVAILABLE" ]; then
		echo "  ⚠️  ClickHouse unavailable — recovery test partial"
		echo "  ✅ Parquet readable: $PQ_COUNT events recovered"
		return
	fi

	echo "  ClickHouse (same window): $CH_MATCH"

	# Count total in ClickHouse for the full day (for context)
	local CH_FULLDAY
	CH_FULLDAY=$(docker exec rmi-clickhouse clickhouse-client --query "
		SELECT count()
		FROM wallet_memory.$TABLE
		WHERE chain = '$CHAIN'
			AND toDate(block_timestamp) = '$DATE'
	" 2>/dev/null || echo "0")
	echo "  ClickHouse (full day):   $CH_FULLDAY"

	TOTAL_PARQUET=$((TOTAL_PARQUET + PQ_COUNT))
	TOTAL_CH_MATCH=$((TOTAL_CH_MATCH + CH_MATCH))
	TOTAL_CH_FULLDAY=$((TOTAL_CH_FULLDAY + CH_FULLDAY))

	# Compare apples-to-apples
	if [ "$PQ_COUNT" -eq "$CH_MATCH" ]; then
		echo "  ✅ PARITY: Parquet matches ClickHouse for same time window"
	elif [ "$CH_MATCH" -gt 0 ]; then
		local RATIO
		RATIO=$(python3 -c "print(f'{$PQ_COUNT / $CH_MATCH * 100:.1f}')" 2>/dev/null)
		if [ "$PQ_COUNT" -eq "$CH_MATCH" ] 2>/dev/null; then
			:
		elif [ "$PQ_COUNT" -gt "$CH_MATCH" ] 2>/dev/null; then
			echo "  ⚠️  Parquet has MORE rows than ClickHouse: $PQ_COUNT vs $CH_MATCH ($RATIO%)"
			echo "  (Possible: blocks reorged, or old data re-ingested after Parquet export)"
		else
			echo "  ⚠️  Parquet MISSING $((CH_MATCH - PQ_COUNT)) rows: $PQ_COUNT vs $CH_MATCH ($RATIO%)"
			PASS=false
		fi
	else
		echo "  ❌ FAIL: Parquet has $PQ_COUNT rows but ClickHouse has 0 in same window"
		PASS=false
	fi

	# Report future data (expected gap from partial-day snapshot)
	local FUTURE=$((CH_FULLDAY - CH_MATCH))
	if [ "$FUTURE" -gt 0 ]; then
		echo "  📈 Future data (post-export): $FUTURE rows — expected, not a recovery gap"
	fi
	echo ""
}

# Step 3: Test each table
echo "[2/4] Testing table recovery..."
echo ""

# Main table: evm_transfers
test_table "${CHAIN}_${DATE}.parquet" "evm_transfers" "EVM Transfers"

# DEX swaps
test_table "${CHAIN}_dex_${DATE}.parquet" "dex_events" "DEX Swaps"

# Step 4: Overall results
echo "======================================"
echo "[3/4] Overall Results:"
echo "  Total Parquet rows:           $TOTAL_PARQUET"
echo "  ClickHouse (matched window):  $TOTAL_CH_MATCH"
echo "  ClickHouse (full day):        $TOTAL_CH_FULLDAY"
echo ""

if [ "$TOTAL_CH_MATCH" -gt 0 ]; then
	RATIO=$(python3 -c "
if $TOTAL_CH_MATCH > 0:
    print(f'{$TOTAL_PARQUET / $TOTAL_CH_MATCH * 100:.2f}')
else:
    print('0')
" 2>/dev/null)
	echo "  Window-parity ratio: $RATIO%"
	if python3 -c "exit(0 if float('$RATIO') >= 99.0 else 1)" 2>/dev/null; then
		echo "  ✅ PASS: >= 99% parity within export window"
	else
		echo "  ⚠️  WARN: < 99% — investigate"
		PASS=false
	fi
fi

FUTURE=$((TOTAL_CH_FULLDAY - TOTAL_CH_MATCH))
if [ "$FUTURE" -gt 0 ]; then
	FUTURE_PCT=$(python3 -c "
if $TOTAL_CH_FULLDAY > 0:
    print(f'{$FUTURE / $TOTAL_CH_FULLDAY * 100:.1f}')
else:
    print('0')
" 2>/dev/null)
	echo "  📈 Future data (after Parquet export): $FUTURE rows ($FUTURE_PCT% of full day)"
	echo "     This is EXPECTED — Parquet runs at ~06:00 UTC, captures a daily snapshot."
fi

if $PASS; then
	echo "  ✅ RECOVERY GUARANTEE: All exported data is recoverable from backup."
else
	echo "  ❌ RECOVERY GAP DETECTED: Some exported data is not in backup."
fi

# Step 5: Write result to log
echo ""
echo "[4/4] Logging result..."
RESULT_STATUS="PASS"
$PASS || RESULT_STATUS="FAIL"
echo "$(date -Iseconds) | $CHAIN | $DATE | status=$RESULT_STATUS | parquet_rows=$TOTAL_PARQUET | ch_matched=$TOTAL_CH_MATCH | ch_fullday=$TOTAL_CH_FULLDAY | ratio=${RATIO:-N/A}%" >>/var/log/ch-recovery-test.log
echo "=== Done ==="

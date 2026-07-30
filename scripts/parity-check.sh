#!/bin/bash
# Compare LiteIndexer vs Subsquid event counts per chain, per day.
# Alert if divergence > 5%. Run daily via cron.
set -euo pipefail

CHAIN="${1:-all}"
DATE="${2:-$(date -u -d 'yesterday' +%Y-%m-%d)}"
THRESHOLD="${3:-5}" # pct divergence threshold

if [ "$CHAIN" = "all" ]; then
	# All chains with active indexing
	CHAINS=("ethereum" "base" "bsc" "polygon" "arbitrum")
else
	CHAINS=("$CHAIN")
fi

echo "=== Parity Check: $(date -Iseconds) ==="

for chain in "${CHAINS[@]}"; do
	echo -n "$chain: "

	# LiteIndexer events from NDJSON
	LITE_FILE="/srv/data/chain-indexer/${chain}/${DATE}/events.jsonl"
	LITE_COUNT=$(grep -c '"source":"lite_indexer"' "$LITE_FILE" 2>/dev/null || echo "0")

	# Subsquid events from NDJSON (if chain-indexer writes there)
	SUBSQUID_COUNT=$(grep -c '"source":"subsquid"' "$LITE_FILE" 2>/dev/null || echo "0")

	# Also check ClickHouse for total counts
	CH_TOTAL=$(clickhouse-client --query "
        SELECT count() FROM wallet_memory.evm_transfers 
        WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
    " 2>/dev/null || echo "NA")

	if [ "$SUBSQUID_COUNT" != "0" ] && [ "$LITE_COUNT" != "0" ]; then
		RATIO=$(echo "scale=4; $LITE_COUNT / $SUBSQUID_COUNT" | bc 2>/dev/null || echo "NA")
		if [ "$RATIO" != "NA" ]; then
			DEV=$(echo "scale=2; ($RATIO - 1) * 100" | bc 2>/dev/null || echo "NA")
			ABS_DEV=$(echo "$DEV" | tr -d - | tr -d +)
			if (($(echo "$ABS_DEV > $THRESHOLD" | bc -l 2>/dev/null || echo 0))); then
				echo "⚠️  DIVERGENCE: Lite=$LITE_COUNT Subsquid=$SUBSQUID_COUNT (+${DEV}%) CH=$CH_TOTAL"
			else
				echo "✅ Lite=$LITE_COUNT Subsquid=$SUBSQUID_COUNT (+${DEV}%) CH=$CH_TOTAL"
			fi
		fi
	elif [ "$LITE_COUNT" != "0" ]; then
		echo "➖ Lite-only: $LITE_COUNT events (no Subsquid comparison available) CH=$CH_TOTAL"
	elif [ "$SUBSQUID_COUNT" != "0" ]; then
		echo "➖ Subsquid-only: $SUBSQUID_COUNT events (LiteIndexer not yet active) CH=$CH_TOTAL"
	else
		echo "⬜ No data for $chain on $DATE"
	fi
done

echo "=== Done ==="

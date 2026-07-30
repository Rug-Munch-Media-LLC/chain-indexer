#!/bin/bash
# Compare LiteIndexer vs Subsquid event counts per chain, per day.
# Queries ClickHouse for source-tagged data.
# Alert if divergence > threshold. Run daily via cron.
# Supports JSON output with --json flag.
set -euo pipefail

CH="docker exec rmi-clickhouse clickhouse-client"

# All chains with active indexing (both sources)
ALL_CHAINS=("arbitrum" "avalanche" "base" "bsc" "ethereum" "gnosis" "linea" "mantle" "optimism" "polygon" "scroll" "zksync")

# Detect --json flag (can be any positional arg)
JSON_MODE=0
POSITIONAL=()
for arg in "$@"; do
	if [ "$arg" = "--json" ]; then
		JSON_MODE=1
	else
		POSITIONAL+=("$arg")
	fi
done

CHAIN="${POSITIONAL[0]:-all}"
DATE="${POSITIONAL[1]:-$(date -u +%Y-%m-%d)}"
THRESHOLD="${POSITIONAL[2]:-5}" # pct divergence threshold

if [ "$CHAIN" = "all" ]; then
	CHAINS=("${ALL_CHAINS[@]}")
else
	CHAINS=("$CHAIN")
fi

# JSON header
if [ "$JSON_MODE" -eq 1 ]; then
	echo '{'
	echo '  "tool": "parity-check",'
	echo '  "date": "'"$DATE"'",'
	echo '  "threshold": '"$THRESHOLD"','
	echo '  "timestamp": "'"$(date -Iseconds)"'",'
	echo '  "chains": {'
fi

FIRST=1
ALERT=0

for chain in "${CHAINS[@]}"; do
	# LiteIndexer events from ClickHouse (source-tagged)
	LITE_COUNT=$($CH --query "
        SELECT count() FROM wallet_memory.evm_transfers
        WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
        AND source = 'lite_indexer'
    " 2>/dev/null || echo "0")
	LITE_COUNT="${LITE_COUNT%%[!0-9]*}"

	# Subsquid events from ClickHouse (source-tagged)
	SUBSQUID_COUNT=$($CH --query "
        SELECT count() FROM wallet_memory.evm_transfers
        WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
        AND source = 'subsquid'
    " 2>/dev/null || echo "0")
	SUBSQUID_COUNT="${SUBSQUID_COUNT%%[!0-9]*}"

	# Total in ClickHouse for that chain+date
	CH_TOTAL=$($CH --query "
        SELECT count() FROM wallet_memory.evm_transfers
        WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
    " 2>/dev/null || echo "0")
	CH_TOTAL="${CH_TOTAL%%[!0-9]*}"

	# Calculate divergence (absolute %)
	DEV=""
	ABS_DEV=0
	if [ "${SUBSQUID_COUNT:-0}" -gt 0 ] && [ "${LITE_COUNT:-0}" -gt 0 ]; then
		RATIO=$(echo "scale=6; $LITE_COUNT / $SUBSQUID_COUNT" | bc 2>/dev/null || echo "NA")
		if [ "$RATIO" != "NA" ]; then
			DEV=$(echo "scale=2; ($RATIO - 1) * 100" | bc 2>/dev/null || echo "NA")
			ABS_DEV=$(echo "$DEV" | sed 's/^-//;s/^+//' 2>/dev/null || echo "0")
		fi
	elif [ "${LITE_COUNT:-0}" -gt 0 ] || [ "${SUBSQUID_COUNT:-0}" -gt 0 ]; then
		ABS_DEV=100
	fi

	# Determine status
	STATUS="nodata"
	if [ "${SUBSQUID_COUNT:-0}" -gt 0 ] && [ "${LITE_COUNT:-0}" -gt 0 ]; then
		if (($(echo "$ABS_DEV > $THRESHOLD" | bc -l 2>/dev/null || echo 0))); then
			STATUS="diverged"
			ALERT=1
		else
			STATUS="ok"
		fi
	elif [ "${LITE_COUNT:-0}" -gt 0 ]; then
		STATUS="lite_only"
	elif [ "${SUBSQUID_COUNT:-0}" -gt 0 ]; then
		STATUS="subsquid_only"
	fi

	if [ "$JSON_MODE" -eq 1 ]; then
		# JSON output
		[ "$FIRST" -eq 0 ] && echo ','
		echo -n "    \"${chain}\": {"
		echo -n "\"status\": \"${STATUS}\", "
		echo -n "\"lite\": ${LITE_COUNT}, "
		echo -n "\"subsquid\": ${SUBSQUID_COUNT}, "
		echo -n "\"total\": ${CH_TOTAL}, "
		echo -n "\"divergence_pct\": ${ABS_DEV:-0}"
		echo -n '}'
		FIRST=0
	else
		# Human-readable output
		echo -n "$chain: "
		case "$STATUS" in
		diverged)
			echo "⚠️  DIVERGENCE: Lite=$LITE_COUNT Subsquid=$SUBSQUID_COUNT (+${DEV}%) Total=$CH_TOTAL"
			;;
		ok)
			echo "✅ Lite=$LITE_COUNT Subsquid=$SUBSQUID_COUNT (+${DEV}%) Total=$CH_TOTAL"
			;;
		lite_only)
			echo "✅ self-hosted: $LITE_COUNT events Total=$CH_TOTAL"
			;;
		subsquid_only)
			echo "ℹ️  legacy (Subsquid): $SUBSQUID_COUNT events Total=$CH_TOTAL"
			;;
		*)
			echo "⬜ No data for $chain on $DATE"
			;;
		esac
	fi

	# DEX events parity sub-check (human-readable only for brevity in JSON mode)
	if [ "$JSON_MODE" -eq 0 ]; then
		LITE_DEX=$($CH --query "
            SELECT count() FROM wallet_memory.dex_events
            WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
            AND source = 'lite_indexer'
        " 2>/dev/null || echo "0")
		SQD_DEX=$($CH --query "
            SELECT count() FROM wallet_memory.dex_events
            WHERE chain = '$chain' AND toDate(block_timestamp) = '$DATE'
            AND source = 'subsquid'
        " 2>/dev/null || echo "0")
		LITE_DEX="${LITE_DEX%%[!0-9]*}"
		SQD_DEX="${SQD_DEX%%[!0-9]*}"

		if [ "${LITE_DEX:-0}" -gt 0 ] || [ "${SQD_DEX:-0}" -gt 0 ]; then
			echo "  └─ DEX: Lite=$LITE_DEX Subsquid=$SQD_DEX"
		fi
	fi
done

# JSON footer
if [ "$JSON_MODE" -eq 1 ]; then
	echo ''
	echo '  },'
	echo '  "alert": '$ALERT','
	echo '  "alert_threshold_pct": '"$THRESHOLD"
	echo '}'
fi

exit $ALERT

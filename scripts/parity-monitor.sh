#!/bin/bash
# Automated parity monitor — compares LiteIndexer vs Subsquid
# Runs hourly, alerts on >threshold% divergence
# Usage: bash parity-monitor.sh [threshold] [date]
set -euo pipefail

THRESHOLD="${1:-10}" # % divergence threshold
DATE="${2:-$(date -u +%Y-%m-%d)}"
ALERT_FILE="${ALERT_FILE:-/tmp/parity-alert.json}"
CH="docker exec rmi-clickhouse clickhouse-client"

# All 12 indexed chains
CHAINS=("ethereum" "base" "bsc" "polygon" "arbitrum" "optimism" "avalanche" "gnosis" "linea" "mantle" "scroll" "zksync")

echo "=== Parity Monitor: $DATE (threshold=${THRESHOLD}%) @ $(date -Iseconds) ==="
echo ""

DIVERGED=0
ALERTS=()

for chain in "${CHAINS[@]}"; do
	LITE=$($CH --query "
        SELECT count() FROM wallet_memory.evm_transfers
        WHERE chain='$chain' AND toDate(block_timestamp)='$DATE'
        AND source='lite_indexer'
    " 2>/dev/null || echo "0")
	LITE=$(echo "$LITE" | tr -d '[:space:]')

	SUBSQUID=$($CH --query "
        SELECT count() FROM wallet_memory.evm_transfers
        WHERE chain='$chain' AND toDate(block_timestamp)='$DATE'
        AND source='subsquid'
    " 2>/dev/null || echo "0")
	SUBSQUID=$(echo "$SUBSQUID" | tr -d '[:space:]')

	LITE="${LITE:-0}"
	SUBSQUID="${SUBSQUID:-0}"

	# If either source missing, report but don't fail
	if [ "$LITE" = "0" ] || [ "$SUBSQUID" = "0" ]; then
		if [ "$LITE" != "0" ] && [ "$SUBSQUID" = "0" ]; then
			echo "  ℹ️  $chain: lite-only ($LITE events)"
		elif [ "$LITE" = "0" ] && [ "$SUBSQUID" != "0" ]; then
			echo "  ℹ️  $chain: subsquid-only ($SUBSQUID events)"
		else
			echo "  ⬜ $chain: no data"
		fi
		continue
	fi

	# Calculate divergence
	MAX=$(echo "$LITE $SUBSQUID" | tr ' ' '\n' | sort -n | tail -1)
	if [ "$MAX" -gt 0 ]; then
		DIFF=$(python3 -c "
import sys
l = float('$LITE')
s = float('$SUBSQUID')
if l == s:
    print('0.0')
else:
    pct = abs(l - s) / max(l, s) * 100
    print(f'{pct:.1f}')
" 2>/dev/null || echo "0.0")
	else
		DIFF="0.0"
	fi

	if (($(echo "$DIFF > $THRESHOLD" | bc -l 2>/dev/null || echo 0))); then
		echo "  ⚠️  $chain: DIVERGENCE ${DIFF}% (lite=$LITE, subsquid=$SUBSQUID)"
		DIVERGED=1
		ALERTS+=("$chain:${DIFF}%")
	else
		echo "  ✅ $chain: ${DIFF}% (lite=$LITE, subsquid=$SUBSQUID)"
	fi
done

echo ""

# Generate JSON alert if diverged
if [ "$DIVERGED" -eq 1 ]; then
	ALERT_JSON=$(
		ALERTED=""
		for a in "${ALERTS[@]}"; do
			[ -n "$ALERTED" ] && ALERTED="${ALERTED},"
			ALERTED="${ALERTED}\"${a}\""
		done
		cat <<EOF
{
  "alert": "parity_divergence",
  "date": "$DATE",
  "threshold": $THRESHOLD,
  "timestamp": "$(date -Iseconds)",
  "chains_alerted": [${ALERTED}],
  "severity": "warning"
}
EOF
	)
	echo "$ALERT_JSON" >"$ALERT_FILE"
	echo "⚠️  PARITY ALERT: One or more chains exceed ${THRESHOLD}% divergence"
	echo "   Alert written to $ALERT_FILE"
fi

# Also write a machine-readable summary for the health endpoint
SUMMARY_FILE="/tmp/parity-summary.json"
{
	echo '{'
	echo '  "date": "'"$DATE"'",'
	echo '  "alert": '"$DIVERGED"','
	ALERTED2=""
	for a in "${ALERTS[@]}"; do
		[ -n "$ALERTED2" ] && ALERTED2="${ALERTED2},"
		ALERTED2="${ALERTED2}\"${a}\""
	done
	echo "  \"alerts\": [${ALERTED2}],"
	echo '  "timestamp": "'"$(date -Iseconds)"'"'
	echo '}'
} >"$SUMMARY_FILE"

echo ""
echo "=== Parity Monitor Complete: $(date -Iseconds) ==="
exit $DIVERGED

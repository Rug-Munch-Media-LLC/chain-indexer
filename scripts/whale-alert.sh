#!/usr/bin/env bash
# Whale Alert — sends large transfer/swap alerts to Telegram
# Run every 5 min via crontab or systemd timer
# Scans chain-indexer NDJSON for whale-flagged events and posts to Telegram

set -euo pipefail

BOT_TOKEN="${WHALE_ALERT_BOT_TOKEN:?WHALE_ALERT_BOT_TOKEN must be set}"
CHAT_ID="${WHALE_ALERT_CHAT_ID:--1003818352164}" # CRYPTO_ALERTS channel
DATA_DIR="${DATA_DIR:-/srv/data/chain-indexer/jsonl}"
LAST_RUN_FILE="${LAST_RUN_FILE:-/srv/data/chain-indexer/state/whale_alert_last_run}"

# Only process files newer than last run
if [ -f "$LAST_RUN_FILE" ]; then
	LAST_RUN=$(cat "$LAST_RUN_FILE")
else
	LAST_RUN=$(date -u +%s)
fi

NOW=$(date -u +%s)
ALERTS=0

for chain_dir in "$DATA_DIR"/*/; do
	chain=$(basename "$chain_dir")

	# Scan DEX events for whale flags
	dex_dir="$chain_dir/dex"
	[ -d "$dex_dir" ] || continue

	# Find files modified since last run
	find "$dex_dir" -name 'events.jsonl' -newermt "@$LAST_RUN" 2>/dev/null | while read -r file; do
		python3 -c "
import json, urllib.request, urllib.parse, sys

with open('$file') as f:
    for line in f:
        try:
            evt = json.loads(line)
            if not evt.get('whale'): continue
            
            swap_type = evt.get('type', 'event')
            dex = evt.get('dex', 'unknown')
            chain = evt.get('chain', '')
            addr = evt.get('contractAddress', '')[:10]
            
            if swap_type == 'swap':
                amt = evt.get('amount0In', '0') or evt.get('amount0Out', '0')
                msg = f'🐋 WHALE SWAP on {chain.upper()} via {dex}\n'
                msg += f'Pool: ...{addr}\n'
                msg += f'Amount: {amt[:8]}...'
            else:
                amt = evt.get('amount0', '0')
                msg = f'🐋 WHALE {swap_type.upper()} on {chain.upper()}\n'
                msg += f'Pool: ...{addr}\n'
                msg += f'Amount: {amt[:8]}...'
            
            # Send to Telegram
            qs = urllib.parse.urlencode({
                'chat_id': '$CHAT_ID',
                'text': msg,
                'parse_mode': 'HTML'
            })
            url = f'https://api.telegram.org/bot$BOT_TOKEN/sendMessage?{qs}'
            try:
                urllib.request.urlopen(url, timeout=10)
                sys.stderr.write(f'  Alert sent: {chain} {swap_type}\n')
            except Exception as e:
                sys.stderr.write(f'  Telegram failed: {e}\n')
        except:
            pass
"
		ALERTS=$((ALERTS + 1))
	done
done

echo "$NOW" >"$LAST_RUN_FILE"
echo "Whale alert run complete — $ALERTS alerts sent"

#!/usr/bin/env bash
# Smart Alpha Alerts — intelligent multi-signal detection
# Signals: DEV_DUMP, WHALE_SELLOFF, LIQUIDITY_PULL, NEW_WHALE_BUY, RUG_ALERT, CEX_DEPOSIT
# Cross-references: chain-indexer NDJSON + ClickHouse wallet_labels + deployer tracking

set -euo pipefail

BOT_TOKEN="${ALERT_BOT_TOKEN:?ALERT_BOT_TOKEN must be set}"
ALERTS_CHAT="${ALERTS_CHAT:--1003818352164}" # CRYPTO_ALERTS
ALPHA_CHAT="${ALPHA_CHAT:--1003762675055}"   # CRYPTO_ALPHA
DATA_DIR="${DATA_DIR:-/path/to/data/chain-indexer/jsonl}"
STATE_DIR="${STATE_DIR:-/path/to/data/chain-indexer/state}"
LAST_RUN_FILE="$STATE_DIR/alpha_alert_last_run"

# Channel routing: urgent → ALERTS, alpha → ALPHA
send_alert() {
	local chat_id="$1" msg="$2"
	python3 -c "
import urllib.request, urllib.parse, sys
qs = urllib.parse.urlencode({'chat_id': '$chat_id', 'text': '''$msg''', 'parse_mode': 'HTML', 'disable_web_page_preview': 'true'})
try:
    urllib.request.urlopen(f'https://api.telegram.org/bot$BOT_TOKEN/sendMessage?{qs}', timeout=10)
except Exception as e:
    sys.stderr.write(f'Telegram err: {e}\n')
"
}

# ── Queries ──

# Query ClickHouse: get labels for an address
get_labels() {
	local addr="$1"
	python3 -c "
import urllib.request, urllib.parse
sql = f\"SELECT label FROM wallet_labels WHERE address = '${addr,,}' GROUP BY label\"
qs = urllib.parse.urlencode({'query': sql, 'user': 'default', 'password': '', 'database': 'default'})
try:
    resp = urllib.request.urlopen(f'http://localhost:8123/?{qs}', timeout=5)
    for line in resp.read().decode().strip().split(chr(10)):
        if line: print(line)
except: pass
"
}

# Query chain-indexer: get deployer for a token
get_deployer() {
	local chain="$1" token="$2"
	find "$DATA_DIR/$chain/deployers" -name 'deployments.jsonl' -newermt "7 days ago" 2>/dev/null | while read -r f; do
		python3 -c "
import json
with open('$f') as fh:
    for line in fh:
        try:
            d = json.loads(line)
            if d.get('tokenAddress','').lower() == '${token,,}':
                print(d.get('deployer',''))
                exit(0)
        except: pass
"
		[ $? -eq 0 ] && break
	done
}

# ── Signal Detectors ──

detect_dev_dump() {
	# Deployer wallet selling their own token → Critical
	local chain="$1" file="$2"
	python3 -c "
import json, subprocess, sys
with open('$file') as f:
    for line in f:
        try:
            evt = json.loads(line)
            if evt.get('type') != 'swap': continue
            sender = (evt.get('sender','') or '').lower()
            token = evt.get('contractAddress','').lower()
            if not sender or not token: continue
            
            # Check if sender is deployer of this token
            deployer = subprocess.check_output(['bash','-c',\"source /scripts/get_deployer.sh '$chain' '$token' 2>/dev/null || echo ''\"], text=True).strip().lower()
            if not deployer or deployer != sender: continue
            
            amt_out = evt.get('amount0Out','0') or evt.get('amount1Out','0')
            print(f'DEV_DUMP|{chain}|{token[:12]}|{amt_out[:16]}|{evt.get(\"txHash\",\"\")[:10]}')
        except: pass
"
}

detect_labeled_whale_action() {
	# Known entity (CEX, whale, fund) making large moves
	local chain="$1" file="$2"
	python3 -c "
import json, subprocess, sys
with open('$file') as f:
    for line in f:
        try:
            evt = json.loads(line)
            if not evt.get('whale'): continue
            sender = (evt.get('sender','') or '').lower()
            
            labels = subprocess.check_output(['bash','-c',\"get_labels '$sender' 2>/dev/null || echo ''\"], text=True).strip().split(chr(10))
            labels = [l for l in labels if l]
            if not labels: continue
            
            label_str = ','.join(labels[:3])
            swap_type = evt.get('type','')
            dex = evt.get('dex','unknown')
            amt = evt.get('amount0In','0') or evt.get('amount0Out','0')
            
            if any(l in ('binance','coinbase','kraken','okx','bybit','kucoin','gate.io','deribit') for l in labels):
                sig = 'CEX_DEPOSIT'
            elif any(l in ('mev-bot','sandwich') for l in labels):
                sig = 'MEV_ACTIVITY'
            elif any(l in ('phish-hack','scam','exploit') for l in labels):
                sig = 'SCAM_WALLET_ACTIVE'
            else:
                sig = 'LABELED_WHALE'
            
            print(f'{sig}|{chain}|{sender[:12]}|{label_str}|{dex}|{amt[:16]}')
        except: pass
"
}

detect_liquidity_pull() {
	# Large Burn event on DEX = LP removal = potential rug
	python3 -c "
import json, sys
with open('$1') as f:
    for line in f:
        try:
            evt = json.loads(line)
            if evt.get('type') != 'burn': continue
            if not evt.get('whale'): continue
            amt0 = int(evt.get('amount0','0'))
            amt1 = int(evt.get('amount1','0'))
            if amt0 < 10**16 and amt1 < 10**16: continue  # filter insignificant
            chain = evt.get('chain','')
            pool = evt.get('contractAddress','')[:12]
            print(f'LIQUIDITY_PULL|{chain}|{pool}|amt0={amt0}|amt1={amt1}')
        except: pass
"
}

detect_new_whale_buy() {
	# First large buy on a token (potential alpha)
	python3 -c "
import json, sys
with open('$1') as f:
    for line in f:
        try:
            evt = json.loads(line)
            if evt.get('type') != 'swap': continue
            if not evt.get('whale'): continue
            amt_in = int(evt.get('amount0In','0'))
            if amt_in < 10**18: continue  # <1 unit, skip
            sender = evt.get('sender','')[:12]
            token = evt.get('contractAddress','')[:12]
            dex = evt.get('dex','unknown')
            chain = evt.get('chain','')
            print(f'NEW_WHALE_BUY|{chain}|{token}|{sender}|{dex}')
        except: pass
"
}

# ── Main Loop ──

LAST_RUN=${LAST_RUN:-$(date -u -d '5 minutes ago' +%s 2>/dev/null || echo $(($(date -u +%s) - 300)))}
if [ -f "$LAST_RUN_FILE" ]; then LAST_RUN=$(cat "$LAST_RUN_FILE"); fi
NOW=$(date -u +%s)

echo "=== Alpha Alert Run — $(date -u) ==="

for chain_dir in "$DATA_DIR"/*/; do
	chain=$(basename "$chain_dir")

	# DEX events
	dex_dir="$chain_dir/dex"
	if [ -d "$dex_dir" ]; then
		find "$dex_dir" -name 'events.jsonl' -newermt "@$LAST_RUN" 2>/dev/null | while read -r dex_file; do

			# 1. Dev dumps
			detect_dev_dump "$chain" "$dex_file" | while IFS='|' read -r sig chain token amt tx; do
				msg="🔴 <b>DEV DUMP</b> on $chain
Token: $token
Amount: $amt
TX: $tx
<i>Deployer selling their own token</i>"
				send_alert "$ALERTS_CHAT" "$msg"
			done

			# 2. Labeled whale actions
			detect_labeled_whale_action "$chain" "$dex_file" | while IFS='|' read -r sig chain sender labels dex amt; do
				emoji="🐋"
				[ "$sig" = "CEX_DEPOSIT" ] && emoji="🏦"
				[ "$sig" = "SCAM_WALLET_ACTIVE" ] && emoji="⚠️"
				[ "$sig" = "MEV_ACTIVITY" ] && emoji="🤖"

				msg="$emoji <b>$sig</b> on $chain
Sender: $sender [$labels]
DEX: $dex | Amount: $amt"

				if [ "$sig" = "SCAM_WALLET_ACTIVE" ] || [ "$sig" = "CEX_DEPOSIT" ]; then
					send_alert "$ALERTS_CHAT" "$msg"
				else
					send_alert "$ALPHA_CHAT" "$msg"
				fi
			done

			# 3. Liquidity pulls
			detect_liquidity_pull "$dex_file" | while IFS='|' read -r sig chain pool details; do
				msg="🚨 <b>LIQUIDITY PULL</b> on $chain
Pool: $pool
$details
<i>Possible rug pull in progress</i>"
				send_alert "$ALERTS_CHAT" "$msg"
			done

			# 4. New whale buys (alpha)
			detect_new_whale_buy "$dex_file" | while IFS='|' read -r sig chain token sender dex; do
				msg="🐋 <b>NEW WHALE BUY</b> on $chain
Token: $token | DEX: $dex
Buyer: $sender
<i>Fresh whale entry — watch this token</i>"
				send_alert "$ALPHA_CHAT" "$msg"
			done

		done
	fi

	# Deployer events (new token deployments)
	dep_dir="$chain_dir/deployers"
	if [ -d "$dep_dir" ]; then
		find "$dep_dir" -name 'deployments.jsonl' -newermt "@$LAST_RUN" 2>/dev/null | while read -r dep_file; do
			python3 -c "
import json
count = 0
with open('$dep_file') as f:
    for line in f:
        d = json.loads(line)
        if d.get('type') == 'token': count += 1
if count >= 5:
    print(f'MASS_DEPLOY|$chain|{count}')
" | while IFS='|' read -r sig chain count; do
				msg="🔧 <b>MASS DEPLOYER</b> on $chain
$count tokens deployed in last 5 min
<i>Potential serial token launcher — check for rugs</i>"
				send_alert "$ALPHA_CHAT" "$msg"
			done
		done
	fi
done

echo "$NOW" >"$LAST_RUN_FILE"
echo "Alpha alert run complete"

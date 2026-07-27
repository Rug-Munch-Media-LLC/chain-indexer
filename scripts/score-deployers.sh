#!/usr/bin/env bash
# Deployer scoring cron — run daily via systemd timer or crontab
# Queries chain-indexer NDJSON data, computes deployer reputation,
# inserts scam labels into ClickHouse wallet_labels table.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/path/to/data/chain-indexer/jsonl}"
CH_HOST="${CLICKHOUSE_HOST:-rmi-clickhouse}"
CH_PORT="${CLICKHOUSE_PORT:-9000}"

echo "=== Deployer Scoring — $(date -u) ==="

for chain_dir in "$DATA_DIR"/*/; do
    chain=$(basename "$chain_dir")
    deployer_dir="$chain_dir/deployers"
    [ -d "$deployer_dir" ] || continue

    echo "  Chain: $chain"

    # Find today's and yesterday's deployment files
    today=$(date -u +%Y-%m-%d)
    yesterday=$(date -u -d yesterday +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)

    for date in "$today" "$yesterday"; do
        file="$deployer_dir/$date/deployments.jsonl"
        [ -f "$file" ] || continue

        echo "    Processing $date..."

        # Extract unique deployers and count their tokens
        python3 -c "
import json, subprocess, sys
from collections import defaultdict

deployers = defaultdict(lambda: {'tokens': 0, 'pools': 0})

with open('$file') as f:
    for line in f:
        try:
            d = json.loads(line)
            addr = d.get('deployer', '').lower()
            if d.get('type') == 'token':
                deployers[addr]['tokens'] += 1
            elif d.get('type') == 'pool':
                deployers[addr]['pools'] += 1
        except:
            pass

# Score deployers and insert labels
for addr, stats in deployers.items():
    total = stats['tokens'] + stats['pools']
    if total == 0:
        continue
    
    # Simple heuristic: more tokens = higher risk, pools alone = neutral
    score = 100
    if stats['tokens'] >= 10:
        score = 10
        tier = 'serial-rugger'
    elif stats['tokens'] >= 5:
        score = 30
        tier = 'high-risk-deployer'
    elif stats['tokens'] >= 3:
        score = 50
        tier = 'suspicious-deployer'
    elif stats['pools'] > 0 and stats['tokens'] == 0:
        tier = 'dex-deployer'
    else:
        tier = 'token-deployer'
    
    # Insert into ClickHouse
    try:
        import urllib.request, urllib.parse
        sql = f\"INSERT INTO wallet_labels (address, label, chain, source) VALUES ('{addr}', '{tier}', '$chain', 'chain-indexer-deployer-scoring')\"
        qs = urllib.parse.urlencode({'query': sql})
        url = f'http://$CH_HOST:8123/?{qs}'
        urllib.request.urlopen(url, timeout=5)
    except Exception as e:
        print(f'      CH insert failed for {addr}: {e}', file=sys.stderr)

print(f'    Scored {len(deployers)} deployers on $chain for $date')
"
    done
done

echo "=== Scoring complete ==="

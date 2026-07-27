#!/bin/bash
# RugMunch Methodology Leak Detection — Pre-Commit Hook
# Blocks commits that contain internal hostnames, IPs, gopass paths, or methodology
# Canonical source: standards/scripts/pre-commit-methodology-check.sh
# Installed per-repo: scripts/pre-commit-methodology-check.sh

set -euo pipefail

FORBIDDEN_PATTERNS=(
  # Internal hostnames
  'talos\.rugmunch\.io'
  'hydra\.rugmunch\.io'
  'cinnabox\.rugmunch\.io'
  'ssh netcup'
  'ssh contabo'
  'ssh talos'
  'ssh hydra'
  'root@talos'
  'root@netcup'

  # Internal IPs (Tailscale CGNAT range 100.64.0.0/10)
  '100\.6[4-9]\.'
  '100\.7[0-9]\.'
  '100\.8[0-9]\.'
  '100\.9[0-9]\.'
  '100\.1[01][0-9]\.'

  # Secret management paths
  'gopass show rmi/'
  'gopass.*rmi/'

  # Internal filesystem paths
  '/root/backend/'
  '/root/frontend/'
  '/root/\.hermes/'
  '/srv/work/repos.*\.git'
  '/srv/pryscraper'
  '/srv/walletpress'
  '/srv/data/'
  '/var/www/rmi'

  # Methodology keywords (high-signal — never in public code)
  'proprietary.*algorithm'
  'internal.*methodology'
  'competitor.*analysis.*method'
  'our.*scraping.*target'
  'production.*deploy.*root@'
)

FOUND=0
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
  echo "✅ Methodology check: clean (no staged files)"
  exit 0
fi

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  # Check staged files only (what's about to be committed)
  matches=$(echo "$STAGED_FILES" | xargs grep -ln "$pattern" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "❌ FORBIDDEN PATTERN: $pattern"
    echo "   Found in:"
    while IFS= read -r f; do
      echo "     $f"
    done <<< "$matches"
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "🚫 COMMIT BLOCKED: Methodology leak detected."
  echo "   These patterns reveal internal infrastructure or methods."
  echo "   See: standards/METHODOLOGY-PROTECTION.md"
  echo ""
  echo "   If this is a false positive, use:"
  echo "   git commit --no-verify  (with Lead approval)"
  exit 1
fi

echo "✅ Methodology check: clean"
exit 0

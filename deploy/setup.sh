#!/usr/bin/env bash
#
# chain-indexer — deployment setup script
#
# Run on Talos:
#   On the deploy host: bash /srv/chain-indexer/deploy/setup.sh
#
set -euo pipefail

REPO_DIR="$(dirname "$(dirname "$(readlink -f "$0")")")"
DEPLOY_DIR="$REPO_DIR/deploy"
DATA_DIR="/path/to/data/chain-indexer/jsonl"
STATE_DIR="${DATA_DIR:-/var/data/chain-indexer}/state"
ENV_FILE="$REPO_DIR/.env"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
SERVICE_NAME="chain-indexer.service"
SERVICE_SRC="$DEPLOY_DIR/$SERVICE_NAME"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"

echo "============================================"
echo "  chain-indexer — Setup"
echo "============================================"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────

echo "==> Checking prerequisites..."

if ! command -v rclone &>/dev/null; then
  echo "    [WARN] rclone not found. Install it:"
  echo "           curl -sSL https://rclone.org/install.sh | bash"
  echo "           (or: apt install rclone)"
fi

if ! command -v node &>/dev/null; then
  echo "    [WARN] Node.js not found. Install Node >= 22."
fi

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "    [INFO] No node_modules found — run: cd $REPO_DIR && npm install"
fi

echo ""

# ── Data directories ──────────────────────────────────────────────────────

echo "==> Creating data directories..."
mkdir -p "$DATA_DIR"
mkdir -p "$STATE_DIR"
echo "    $DATA_DIR"
echo "    $STATE_DIR"
echo ""

# ── Environment file ───────────────────────────────────────────────────────

echo "==> Setting up .env file..."
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "    Created $ENV_FILE"
  echo "    >>> EDIT IT with your R2 credentials before starting the service:"
  echo "        nano $ENV_FILE"
else
  echo "    $ENV_FILE already exists — skipping"
fi
echo ""

# ── rclone R2 remote ──────────────────────────────────────────────────────

echo "==> Configuring rclone R2 remote..."
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a

  R2_ENDPOINT="${R2_ENDPOINT_URL:-https://${R2_ACCOUNT_ID:-8f9bd9165c1250b426c66dc1967deefd}.r2.cloudflarestorage.com}"

  if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
    rclone config create r2 s3 provider=Cloudflare \
      access_key_id="$R2_ACCESS_KEY_ID" \
      secret_access_key="$R2_SECRET_ACCESS_KEY" \
      endpoint="$R2_ENDPOINT" \
      region=auto --non-interactive 2>/dev/null \
      && echo "    rclone remote 'r2' created" \
      || echo "    rclone remote 'r2' already exists (or config failed — that's OK, the app retries)"
  else
    echo "    R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set in .env — skipping rclone config"
  fi
else
  echo "    No .env file found — skipping rclone config"
fi
echo ""

# ── Systemd service ───────────────────────────────────────────────────────

echo "==> Installing systemd service..."
cp "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "    Service installed and enabled: $SERVICE_NAME"
echo ""

# ── Next steps ─────────────────────────────────────────────────────────────

echo "============================================"
echo "  chain-indexer setup complete!"
echo "============================================"
echo ""
echo "  Prerequisites (check once):"
echo "    - Node.js >= 22 installed?"
echo "    - npm install ran in $REPO_DIR?"
echo "    - rclone installed?"
echo ""
echo "  Quick start:"
echo "    nano $ENV_FILE                   # set R2 credentials"
echo "    systemctl start chain-indexer    # start the service"
echo "    systemctl status chain-indexer   # verify it's running"
echo "    journalctl -u chain-indexer -f   # follow the logs"
echo ""

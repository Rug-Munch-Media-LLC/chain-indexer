SHELL := /bin/bash
SSH := ssh netcup
REPO_DIR ?= /opt/chain-indexer

.PHONY: help deploy start stop restart logs status

help:
	@echo "chain-indexer — deploy targets"
	@echo ""
	@echo "  deploy   Rsync deploy dir to Talos + run setup.sh"
	@echo "  start    Start the systemd service"
	@echo "  stop     Stop the systemd service"
	@echo "  restart  Restart the systemd service"
	@echo "  logs     Tail journal logs"
	@echo "  status   Show service status + disk usage"

# ── Deploy ─────────────────────────────────────────────────────────────────

deploy:
	rsync -avz --delete ./ netcup:$(REPO_DIR)/deploy/
	$(SSH) bash $(REPO_DIR)/deploy/setup.sh

# ── Service lifecycle ──────────────────────────────────────────────────────

start:
	$(SSH) sudo systemctl start chain-indexer

stop:
	$(SSH) sudo systemctl stop chain-indexer

restart:
	$(SSH) sudo systemctl restart chain-indexer

# ── Observability ──────────────────────────────────────────────────────────

logs:
	$(SSH) sudo journalctl -u chain-indexer -f -n 50

status:
	$(SSH) sudo systemctl status chain-indexer --no-pager
	@echo ""
	@echo "--- Disk usage ---"
	$(SSH) du -sh /srv/data/chain-indexer/ 2>/dev/null || echo "(no data yet)"
	@echo "--- State files ---"
	$(SSH) ls -la /srv/data/chain-indexer/state/ 2>/dev/null || echo "(empty)"

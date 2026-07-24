# ── chain-indexer Makefile ─────────────────────────────────────
# Rug Munch Media fleet standard
#
# Blockchain indexer — multi-chain event ingestion pipeline.
# Python-based, runs as a long-lived service.

SHELL := /bin/bash
PYTHON := python3

.PHONY: help install dev build lint format typecheck test security check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	pip install -e ".[dev]"
	@command -v pre-commit >/dev/null 2>&1 && pre-commit install || true

dev: ## Start dev indexer
	$(PYTHON) -m indexer.main --dev

build: ## Build Docker image
	docker build -t chain-indexer .

lint: ## Lint with ruff
	ruff check . --select=E,F,W,I,B,SIM

format: ## Format with ruff
	ruff format .
	ruff check --fix .

typecheck: ## Run mypy type checks
	mypy indexer/ --ignore-missing-imports

test: ## Run tests
	$(PYTHON) -m pytest tests/ -v --tb=short

security: ## Run security checks
	bandit -r indexer/ -x tests/

check: ## Full quality gate
	$(MAKE) lint
	$(MAKE) format
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) security

clean: ## Remove build artifacts
	find . -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name '*.pyc' -delete
	rm -rf .mypy_cache/ .ruff_cache/ .pytest_cache/ build/ dist/ *.egg-info

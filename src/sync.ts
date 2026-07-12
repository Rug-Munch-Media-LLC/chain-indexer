/**
 * R2 sync via rclone.
 *
 * Pushes local NDJSON files to Cloudflare R2.
 * A separate cron job converts NDJSON → Parquet using DuckDB.
 *
 * Requires: rclone installed, R2 remote configured via env vars.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pino from 'pino';
import { DATA_DIR } from './chains.js';

const logger = pino({ name: 'sync' });

const R2_BUCKET = process.env.R2_BUCKET || 'rmi-data';
const R2_ENDPOINT = process.env.R2_ENDPOINT_URL || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

let rcloneConfigured = false;

function ensureRcloneConfig() {
  if (rcloneConfigured) return;
  if (!existsSync(DATA_DIR)) {
    logger.warn('Data directory does not exist yet');
    return;
  }

  // Configure rclone R2 remote if env vars are set
  if (R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY) {
    try {
      execSync(
        `rclone config create r2 s3 provider=Cloudflare \
        access_key_id="${R2_ACCESS_KEY}" \
        secret_access_key="${R2_SECRET_KEY}" \
        endpoint="${R2_ENDPOINT}" \
        region=auto --non-interactive 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
      rcloneConfigured = true;
      logger.info('R2 rclone remote configured');
    } catch {
      logger.warn('rclone config may already exist — continuing');
      rcloneConfigured = true;
    }
  }
}

/**
 * Sync local JSONL data to R2.
 * Uses rclone sync — one-directional, never deletes from R2.
 */
export async function syncToR2(): Promise<void> {
  ensureRcloneConfig();

  if (!existsSync(DATA_DIR)) {
    logger.debug('Data directory empty, skipping sync');
    return;
  }

  try {
    const cmd = `rclone sync "${DATA_DIR}" "r2:${R2_BUCKET}/jsonl/" \
      --progress \
      --transfers 4 \
      --checkers 8 \
      --max-age 5m \
      --ignore-errors \
      --no-update-modtime`;

    const output = execSync(cmd, {
      timeout: 600_000, // 10 min
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    logger.info({ output: output.trim() }, 'R2 sync complete');
  } catch (err: any) {
    if (err.stderr?.includes("couldn't find")) {
      logger.warn('R2 sync skipped — rclone remote not found. Set R2_* env vars.');
      return;
    }
    throw err;
  }
}

/**
 * Convert JSONL files to Parquet using DuckDB.
 * Run this on Talos where DuckDB is available.
 *
 * duckdb -c "
 *   COPY (
 *     SELECT * FROM read_json_auto('srv/data/chain-indexer/jsonl/ethereum/2026-07-12/events.jsonl')
 *   ) TO 'output.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
 * "
 */
export function jsonlToParquetCommand(chain: string, date: string): string {
  const jsonlFile = `${DATA_DIR}/${chain}/${date}/events.jsonl`;
  const parquetFile = jsonlFile.replace('.jsonl', '.parquet');

  return `duckdb -c "
    COPY (
      SELECT * FROM read_json_auto('${jsonlFile}')
    ) TO '${parquetFile}' (FORMAT PARQUET, COMPRESSION ZSTD);
  "`;
}

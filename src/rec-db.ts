// RecDO SQLite layer: schema/migration, factor-row mapping, and shared queries.

import type { FactorRow } from './scoring';

// workerd Durable Object SQLite caps bound parameters at 100 (SQLITE_MAX_VARIABLE_NUMBER).
const SQL_VAR_LIMIT = 100;

export type FactorsDbRow = {
  bias: number;
  v0: number; v1: number; v2: number; v3: number; v4: number;
  v5: number; v6: number; v7: number; v8: number; v9: number;
};

export function dbRowToFactorRow(row: FactorsDbRow): FactorRow {
  return {
    bias: row.bias,
    v: [row.v0, row.v1, row.v2, row.v3, row.v4,
        row.v5, row.v6, row.v7, row.v8, row.v9],
  };
}

/** Unpacks a latent factor vector into positional SQLite bind params (v0..v9). */
export function factorRowToBindParams(v: number[]): number[] {
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9]];
}

/** Defensively decodes an `all_topics` JSON column; malformed or empty values yield []. */
export function parseTopicsJson(raw: string): string[] {
  try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
}

/** Creates the interaction/factor/global-state tables and runs the all_topics migration. */
export function initRecSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      user_id    TEXT NOT NULL,
      article_id TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      action     TEXT NOT NULL,
      topics     TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      PRIMARY KEY (user_id, article_id, action)
    )
  `);
  // Index on ts enables O(log n) prune scans instead of O(n) full table scans.
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_interactions_ts ON interactions(ts)`,
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS global_state (
      id   INTEGER PRIMARY KEY DEFAULT 1,
      mean REAL    NOT NULL DEFAULT 0,
      n    INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(
    `INSERT OR IGNORE INTO global_state (id, mean, n) VALUES (1, 0, 0)`,
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_factors (
      user_id    TEXT    PRIMARY KEY,
      bias       REAL    NOT NULL DEFAULT 0,
      v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
      v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
      v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
      v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
      v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS item_factors (
      article_id TEXT    PRIMARY KEY,
      bias       REAL    NOT NULL DEFAULT 0,
      v0  REAL NOT NULL DEFAULT 0, v1  REAL NOT NULL DEFAULT 0,
      v2  REAL NOT NULL DEFAULT 0, v3  REAL NOT NULL DEFAULT 0,
      v4  REAL NOT NULL DEFAULT 0, v5  REAL NOT NULL DEFAULT 0,
      v6  REAL NOT NULL DEFAULT 0, v7  REAL NOT NULL DEFAULT 0,
      v8  REAL NOT NULL DEFAULT 0, v9  REAL NOT NULL DEFAULT 0,
      source_id  TEXT    NOT NULL DEFAULT '',
      topic      TEXT    NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Migration: add all_topics column for multi-topic weight scoring.
  // topic retains the primary topic for diversity bucketing; all_topics stores
  // the full JSON array so topicWeights can match any of an article's topics.
  try {
    sql.exec(
      `ALTER TABLE item_factors ADD COLUMN all_topics TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch { /* column already exists — safe to ignore */ }
}

/** Reads the singleton global_state row. */
export function readGlobalState(sql: SqlStorage): { mean: number; n: number } {
  type GsRow = { mean: number; n: number };
  const [gs] = [...sql.exec<GsRow>(
    `SELECT mean, n FROM global_state WHERE id = 1`,
  )];
  return { mean: gs?.mean ?? 0, n: gs?.n ?? 0 };
}

/**
 * Runs `sqlPrefix (?,?,...)` over `ids` in chunks of SQL_VAR_LIMIT so no
 * statement exceeds workerd's bound-parameter cap.
 */
export function selectByIdsChunked<T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage,
  sqlPrefix: string,
  ids: string[],
): T[] {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += SQL_VAR_LIMIT) {
    const chunk = ids.slice(i, i + SQL_VAR_LIMIT);
    rows.push(...sql.exec<T>(
      `${sqlPrefix} (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    ));
  }
  return rows;
}

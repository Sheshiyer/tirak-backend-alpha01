import { DatabaseSync } from 'node:sqlite';
import { loadMigrationChain, readSql, targetSchemaPath } from './artifacts';

/**
 * Offline SQLite harness for the T-028 validation suite. Uses the built-in
 * node:sqlite driver (Node >= 22.5; repo runs Node 24), so no native
 * dependency and no network access is required. Everything runs against
 * disposable in-memory databases.
 */

export function createDb(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

export function applySql(db: DatabaseSync, sql: string, label: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    throw new Error(`failed to apply ${label}: ${(err as Error).message}`);
  }
}

export function applyMigrationChain(db: DatabaseSync): void {
  for (const artifact of loadMigrationChain()) {
    applySql(db, artifact.sql, artifact.name);
  }
}

export function buildMigrationDb(): DatabaseSync {
  const db = createDb();
  applyMigrationChain(db);
  return db;
}

/**
 * Applies the contract target schema to a disposable database with minimal
 * parent stubs (users, bookings) so FK references resolve. Returns the domain
 * table names declared by the contract.
 */
export function buildContractDb(): { db: DatabaseSync; domainTables: string[] } {
  const contractSql = readSql(targetSchemaPath);
  const db = createDb();
  applySql(
    db,
    'CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE bookings (id TEXT PRIMARY KEY);',
    'contract parent stubs',
  );
  applySql(
    db,
    contractSql.replace(/PRAGMA\s+foreign_key_check\s*;/i, ''),
    'contracts/tirak-payments-v1/target-schema.sql',
  );
  const domainTables = [
    ...contractSql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi),
  ].map((m) => m[1]!);
  return { db, domainTables };
}

// ---------------------------------------------------------------------------
// Schema snapshotting and structural comparison
// ---------------------------------------------------------------------------

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Removes -- line comments and block comments so guards inspect executable SQL only. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Whitespace- and `IF NOT EXISTS`-insensitive DDL normalization. */
export function normalizeDdl(sql: string): string {
  return collapse(sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')).replace(/;\s*$/, '');
}

/** Extracts every CHECK(...) expression from a CREATE TABLE statement. */
export function extractChecks(sql: string): string[] {
  const checks: string[] = [];
  const re = /CHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    checks.push(collapse(sql.slice(re.lastIndex, i - 1)));
    re.lastIndex = i;
  }
  return checks.sort();
}

export interface ColumnSnap {
  name: string;
  type: string;
  notnull: boolean;
  dflt: string | null;
  pk: number;
}

export interface FkSnap {
  from: string;
  refTable: string;
  to: string;
  onDelete: string;
}

export interface IndexSnap {
  key: string;
  unique: boolean;
  partial: boolean;
  columns: string[];
  where: string | null;
}

export interface TableSnap {
  columns: ColumnSnap[];
  fks: FkSnap[];
  checks: string[];
  indexes: IndexSnap[];
  triggers: string[];
}

export function tableSnapshot(db: DatabaseSync, table: string): TableSnap | null {
  const master = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  if (!master) return null;

  const columns = (
    db
      .prepare(
        `SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${table}') ORDER BY cid`,
      )
      .all() as Array<{ name: string; type: string; nn: number; dflt: string | null; pk: number }>
  ).map((c) => ({
    name: c.name,
    type: collapse(String(c.type)).toUpperCase(),
    notnull: c.nn === 1,
    dflt: c.dflt == null ? null : collapse(String(c.dflt)),
    pk: c.pk,
  }));

  const fks = (
    db
      .prepare(
        `SELECT "from" AS fromCol, "table" AS refTable, "to" AS toCol, on_delete AS onDelete
         FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`,
      )
      .all() as Array<{ fromCol: string; refTable: string; toCol: string; onDelete: string }>
  ).map((f) => ({ from: f.fromCol, refTable: f.refTable, to: f.toCol, onDelete: f.onDelete }));

  const rawIndexes = db
    .prepare(
      `SELECT name, "unique" AS uniq, origin, partial FROM pragma_index_list('${table}') ORDER BY seq`,
    )
    .all() as Array<{ name: string; uniq: number; origin: string; partial: number }>;

  const indexes: IndexSnap[] = rawIndexes.map((idx) => {
    const columns = (
      db
        .prepare(`SELECT name FROM pragma_index_info('${idx.name}') ORDER BY seqno`)
        .all() as Array<{ name: string | null }>
    ).map((c) => c.name ?? '<expr>');
    let where: string | null = null;
    if (idx.partial) {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(idx.name) as { sql: string | null } | undefined;
      const match = row?.sql ? normalizeDdl(row.sql).match(/\bWHERE\b(.+)$/i) : null;
      where = match ? match[1]!.trim() : null;
    }
    // Auto-indexes backing UNIQUE constraints are keyed by their column list so
    // numbering differences (sqlite_autoindex_*_N) never produce false diffs.
    const key = idx.origin === 'c' ? idx.name : `auto:${columns.join(',')}`;
    return { key, unique: idx.uniq === 1, partial: idx.partial === 1, columns, where };
  });

  const triggers = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`)
      .all(table) as Array<{ name: string }>
  ).map((t) => t.name);

  return { columns, fks, checks: extractChecks(master.sql), indexes, triggers };
}

/** Full sqlite_master dump used for idempotency equality. */
export function fullSchemaDump(
  db: DatabaseSync,
): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

/**
 * Structurally diffs one table between the contract snapshot (expected) and
 * the migration-built snapshot (actual). Returns human-readable problems; an
 * empty array means an exact match.
 */
export function diffTable(
  table: string,
  expected: TableSnap | null,
  actual: TableSnap | null,
): string[] {
  const problems: string[] = [];
  if (!expected) return [`${table}: not present in the contract`];
  if (!actual) return [`${table}: missing from the migrated database`];

  const fmtCol = (c: ColumnSnap) =>
    `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt != null ? ` DEFAULT ${c.dflt}` : ''}${c.pk > 0 ? ` PK(${c.pk})` : ''}`;
  const eCols = expected.columns.map(fmtCol);
  const aCols = actual.columns.map(fmtCol);
  if (JSON.stringify(eCols) !== JSON.stringify(aCols)) {
    problems.push(
      `${table} columns differ\n  expected: ${JSON.stringify(eCols)}\n  actual:   ${JSON.stringify(aCols)}`,
    );
  }

  const fmtFk = (f: FkSnap) => `${f.from} -> ${f.refTable}(${f.to}) ON DELETE ${f.onDelete}`;
  const eFks = expected.fks.map(fmtFk).sort();
  const aFks = actual.fks.map(fmtFk).sort();
  if (JSON.stringify(eFks) !== JSON.stringify(aFks)) {
    problems.push(
      `${table} foreign keys differ\n  expected: ${JSON.stringify(eFks)}\n  actual:   ${JSON.stringify(aFks)}`,
    );
  }

  if (JSON.stringify(expected.checks) !== JSON.stringify(actual.checks)) {
    problems.push(
      `${table} CHECK constraints differ\n  expected: ${JSON.stringify(expected.checks)}\n  actual:   ${JSON.stringify(actual.checks)}`,
    );
  }

  const fmtIdx = (i: IndexSnap) =>
    `${i.key} unique=${i.unique} partial=${i.partial} cols=(${i.columns.join(', ')})${i.where ? ` WHERE ${i.where}` : ''}`;
  const eIdx = expected.indexes.map(fmtIdx).sort();
  const aIdx = actual.indexes.map(fmtIdx).sort();
  if (JSON.stringify(eIdx) !== JSON.stringify(aIdx)) {
    problems.push(
      `${table} indexes differ\n  expected: ${JSON.stringify(eIdx)}\n  actual:   ${JSON.stringify(aIdx)}`,
    );
  }

  if (JSON.stringify(expected.triggers) !== JSON.stringify(actual.triggers)) {
    problems.push(
      `${table} triggers differ\n  expected: ${JSON.stringify(expected.triggers)}\n  actual:   ${JSON.stringify(actual.triggers)}`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Data fixtures
// ---------------------------------------------------------------------------

/**
 * Inserts a row supplying generated values for every NOT NULL column that has
 * no default, so tests can seed parent rows (users, bookings, ...) without
 * coupling to the exact baseline shape of unrelated tables.
 */
export function seedStubRow(
  db: DatabaseSync,
  table: string,
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  const cols = db
    .prepare(
      `SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${table}') ORDER BY cid`,
    )
    .all() as Array<{ name: string; type: string; nn: number; dflt: string | null; pk: number }>;

  const salt = String(values.id ?? Math.random().toString(36).slice(2, 10));
  const record: Record<string, unknown> = { ...values };

  // Columns guarded by CHECK (col IN (...)) must receive an allowed literal,
  // otherwise generated stubs fail the CHECK (e.g. users.user_type).
  const master = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  const allowedLiterals = new Map<string, string>();
  if (master) {
    const re = /CHECK\s*\(\s*"?(?<col>\w+)"?\s+IN\s*\((?<vals>[^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(master.sql)) !== null) {
      const first = m.groups!.vals!.match(/'([^']*)'/);
      if (first) allowedLiterals.set(m.groups!.col!, first[1]!);
    }
  }

  for (const col of cols) {
    if (record[col.name] !== undefined) continue;
    if (col.pk > 0) {
      record[col.name] = `${table}_${salt}`;
      continue;
    }
    if (col.nn === 1 && col.dflt == null) {
      const allowed = allowedLiterals.get(col.name);
      if (allowed !== undefined) {
        record[col.name] = allowed;
        continue;
      }
      const type = String(col.type).toUpperCase();
      if (type.includes('INT')) record[col.name] = 1;
      else if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB'))
        record[col.name] = 1.0;
      else record[col.name] = `${table}_${col.name}_${salt}`;
    }
  }
  const names = Object.keys(record);
  db.prepare(
    `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
      .map(() => '?')
      .join(', ')})`,
  ).run(...(names.map((n) => record[n]) as never[]));
  return record;
}

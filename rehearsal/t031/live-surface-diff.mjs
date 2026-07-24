// T-031 Stage C probe 1 — restored validation schema surface vs tirak-payments-v1 contract.
// Replays evidence/t031/restored-schema.json (live sqlite_schema dump) into an
// in-memory DB and structurally diffs the 5 contract domain tables (columns,
// FKs, CHECKs, indexes) against contracts/tirak-payments-v1/target-schema.sql.
// Mirrors tests/migrations/helpers/sqlite.ts snapshot/diff logic.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const collapse = (v) => v.replace(/\s+/g, ' ').trim();
const normalizeDdl = (sql) => collapse(sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')).replace(/;\s*$/, '');

function extractChecks(sql) {
  const checks = [];
  const re = /CHECK\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let depth = 1, i = re.lastIndex;
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

function tableSnapshot(db, table) {
  const master = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!master) return null;
  const columns = db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${table}') ORDER BY cid`).all()
    .map((c) => ({ name: c.name, type: collapse(String(c.type)).toUpperCase(), notnull: c.nn === 1, dflt: c.dflt == null ? null : collapse(String(c.dflt)), pk: c.pk }));
  const fks = db.prepare(`SELECT "from" AS fromCol, "table" AS refTable, "to" AS toCol, on_delete AS onDelete FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`).all()
    .map((f) => ({ from: f.fromCol, refTable: f.refTable, to: f.toCol, onDelete: f.onDelete }));
  const rawIndexes = db.prepare(`SELECT name, "unique" AS uniq, origin, partial FROM pragma_index_list('${table}') ORDER BY seq`).all();
  const indexes = rawIndexes.map((idx) => {
    const cols = db.prepare(`SELECT name FROM pragma_index_info('${idx.name}') ORDER BY seqno`).all().map((c) => c.name ?? '<expr>');
    let where = null;
    if (idx.partial) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(idx.name);
      const match = row?.sql ? normalizeDdl(row.sql).match(/\bWHERE\b(.+)$/i) : null;
      where = match ? match[1].trim() : null;
    }
    const key = idx.origin === 'c' ? idx.name : `auto:${cols.join(',')}`;
    return { key, unique: idx.uniq === 1, partial: idx.partial === 1, columns: cols, where };
  });
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(table).map((t) => t.name);
  return { columns, fks, checks: extractChecks(master.sql), indexes, triggers };
}

function diffTable(table, expected, actual) {
  const problems = [];
  if (!expected) return [`${table}: not present in the contract`];
  if (!actual) return [`${table}: missing from the live rehearsal database`];
  const fmtCol = (c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt != null ? ` DEFAULT ${c.dflt}` : ''}${c.pk > 0 ? ` PK(${c.pk})` : ''}`;
  const eCols = expected.columns.map(fmtCol), aCols = actual.columns.map(fmtCol);
  if (JSON.stringify(eCols) !== JSON.stringify(aCols)) problems.push(`${table} columns differ\n  expected: ${JSON.stringify(eCols)}\n  actual:   ${JSON.stringify(aCols)}`);
  const fmtFk = (f) => `${f.from} -> ${f.refTable}(${f.to}) ON DELETE ${f.onDelete}`;
  const eFks = expected.fks.map(fmtFk).sort(), aFks = actual.fks.map(fmtFk).sort();
  if (JSON.stringify(eFks) !== JSON.stringify(aFks)) problems.push(`${table} foreign keys differ\n  expected: ${JSON.stringify(eFks)}\n  actual:   ${JSON.stringify(aFks)}`);
  if (JSON.stringify(expected.checks) !== JSON.stringify(actual.checks)) problems.push(`${table} CHECK constraints differ\n  expected: ${JSON.stringify(expected.checks)}\n  actual:   ${JSON.stringify(actual.checks)}`);
  const fmtIdx = (i) => `${i.key} unique=${i.unique} partial=${i.partial} cols=(${i.columns.join(', ')})${i.where ? ` WHERE ${i.where}` : ''}`;
  const eIdx = expected.indexes.map(fmtIdx).sort(), aIdx = actual.indexes.map(fmtIdx).sort();
  if (JSON.stringify(eIdx) !== JSON.stringify(aIdx)) problems.push(`${table} indexes differ\n  expected: ${JSON.stringify(eIdx)}\n  actual:   ${JSON.stringify(aIdx)}`);
  if (JSON.stringify(expected.triggers) !== JSON.stringify(actual.triggers)) problems.push(`${table} triggers differ`);
  return problems;
}

// --- Build live DB from the rehearsal dump ---
const dump = JSON.parse(readFileSync('evidence/t031/restored-schema.json', 'utf8'));
const rows = dump[0].results;
const live = new DatabaseSync(':memory:');
for (const r of rows.filter((r) => r.type === 'table')) live.exec(r.sql);
for (const r of rows.filter((r) => r.type === 'index' && r.sql)) live.exec(r.sql);

// --- Build contract DB ---
const contractSql = readFileSync('contracts/tirak-payments-v1/target-schema.sql', 'utf8');
const contract = new DatabaseSync(':memory:');
contract.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE bookings (id TEXT PRIMARY KEY);');
contract.exec(contractSql.replace(/PRAGMA\s+foreign_key_check\s*;/i, ''));

const domainTables = ['payment_attempts', 'payment_webhook_events', 'payment_restitutions', 'booking_chat_rooms', 'booking_chat_messages'];
const expectedObjects = [
  'payment_attempts', 'payment_webhook_events', 'idx_payment_attempts_customer', 'idx_payment_attempts_charge',
  'idx_payment_webhook_events_charge', 'uq_payment_attempt_active_booking',
  'booking_chat_rooms', 'booking_chat_messages', 'idx_booking_chat_rooms_customer',
  'idx_booking_chat_rooms_supplier', 'idx_booking_chat_messages_room_time',
  'payment_restitutions', 'idx_payment_restitutions_booking', 'idx_payment_restitutions_customer',
];

const liveNames = new Set(rows.map((r) => r.name));
const missing = expectedObjects.filter((n) => !liveNames.has(n));
const extraDomain = rows.filter((r) => /payment|booking_chat/.test(r.name) && !expectedObjects.includes(r.name)).map((r) => `${r.type}:${r.name}`);

const problems = [];
if (missing.length) problems.push(`missing contract objects in live dump: ${missing.join(', ')}`);
for (const t of domainTables) problems.push(...diffTable(t, tableSnapshot(contract, t), tableSnapshot(live, t)));

console.log(JSON.stringify({
  probe: 'live-surface-diff',
  expectedObjects: expectedObjects.length,
  missingInLiveDump: missing,
  extraDomainObjectsInLiveDump: extraDomain,
  diffProblems: problems,
  verdict: problems.length === 0 && missing.length === 0 ? 'MATCH' : 'DIFF',
}, null, 2));
process.exit(problems.length === 0 && missing.length === 0 ? 0 : 1);

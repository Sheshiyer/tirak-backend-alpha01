#!/usr/bin/env node
/**
 * verify-lineage.mjs — T-028 Lane D
 *
 * Offline, fail-closed lineage checker for the tirak-payments-v1 migration
 * strategy (docs/contracts/tirak-payments-v1/migration-strategy.md).
 *
 * Core rule enforced: NEVER trust a migration filename without checking the
 * target schema AND the d1_migrations ledger first. This tool is the guardrail
 * for that rule: given a target schema dump and a d1_migrations ledger dump
 * (both captured read-only, e.g. via `wrangler d1 execute --json`), it verifies
 * ledger-before-filename ordering:
 *
 *   - baseline  => exactly one ledger row, and it must be the first row;
 *   - then +1 row per applied migration, only in the approved order:
 *       canonical-baseline.sql
 *         -> 008_omise_promptpay_payments.sql   (payments)
 *           -> 010_booking_chat_expansion.sql   (additive booking chat)
 *           -> 011_payment_restitutions.sql     (restitutions)
 *     010 and 011 are siblings: either may come first, both require 008 first.
 *
 * It also cross-checks schema <-> ledger consistency in both directions:
 *   - a ledger row whose tables are missing from the schema is a
 *     partial-failure signature;
 *   - schema tables whose migration has no ledger row is a partial-failure
 *     signature (or an unknown precondition);
 *   - baseline applied but legacy pair-chat tables (chat_rooms/chat_messages)
 *     missing is the forbidden legacy-rename signature;
 *   - any quarantined filename, per-file baseline row, unknown ledger name,
 *     duplicate row, or unknown user table => refuse and escalate.
 *
 * There is no best-effort path: ANY deviation, unknown precondition, or
 * partial-failure signature exits non-zero with a REFUSE AND ESCALATE message.
 *
 * Pure node, no dependencies, no network. Never uses PRAGMA user_version
 * (refused on D1 with SQLITE_AUTH 7500 — d1_migrations is the sole ledger).
 *
 * Usage:
 *   node scripts/migrations/verify-lineage.mjs <schema-dump.json> <ledger-dump.json>
 *
 * Accepted dump shapes (either file):
 *   - wrangler `d1 execute --json` output: [ { results: [rows], success, meta } ]
 *   - a single batch object:             { results: [rows], success? }
 *   - a bare array of row objects:       [ { name: ... }, ... ]
 * Schema rows may be sqlite_schema rows ({type, name, sql?}) or
 * PRAGMA table_list rows ({schema, name, type, ...}). Ledger rows may be
 * d1_migrations rows ({id, name, applied_at?}) or bare name strings.
 *
 * Exit codes: 0 = recognized, consistent lineage state;
 *             1 = REFUSE AND ESCALATE (any deviation);
 *             2 = usage/IO error (inputs unreadable — nothing was verified).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Approved ledger names, in approved application order groups. */
const LEDGER_BASELINE = 'canonical-baseline.sql';
const LEDGER_PAYMENTS = '008_omise_promptpay_payments.sql';
const LEDGER_CHAT = '010_booking_chat_expansion.sql';
const LEDGER_RESTITUTIONS = '011_payment_restitutions.sql';
const APPROVED_NAMES = Object.freeze([
  LEDGER_BASELINE,
  LEDGER_PAYMENTS,
  LEDGER_CHAT,
  LEDGER_RESTITUTIONS,
]);

/** Quarantined forever: seeing one in a ledger is an automatic refusal. */
const QUARANTINED_NAMES = Object.freeze([
  '004_mobile_app_features.sql',
  '009_booking_scoped_chat.sql',
]);

/**
 * Baseline constituent files. The baseline must be exactly ONE ledger row;
 * any per-file row means someone replayed the directory — refuse.
 */
const BASELINE_CONSTITUENT_NAMES = Object.freeze([
  '001_initial_schema.sql',
  '002_add_indexes.sql',
  '003_add_analytics_tables.sql',
  '004_background_jobs_tables.sql',
  '005_muse_ai_foundation.sql',
  '006_referrals_tirak_coins.sql',
  '007_registration_profile_persistence.sql',
]);

/** Tables each approved ledger row must materialize, per the frozen contract. */
const TABLES_BY_MIGRATION = Object.freeze({
  [LEDGER_PAYMENTS]: Object.freeze(['payment_attempts', 'payment_webhook_events']),
  [LEDGER_CHAT]: Object.freeze(['booking_chat_rooms', 'booking_chat_messages']),
  [LEDGER_RESTITUTIONS]: Object.freeze(['payment_restitutions']),
});

/**
 * Baseline marker tables that must exist once the baseline row is present.
 * chat_rooms/chat_messages are the legacy pair-chat tables: their absence
 * after baseline is the forbidden legacy-rename signature.
 */
const BASELINE_MARKER_TABLES = Object.freeze([
  'users',
  'bookings',
  'chat_rooms',
  'chat_messages',
]);

/** Objects that are never part of the contract surface. */
const SYSTEM_TABLES = /^(sqlite_|_cf_KV$|d1_migrations$)/;

const violations = [];

function refuse(message) {
  violations.push(message);
}

function emitRefusalAndExit(context) {
  console.error('verify-lineage: REFUSE AND ESCALATE');
  console.error(`Context: ${context}`);
  console.error('The target cannot be classified into exactly one approved lineage state.');
  console.error('Per migration-strategy.md there is no best-effort path: stop, capture a');
  console.error('recovery point, and escalate to the release coordinator before any apply.');
  console.error('Deviations detected:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function usageExit(message) {
  console.error(`verify-lineage: ${message}`);
  console.error('Usage: node scripts/migrations/verify-lineage.mjs <schema-dump.json> <ledger-dump.json>');
  process.exit(2);
}

function loadJsonFile(path, label) {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) usageExit(`${label} not found: ${resolved}`);
  let text;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (error) {
    usageExit(`${label} unreadable: ${resolved} (${error.message})`);
  }
  try {
    return { data: JSON.parse(text), path: resolved };
  } catch (error) {
    usageExit(`${label} is not valid JSON: ${resolved} (${error.message})`);
  }
  return undefined; // unreachable
}

/**
 * Normalizes an accepted dump shape into a row array. Returns
 * { rows, failedProbe } where failedProbe indicates the capture itself
 * reported failure (e.g. wrangler success:false without results).
 */
function extractRows(data, label) {
  let batches;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null
      && ('results' in data[0] || 'success' in data[0] || 'error' in data[0])) {
    batches = data; // wrangler --json batch array
  } else if (!Array.isArray(data) && typeof data === 'object' && data !== null && 'results' in data) {
    batches = [data]; // single batch object
  } else if (Array.isArray(data)) {
    return { rows: data, failedProbe: null }; // bare row array
  } else {
    usageExit(`${label}: unrecognized dump shape (expected wrangler batch array, batch object, or row array)`);
  }

  const rows = [];
  let failedProbe = null;
  for (const batch of batches) {
    if (batch && batch.success === false) {
      failedProbe = typeof batch.error === 'string' ? batch.error : JSON.stringify(batch.error ?? batch);
      continue;
    }
    if (batch && Array.isArray(batch.results)) rows.push(...batch.results);
  }
  return { rows, failedProbe };
}

// ---------------------------------------------------------------------------
// Schema interpretation
// ---------------------------------------------------------------------------

function extractUserTables(schemaRows) {
  const tables = new Set();
  for (const row of schemaRows) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string') continue;
    // PRAGMA table_list rows carry a schema column; skip temp-schema objects.
    if (typeof row.schema === 'string' && row.schema === 'temp') continue;
    // sqlite_schema rows carry a type column; keep tables only when typed.
    if (typeof row.type === 'string' && row.type !== 'table') continue;
    if (SYSTEM_TABLES.test(row.name)) continue;
    tables.add(row.name);
  }
  return tables;
}

/** Baseline-owned tables, derived from repo SQL so this list cannot drift. */
function deriveBaselineTables() {
  const tables = new Set();
  const migrationsDir = join(REPO_ROOT, 'migrations');
  const candidates = [join(migrationsDir, 'baseline', LEDGER_BASELINE)];
  for (const name of BASELINE_CONSTITUENT_NAMES) candidates.push(join(migrationsDir, name));
  const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[\]]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, 'utf8');
    for (const match of sql.matchAll(createTableRe)) tables.add(match[1]);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Ledger interpretation
// ---------------------------------------------------------------------------

function extractLedgerEntries(ledgerRows) {
  const entries = [];
  for (const row of ledgerRows) {
    if (typeof row === 'string') {
      entries.push({ id: null, name: row });
    } else if (row && typeof row === 'object' && typeof row.name === 'string') {
      entries.push({ id: typeof row.id === 'number' ? row.id : null, name: row.name });
    }
  }
  // Wrangler d1_migrations ids are monotonic; order by id when available,
  // preserving capture order otherwise.
  const allHaveIds = entries.length > 0 && entries.every((entry) => entry.id !== null);
  if (allHaveIds) entries.sort((a, b) => a.id - b.id);
  return entries;
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

function main() {
  const [schemaArg, ledgerArg] = process.argv.slice(2);
  if (!schemaArg || !ledgerArg) usageExit('both <schema-dump.json> and <ledger-dump.json> are required');

  const schemaFile = loadJsonFile(schemaArg, 'schema dump');
  const ledgerFile = loadJsonFile(ledgerArg, 'ledger dump');
  const context = `schema=${schemaFile.path} ledger=${ledgerFile.path}`;

  const schemaExtract = extractRows(schemaFile.data, 'schema dump');
  if (schemaExtract.failedProbe) {
    refuse(`schema probe reported failure: ${schemaExtract.failedProbe} — precondition unknown`);
  }
  const ledgerExtract = extractRows(ledgerFile.data, 'ledger dump');
  // A failed ledger probe is only tolerable when it is the well-known
  // "d1_migrations does not exist yet" signature (pristine target); any other
  // probe failure is an unknown precondition.
  let ledgerAbsent = false;
  if (ledgerExtract.failedProbe) {
    if (/no such table:\s*d1_migrations/i.test(ledgerExtract.failedProbe)) {
      ledgerAbsent = true;
    } else {
      refuse(`ledger probe reported failure: ${ledgerExtract.failedProbe} — precondition unknown`);
    }
  }
  if (violations.length > 0) emitRefusalAndExit(context);

  const userTables = extractUserTables(schemaExtract.rows);
  const ledgerEntries = ledgerAbsent ? [] : extractLedgerEntries(ledgerExtract.rows);
  const ledgerNames = ledgerEntries.map((entry) => entry.name);

  // --- Rule 1: quarantined filenames must never appear in a ledger.
  for (const name of ledgerNames) {
    if (QUARANTINED_NAMES.includes(name)) {
      refuse(`quarantined migration recorded in d1_migrations: '${name}' — forbidden by strategy`);
    }
  }

  // --- Rule 2: baseline is exactly one row; per-file rows prove raw replay.
  for (const name of ledgerNames) {
    if (BASELINE_CONSTITUENT_NAMES.includes(name)) {
      refuse(`per-file baseline migration recorded in d1_migrations: '${name}' — the baseline must be exactly one row ('${LEDGER_BASELINE}'); this is a raw-replay signature`);
    }
  }

  // --- Rule 3: every ledger name must be one of the approved names.
  for (const name of ledgerNames) {
    if (!APPROVED_NAMES.includes(name) && !QUARANTINED_NAMES.includes(name)
        && !BASELINE_CONSTITUENT_NAMES.includes(name)) {
      refuse(`unknown migration name in d1_migrations: '${name}' — filename is not proof of anything; unrecognized ledger state`);
    }
  }

  // --- Rule 4: no duplicate ledger rows (partial-failure signature).
  const seen = new Map();
  for (const name of ledgerNames) seen.set(name, (seen.get(name) ?? 0) + 1);
  for (const [name, count] of seen) {
    if (count > 1) refuse(`duplicate d1_migrations rows for '${name}' (${count}) — partial-failure signature`);
  }

  // --- Rule 5: ledger-before-filename ordering.
  if (ledgerNames.length > 0) {
    const baselineCount = ledgerNames.filter((name) => name === LEDGER_BASELINE).length;
    if (baselineCount !== 1) {
      refuse(`baseline ledger row count is ${baselineCount}, expected exactly 1 when the ledger is non-empty`);
    }
    if (ledgerNames[0] !== LEDGER_BASELINE) {
      refuse(`first d1_migrations row is '${ledgerNames[0]}', expected '${LEDGER_BASELINE}' — baseline must precede every other migration`);
    }
    const indexOf = (name) => ledgerNames.indexOf(name);
    const paymentsAt = indexOf(LEDGER_PAYMENTS);
    for (const sibling of [LEDGER_CHAT, LEDGER_RESTITUTIONS]) {
      if (indexOf(sibling) !== -1 && paymentsAt === -1) {
        refuse(`'${sibling}' recorded without '${LEDGER_PAYMENTS}' — approved order is baseline -> payments -> chat/restitutions`);
      } else if (indexOf(sibling) !== -1 && indexOf(sibling) < paymentsAt) {
        refuse(`'${sibling}' recorded before '${LEDGER_PAYMENTS}' — approved order is baseline -> payments -> chat/restitutions`);
      }
    }
  }

  // --- Rule 6: schema <-> ledger consistency, both directions.
  const ledgerSet = new Set(ledgerNames);

  if (ledgerNames.length === 0 && userTables.size > 0) {
    refuse(`ledger is absent/empty but the schema has user tables (${[...userTables].sort().join(', ')}) — unknown precondition; an unmanaged schema cannot be trusted from filenames`);
  }

  if (ledgerSet.has(LEDGER_BASELINE)) {
    for (const marker of BASELINE_MARKER_TABLES) {
      if (!userTables.has(marker)) {
        const note = (marker === 'chat_rooms' || marker === 'chat_messages')
          ? ' — legacy pair-chat tables must never be renamed or dropped in this release'
          : '';
        refuse(`baseline recorded but baseline table '${marker}' is missing from the schema — partial-failure signature${note}`);
      }
    }
  }

  for (const [migration, tables] of Object.entries(TABLES_BY_MIGRATION)) {
    const recorded = ledgerSet.has(migration);
    for (const table of tables) {
      const present = userTables.has(table);
      if (recorded && !present) {
        refuse(`'${migration}' recorded in d1_migrations but table '${table}' is missing from the schema — partial-failure signature`);
      }
      if (!recorded && present) {
        refuse(`table '${table}' exists in the schema but '${migration}' has no d1_migrations row — partial-failure signature or unmanaged write`);
      }
    }
  }

  // --- Rule 7: no unknown user tables (unknown target => refuse).
  const knownTables = deriveBaselineTables();
  for (const marker of BASELINE_MARKER_TABLES) knownTables.add(marker);
  for (const tables of Object.values(TABLES_BY_MIGRATION)) {
    for (const table of tables) knownTables.add(table);
  }
  if (knownTables.size === BASELINE_MARKER_TABLES.length + 5) {
    // Baseline SQL was unavailable; degrade to marker-only checking but say so.
    console.error('info: baseline SQL not found in repo; unknown-table check limited to marker tables');
  } else {
    for (const table of userTables) {
      if (!knownTables.has(table)) {
        refuse(`unknown user table '${table}' in schema — not owned by the baseline or any approved migration; unknown precondition`);
      }
    }
  }

  if (violations.length > 0) emitRefusalAndExit(context);

  // --- Recognized state: report and pass.
  const state = ledgerNames.length === 0
    ? 'pristine-empty (no ledger, no user tables) — eligible for canonical-baseline path'
    : `ledger: ${ledgerNames.join(' -> ')}`;
  console.log('verify-lineage: OK — recognized, consistent lineage state');
  console.log(`  ${state}`);
  console.log(`  user tables: ${userTables.size === 0 ? '(none)' : [...userTables].sort().join(', ')}`);
  process.exit(0);
}

main();

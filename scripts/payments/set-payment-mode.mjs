#!/usr/bin/env node
/**
 * T-033 — Audited payment environment-mode / kill-switch operator toggle.
 *
 * Run ONLY by the named human release owner (contracts/tirak-payments-v1
 * environment-matrix.json: "production mode changes require an audited human
 * release owner action without code deployment"). This script is the single
 * sanctioned path that changes the effective payment mode at runtime: it
 * writes the PAYMENT_MODE_OVERRIDE key in the PAYMENT_CONFIG_KV namespace and
 * appends an immutable PAYMENT_MODE_AUDIT:<ISO8601> entry recording operator,
 * reason, previous/next state, and a stale-attempt ownership snapshot proving
 * in-flight attempts stay owned across a disable.
 *
 * Hard rules:
 * - --operator must be exactly "human release owner".
 * - --reason is always required and is persisted in the audit entry.
 * - --mode live is refused outside the production environment.
 * - CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must come from the process
 *   environment; they are never accepted as flags, never echoed, never logged.
 * - The deploy-time [vars] floor (PAYMENT_MODE=disabled, PROMPTPAY_ENABLED=
 *   false) is never modified by this script.
 *
 * Usage:
 *   node scripts/payments/set-payment-mode.mjs --env staging \
 *     --operator "human release owner" --reason "T-0xx enable test charges" \
 *     --mode test
 *   node scripts/payments/set-payment-mode.mjs --env production \
 *     --operator "human release owner" --reason "incident: close creation" \
 *     --promptpay false
 *   Add --dry-run to print the intended change and snapshot without writes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const OVERRIDE_KEY = 'PAYMENT_MODE_OVERRIDE';
export const AUDIT_KEY_PREFIX = 'PAYMENT_MODE_AUDIT:';
export const REQUIRED_OPERATOR = 'human release owner';
export const PAYMENT_MODES = ['disabled', 'test', 'live'];
export const ENVIRONMENTS = ['development', 'staging', 'production'];
const KV_BINDING = 'PAYMENT_CONFIG_KV';
const STALE_ATTEMPT_QUERY = "SELECT id, booking_id, status FROM payment_attempts WHERE status IN ('creating','indeterminate','pending') ORDER BY created_at";

export class ToggleError extends Error {}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (!flag.startsWith('--')) throw new ToggleError(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ToggleError(`missing value for ${flag}`);
    }
    index += 1;
    if (flag === '--env') args.env = value;
    else if (flag === '--operator') args.operator = value;
    else if (flag === '--reason') args.reason = value;
    else if (flag === '--mode') args.mode = value;
    else if (flag === '--promptpay') args.promptpay = value;
    else throw new ToggleError(`unknown flag: ${flag}`);
  }

  if (!ENVIRONMENTS.includes(args.env)) {
    throw new ToggleError(`--env must be one of ${ENVIRONMENTS.join(', ')}`);
  }
  if (args.operator !== REQUIRED_OPERATOR) {
    throw new ToggleError(`--operator must be exactly "${REQUIRED_OPERATOR}"`);
  }
  if (typeof args.reason !== 'string' || args.reason.trim().length < 8) {
    throw new ToggleError('--reason is required (at least 8 characters) and is persisted in the audit entry');
  }
  const hasMode = args.mode !== undefined;
  const hasPromptpay = args.promptpay !== undefined;
  if (hasMode === hasPromptpay) {
    throw new ToggleError('exactly one of --mode disabled|test|live or --promptpay true|false is required');
  }
  if (hasMode && !PAYMENT_MODES.includes(args.mode)) {
    throw new ToggleError(`--mode must be one of ${PAYMENT_MODES.join(', ')}`);
  }
  if (hasPromptpay && !['true', 'false'].includes(args.promptpay)) {
    throw new ToggleError('--promptpay must be true or false');
  }
  return args;
}

/** Extract a section body from wrangler.toml text (comment lines stripped). */
function sectionBody(configText, header) {
  const lines = configText.split('\n');
  const bodies = [];
  let active = false;
  let body = [];
  for (const line of lines) {
    const section = line.trim().match(/^\[\[?([^\]]+)\]?\]?$/);
    if (section) {
      if (active) bodies.push(body.join('\n'));
      active = section[1] === header;
      body = [];
      continue;
    }
    if (active && !line.trim().startsWith('#')) body.push(line);
  }
  if (active) bodies.push(body.join('\n'));
  return bodies;
}

function tomlValue(block, key) {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : undefined;
}

/**
 * Read the deploy-time static floor for an environment from wrangler.toml.
 * Development is the top-level default environment ([vars] / [[d1_databases]]);
 * staging and production read their [env.<name>.*] sections.
 */
export function staticFloor(configText, envName) {
  const varsHeader = envName === 'development' ? 'vars' : `env.${envName}.vars`;
  const d1Header = envName === 'development' ? 'd1_databases' : `env.${envName}.d1_databases`;
  const vars = sectionBody(configText, varsHeader)[0] ?? '';
  const database = sectionBody(configText, d1Header)[0] ?? '';
  const paymentMode = tomlValue(vars, 'PAYMENT_MODE');
  const promptPayRaw = tomlValue(vars, 'PROMPTPAY_ENABLED');
  const databaseName = tomlValue(database, 'database_name');
  if (!PAYMENT_MODES.includes(paymentMode)) {
    throw new ToggleError(`wrangler.toml static floor for ${envName} has no valid PAYMENT_MODE`);
  }
  if (!['true', 'false'].includes(String(promptPayRaw))) {
    throw new ToggleError(`wrangler.toml static floor for ${envName} has no valid PROMPTPAY_ENABLED`);
  }
  if (!databaseName) {
    throw new ToggleError(`wrangler.toml static floor for ${envName} has no D1 database_name`);
  }
  return { paymentMode, promptPayEnabled: promptPayRaw === 'true', databaseName };
}

function defaultExec(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function wranglerEnvArgs(envName) {
  // Development is the top-level default environment; wrangler targets it by
  // omitting --env. Named environments are passed through explicitly.
  return envName === 'development' ? [] : ['--env', envName];
}

function parseOverride(raw) {
  if (!raw || !String(raw).trim()) return { override: null, invalid: false };
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { override: null, invalid: true };
    }
    return { override: parsed, invalid: false };
  } catch {
    return { override: null, invalid: true };
  }
}

function parseSnapshot(stdout) {
  // `wrangler d1 execute --json` prints an array of per-statement results.
  const parsed = JSON.parse(String(stdout));
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  for (const block of blocks) {
    if (Array.isArray(block?.results)) return block.results;
  }
  return [];
}

/**
 * Execute the audited toggle. All side effects go through `deps.exec`
 * (default: wrangler via execFileSync) so tests can inject fakes without any
 * network, Cloudflare credential, or real KV/D1 access.
 *
 * deps: { exec, env, configText, configPath, now, stdout }
 */
export async function runSetPaymentMode(argv, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const processEnv = deps.env ?? process.env;
  const write = deps.stdout ?? ((line) => console.log(line));
  const now = deps.now ?? (() => new Date().toISOString());
  const configText = deps.configText
    ?? readFileSync(resolve(deps.configPath ?? 'wrangler.toml'), 'utf8');

  const args = parseArgs(argv);

  // Effective next mode must never be live outside production, regardless of
  // whether it comes from --mode or from the floor/existing override.
  const floor = staticFloor(configText, args.env);
  // A missing override key makes wrangler exit non-zero; treat read failure as
  // "no override" (previous state falls back to the static floor) and record
  // the read error in the audit entry instead of crashing the toggle.
  let currentRaw = '';
  let currentReadError = false;
  try {
    currentRaw = exec('wrangler', [
      'kv', 'key', 'get', OVERRIDE_KEY,
      '--binding', KV_BINDING,
      ...wranglerEnvArgs(args.env),
    ]).trim();
  } catch {
    currentReadError = true;
  }
  const { override: currentOverride, invalid: currentInvalid } = parseOverride(currentRaw);

  const nextMode = args.mode ?? currentOverride?.paymentMode ?? floor.paymentMode;
  const nextPromptPay = args.promptpay !== undefined
    ? args.promptpay === 'true'
    : (typeof currentOverride?.promptPayEnabled === 'boolean'
      ? currentOverride.promptPayEnabled
      : floor.promptPayEnabled);
  if (nextMode === 'live' && args.env !== 'production') {
    throw new ToggleError('refusing to enable live payment mode outside the production environment');
  }

  const accountId = processEnv.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = processEnv.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new ToggleError('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be present in the process environment (never passed as flags)');
  }

  const previousMode = currentOverride?.paymentMode ?? floor.paymentMode;
  const previousPromptPay = typeof currentOverride?.promptPayEnabled === 'boolean'
    ? currentOverride.promptPayEnabled
    : floor.promptPayEnabled;

  // Stale-attempt ownership snapshot: in-flight attempts keep their ids and
  // statuses across a disable; webhook/status/recover stay available for them.
  let snapshot;
  try {
    const snapshotRaw = exec('wrangler', [
      'd1', 'execute', floor.databaseName,
      ...wranglerEnvArgs(args.env),
      '--remote', '--json',
      '--command', STALE_ATTEMPT_QUERY,
    ]);
    snapshot = parseSnapshot(snapshotRaw).map((row) => ({
      id: row?.id,
      booking_id: row?.booking_id,
      status: row?.status,
    }));
  } catch (error) {
    throw new ToggleError(`stale-attempt ownership snapshot failed; refusing to toggle without proof of in-flight ownership (${error.message})`);
  }

  const approvedAt = now();
  const nextOverride = {
    ...(args.mode ? { paymentMode: args.mode } : (currentOverride?.paymentMode ? { paymentMode: currentOverride.paymentMode } : {})),
    promptPayEnabled: nextPromptPay,
    operator: REQUIRED_OPERATOR,
    reason: args.reason.trim(),
    approvedAt,
    previousMode,
    previousPromptPayEnabled: previousPromptPay,
  };
  const auditEntry = {
    contractVersion: 'tirak-payments-v1',
    environment: args.env,
    operator: REQUIRED_OPERATOR,
    reason: args.reason.trim(),
    approvedAt,
    previous: {
      paymentMode: previousMode,
      promptPayEnabled: previousPromptPay,
      source: currentOverride ? 'override' : 'static-floor',
      existingOverrideInvalid: currentInvalid,
      existingOverrideReadError: currentReadError,
    },
    next: {
      paymentMode: nextOverride.paymentMode ?? null,
      promptPayEnabled: nextOverride.promptPayEnabled,
      effectiveMode: nextMode,
    },
    inFlightAttempts: snapshot,
  };
  const auditKey = `${AUDIT_KEY_PREFIX}${approvedAt}`;

  const summary = {
    environment: args.env,
    operator: REQUIRED_OPERATOR,
    reason: args.reason.trim(),
    previous: auditEntry.previous,
    next: auditEntry.next,
    inFlightAttemptCount: snapshot.length,
    auditKey,
    dryRun: args.dryRun,
  };

  if (args.dryRun) {
    write(JSON.stringify({ ...summary, status: 'DRY_RUN_NO_WRITES', intendedOverride: nextOverride, snapshot }, null, 2));
    return summary;
  }

  exec('wrangler', [
    'kv', 'key', 'put', OVERRIDE_KEY, JSON.stringify(nextOverride),
    '--binding', KV_BINDING,
    ...wranglerEnvArgs(args.env),
  ]);
  exec('wrangler', [
    'kv', 'key', 'put', auditKey, JSON.stringify(auditEntry),
    '--binding', KV_BINDING,
    ...wranglerEnvArgs(args.env),
  ]);

  write(JSON.stringify({ ...summary, status: 'APPLIED' }, null, 2));
  return summary;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runSetPaymentMode(process.argv.slice(2)).catch((error) => {
    // Sanitized failure: never echo environment credentials or key values.
    console.error(`set-payment-mode: FAIL — ${error.message}`);
    process.exitCode = 1;
  });
}

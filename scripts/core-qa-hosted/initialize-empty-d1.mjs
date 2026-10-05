import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { generateFreshSchema } from '../core-qa/fresh-schema.mjs';
import { HOSTED_RUNTIME } from './constants.mjs';
import { loadPinnedHostedConfig, loadWranglerOAuthToken, createCallBudget, createCloudflareResourceAdapters } from './adapter.mjs';

// One-time initializer admitted only for the explicitly new, empty Core QA D1.
// Never runs migrations apply and cannot initialize a retained database.
async function main() {
  if (process.argv[2] !== '--execute') throw new Error('Explicit --execute is required for the approved new QA database.');
  const repoRoot = process.cwd();
  const pins = await loadPinnedHostedConfig(repoRoot);
  const proof = JSON.parse(await readFile('scripts/core-qa/generated/core-qa-local-proof.json', 'utf8'));
  if (!proof.ok || proof.verificationState !== 'verified' || !proof.assertions?.allRequiredCoverageCompleted
      || proof.websocket?.ticketOnlyUpgrade !== 101 || proof.websocket?.replayDenied !== 401
      || !proof.websocket?.broadcastReceived || proof.sanitized?.foreignKeyViolations !== 0) {
    throw new Error('Strict actual local runtime proof is required before hosted initialization.');
  }
  const oauth = await loadWranglerOAuthToken();
  const adapters = createCloudflareResourceAdapters({ token: oauth.token, callBudget: createCallBudget({ maxCalls: 8 }) });
  const tables = await adapters.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  if (!tables.success || tables.results.length) throw new Error('Pinned new QA D1 is not empty; refuse initialization.');
  const schema = await generateFreshSchema({ repoRoot });
  const approvedSql = schema.sql.replace('-- Local-only guard: no remote or retained database usage is permitted',
    `-- Approved fresh initialization ONLY: ${HOSTED_RUNTIME.d1DatabaseId}; never retained or non-empty D1`);
  const outputDir = path.join(repoRoot, 'scripts/core-qa-hosted/generated');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const sqlPath = path.join(outputDir, 'approved-empty-core-qa-schema.sql');
  await writeFile(sqlPath, approvedSql, { mode: 0o600 });
  const stdout = execFileSync(path.join(repoRoot, 'node_modules/.bin/wrangler'), [
    'd1', 'execute', HOSTED_RUNTIME.d1DatabaseName, '--profile', 'tirak', '--config', HOSTED_RUNTIME.wranglerConfigPath,
    '--remote', '--file', sqlPath, '--yes', '--json',
  ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = JSON.parse(stdout);
  if (!Array.isArray(cli) || !cli.length || cli.some(entry => entry.success !== true)) throw new Error('QA schema import did not confirm success.');
  const integrity = await adapters.db.prepare('PRAGMA foreign_key_check').all();
  const after = await adapters.db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").first();
  if (!integrity.success || integrity.results.length || Number(after?.total || 0) < 20) throw new Error('New QA schema integrity verification failed.');
  const receipt = {
    ok: true, initializedAt: new Date().toISOString(), pins,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    beforeTableCount: 0, afterTableCount: Number(after.total), foreignKeyViolations: 0,
    localSchemaSha256: schema.combinedSha256,
    approvedImportSha256: createHash('sha256').update(approvedSql).digest('hex'),
    selectedInputs: schema.manifest, paymentMigrationsExcluded: ['008', '011', '014'],
  };
  await writeFile(path.join(outputDir, 'initialization-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: receipt.ok, databaseId: pins.d1DatabaseId, tables: receipt.afterTableCount, foreignKeyViolations: 0 }));
}
main().catch(error => { console.error(error?.message || 'QA initialization failed'); process.exitCode = 1; });

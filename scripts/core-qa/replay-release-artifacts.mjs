import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applySchema, makeRuntime } from './run-local-runtime.mjs';
import { generateFreshSchema } from './fresh-schema.mjs';

const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const flag = args.shift();
  if (!['--candidate', '--rollback', '--out'].includes(flag) || !args[0] || args[0].startsWith('--')) {
    throw new Error('usage: replay-release-artifacts.mjs --candidate MODULE --rollback MODULE --out NEW_PRIVATE_DIRECTORY');
  }
  options[flag.slice(2)] = path.resolve(args.shift());
}
assert(options.candidate && options.rollback && options.out, 'candidate, rollback and private output paths are required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleHashes = Object.fromEntries(await Promise.all(['candidate', 'rollback'].map(async label => [label, hash(await readFile(options[label]))])));
await mkdir(options.out, { mode: 0o700 }); // Refuse to replace prior evidence/state.
const schema = await generateFreshSchema({ repoRoot: process.cwd(), outputPath: path.join(options.out, 'disposable-schema.sql') });
const proof = { mode: 'local-disposable-exact-modules', startedAt: new Date().toISOString(), ok: false, moduleHashes, schemaSha256: schema.combinedSha256, rounds: [], externalMutations: 0, limitations: ['Synthetic JWT secret and disposable D1/KV/R2/DO; no live secret, account, provider send or production rollback.', 'Receipt replay covers new Core interest/application receipts; historical attributed replay remains covered by the existing SQLite suite.'] };
const origins = ['https://tirak.app', 'https://www.tirak.app', 'https://admin.tirak.app', 'https://app.tirak.app'];
try {
  for (const first of ['rollback', 'candidate']) {
    const second = first === 'candidate' ? 'rollback' : 'candidate';
    const stateRoot = path.join(options.out, `${first}-first`);
    await mkdir(stateRoot, { mode: 0o700 });
    const jwt = hash(randomUUID());
    const cases = [
      { route: '/api/interest', key: randomUUID(), payload: { email: `interest-${first}@replay.example.invalid` } },
      { route: '/api/supplier-onboarding', key: randomUUID(), payload: { businessName: 'Disposable Replay Guide', contactName: 'Synthetic Guide', email: `guide-${first}@replay.example.invalid`, phone: '+66957890123', location: 'Bangkok', brochureUrls: [], categories: [{ name: 'Walks', memberCount: 1 }], mode: 'tirak', applicationData: {} } },
    ];
    const round = { first, second, steps: [] };
    proof.rounds.push(round);
    for (const [index, label] of [first, second, first].entries()) {
      const runtime = await makeRuntime(options[label], stateRoot, jwt, { bindings: { ENVIRONMENT: 'production', CORE_QA_MODE: '', FRONTEND_URLS: origins.join(','), EMAIL_PROVIDER: 'disabled', SUPPORT_NOTIFICATIONS_ENABLED: 'false' } });
      try {
        await runtime.ready;
        const db = await runtime.getD1Database('DB');
        if (index === 0) await applySchema(db, schema.sql);
        for (const origin of origins) {
          const preflight = await runtime.dispatchFetch('https://local.test/api/supplier-onboarding', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,idempotency-key' } });
          assert.equal(preflight.status, 204);
          assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
        }
        const denied = await runtime.dispatchFetch('https://local.test/api/supplier-onboarding', { method: 'OPTIONS', headers: { Origin: 'https://unrelated.example.invalid', 'Access-Control-Request-Method': 'POST' } });
        assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
        for (const entry of cases) {
          const send = body => runtime.dispatchFetch(`https://local.test${entry.route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': entry.key }, body: JSON.stringify(body) });
          const response = await send(entry.payload);
          assert.equal(response.status, 201, `${label} ${entry.route} receipt`);
          const body = await response.json();
          assert.equal(body.success, true);
          if (index === 0) entry.receipt = body.data;
          else assert.deepEqual(body.data, entry.receipt, 'original reference and private status capability must survive replay');
          const conflict = await send({ ...entry.payload, email: 'changed@replay.example.invalid' });
          assert.equal(conflict.status, 409);
          round.steps.push({ module: label, route: entry.route, originalReceiptPreserved: true, changedPayloadStatus: conflict.status });
        }
        const conversions = await db.prepare('SELECT COUNT(*) AS n FROM core_acquisition_conversions').first();
        assert.equal(conversions.n, 0);
        const interests = await db.prepare('SELECT COUNT(*) AS n FROM interest_entries').first();
        const applications = await db.prepare('SELECT COUNT(*) AS n FROM supplier_onboarding_applications').first();
        assert.equal(interests.n, 1);
        assert.equal(applications.n, 1);
      } finally {
        await runtime.dispose();
      }
    }
  }
  proof.ok = true;
} catch (error) {
  proof.error = { name: error.name, message: error.message };
  throw error;
} finally {
  proof.completedAt = new Date().toISOString();
  await writeFile(path.join(options.out, 'replay-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: proof.ok, mode: proof.mode, moduleHashes, rounds: proof.rounds.length, externalMutations: 0 }));
}

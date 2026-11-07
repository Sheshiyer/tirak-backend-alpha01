import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfiguration, digest, prepareRetainedCore, validateRetainedCore } from '../../scripts/prepare-retained-core-release.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { experimental_readRawConfig } = require('wrangler');

function fixture() {
  const config = defaultConfiguration(experimental_readRawConfig({ config: resolve(root, 'wrangler.toml') }).rawConfig);
  // Provider-shaped observation, including fields not present in source TOML.
  const bindings = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    { name: 'DB', type: 'd1', database_id: config.d1_databases[0].database_id, id: config.d1_databases[0].database_id },
    { name: 'STORAGE', type: 'r2_bucket', bucket_name: config.r2_buckets[0].bucket_name },
    ...config.kv_namespaces.map(b => ({ name: b.binding, type: 'kv_namespace', namespace_id: b.id })),
    ...config.queues.producers.map(b => ({ name: b.binding, type: 'queue', queue_name: b.queue })),
    ...config.durable_objects.bindings.map(b => ({ name: b.name, type: 'durable_object_namespace', class_name: b.class_name, namespace_id: `synthetic-${b.name}` })),
    { name: 'EMAIL', type: 'send_email', allowed_sender_addresses: ['noreply@tirak.app'] },
    { name: 'JWT_SECRET', type: 'secret_text' }, { name: 'RESEND_API_KEY', type: 'secret_text' },
  ].sort((a, b) => a.name.localeCompare(b.name));
  const contract = {
    schema: 'tirak.retained-core-preparation.v1', expectedDefaultConfiguration: structuredClone(config),
    expectedLiveBindingsSha256: digest(bindings),
    live: { worker: 'tirak-backend', versionId: 'synthetic-v115', observedAt: '2026-11-07T00:00:00Z', bindings, moduleSha256: 'a'.repeat(64), crons: ['*/5 * * * *'], runtime: { compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, usage_model: 'standard', migration_tag: 'v1' } },
    triggerDisposition: 'preserve-existing-disabled-held',
    schemaPrerequisites: { bookingRoomBookingIdNotNullUnique: true, duplicateBookingIds: 0, appliedMigrations: ['027', '028', '029', '030'] },
  };
  return { config, contract };
}

describe('retained Core preparation boundary', () => {
  it.each([
    ['Worker', text => text.replace('name = "tirak-backend"', 'name = "tirak-backend-production"')],
    ['database', text => text.replace('database_name = "tirak-development"', 'database_name = "tirak-mobile-production"')],
  ])('rejects the wrong %s before invoking tools or writing an artifact', (_label, change) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tirak-retained-negative-'));
    const configPath = resolve(dir, 'wrong.toml');
    const contractPath = resolve(dir, 'private.json');
    const outputDir = resolve(dir, 'artifact');
    writeFileSync(configPath, change(readFileSync(resolve(root, 'wrangler.toml'), 'utf8')));
    writeFileSync(contractPath, JSON.stringify(fixture().contract), { mode: 0o600 });
    const run = vi.fn();
    expect(() => prepareRetainedCore({ configPath, contractPath, outputDir, build: true, run })).toThrow(/mismatch/);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(outputDir)).toBe(false);
  });

  it('accepts the complete retained binding observation while keeping promotion held', () => {
    const { config, contract } = fixture();
    expect(validateRetainedCore(config, contract)).toMatchObject({ status: 'PREPARED_HELD', bindingCount: 23, releaseReady: false, externalMutations: 0, observedCronCount: 1, candidateCrons: [] });
  });

  it('rejects a wrong resource identity even when the supplied live digest was recomputed', () => {
    const { config, contract } = fixture();
    contract.live.bindings.find(b => b.name === 'STORAGE').bucket_name = 'another-product-bucket';
    contract.expectedLiveBindingsSha256 = digest(contract.live.bindings);
    expect(() => validateRetainedCore(config, contract)).toThrow('binding mismatch: STORAGE');
  });

  it('rejects an extra binding and disabled-control drift instead of accepting a partial match', () => {
    const { config, contract } = fixture();
    contract.live.bindings.push({ name: 'UNREVIEWED', type: 'secret_text' });
    contract.expectedLiveBindingsSha256 = digest([...contract.live.bindings].sort((a, b) => a.name.localeCompare(b.name)));
    expect(() => validateRetainedCore(config, contract)).toThrow('complete binding set mismatch');
    const other = fixture();
    other.config.vars.PAYMENT_MODE = 'enabled';
    other.contract.expectedDefaultConfiguration = structuredClone(other.config);
    expect(() => validateRetainedCore(other.config, other.contract)).toThrow('held runtime control mismatch');
  });

  it('refuses changed schedules and unproven schema prerequisites without changing them', () => {
    const first = fixture();
    first.contract.live.crons = [];
    expect(() => validateRetainedCore(first.config, first.contract)).toThrow('retained schedule observation changed');
    const second = fixture();
    second.contract.schemaPrerequisites.bookingRoomBookingIdNotNullUnique = false;
    expect(() => validateRetainedCore(second.config, second.contract)).toThrow('schema prerequisite evidence required');
  });
});

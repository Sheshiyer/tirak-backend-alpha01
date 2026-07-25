import { describe, expect, it } from 'vitest';
import {
  AUDIT_KEY_PREFIX,
  OVERRIDE_KEY,
  parseArgs,
  runSetPaymentMode,
  staticFloor,
} from '../../scripts/payments/set-payment-mode.mjs';

const CONFIG_FIXTURE = `
account_id = "2c0c96c68f0ee73b6d980054557bca5b"

[[d1_databases]]
binding = "DB"
database_name = "tirak-development"
database_id = "60443346-c480-4975-962e-bd4daf4a37a8"

[vars]
ENVIRONMENT = "development"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"

[env.staging]
name = "tirak-backend-staging"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "tirak-staging"
database_id = "5132c8cc-8f23-4dd2-94d1-9d53edb92888"

[env.staging.vars]
ENVIRONMENT = "staging"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"

[env.production]
name = "tirak-backend-production"

[[env.production.d1_databases]]
binding = "DB"
database_name = "tirak-mobile-production"
database_id = "e17982a4-d4e0-47ae-bc24-3c88c4003a4c"

[env.production.vars]
ENVIRONMENT = "production"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"
`;

const TEST_CREDENTIALS = {
  CLOUDFLARE_ACCOUNT_ID: 'test-account-id-0000000000000000',
  CLOUDFLARE_API_TOKEN: 'test-api-token-SECRET-sentinel',
};

const SNAPSHOT_ROWS = [
  { id: 'attempt-1', booking_id: 'booking-1', status: 'pending' },
  { id: 'attempt-2', booking_id: 'booking-2', status: 'indeterminate' },
];

interface ExecCall { command: string; args: string[] }

function makeDeps(overrides: {
  kvGet?: string;
  kvGetThrows?: boolean;
  snapshotFails?: boolean;
  env?: Record<string, string>;
} = {}) {
  const calls: ExecCall[] = [];
  const output: string[] = [];
  const exec = (command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'kv' && args[2] === 'get') {
      if (overrides.kvGetThrows) throw new Error('key not found');
      return overrides.kvGet ?? '';
    }
    if (args[0] === 'd1') {
      if (overrides.snapshotFails) throw new Error('d1 auth refused');
      return JSON.stringify([{ results: SNAPSHOT_ROWS, success: true }]);
    }
    return '';
  };
  return {
    calls,
    output,
    deps: {
      exec,
      env: overrides.env ?? { ...TEST_CREDENTIALS },
      configText: CONFIG_FIXTURE,
      now: () => '2026-07-24T12:00:00.000Z',
      stdout: (line: string) => output.push(line),
    },
  };
}

const baseArgv = (extra: string[]) => [
  '--env', 'staging',
  '--operator', 'human release owner',
  '--reason', 'T-033 rehearse audited toggle',
  ...extra,
];

describe('T-033 set-payment-mode operator toggle', () => {
  it('parses the static floor per environment from wrangler.toml text', () => {
    expect(staticFloor(CONFIG_FIXTURE, 'development')).toEqual({
      paymentMode: 'disabled',
      promptPayEnabled: false,
      databaseName: 'tirak-development',
    });
    expect(staticFloor(CONFIG_FIXTURE, 'staging').databaseName).toBe('tirak-staging');
    expect(staticFloor(CONFIG_FIXTURE, 'production').databaseName).toBe('tirak-mobile-production');
  });

  it('enforces the exact "human release owner" operator string', () => {
    expect(() => parseArgs(baseArgv(['--mode', 'test']).map((arg) => (arg === 'human release owner' ? 'deploy bot' : arg))))
      .toThrow('human release owner');
    expect(() => parseArgs(baseArgv(['--mode', 'test']))).not.toThrow();
  });

  it('requires a reason and exactly one of --mode or --promptpay', () => {
    expect(() => parseArgs([
      '--env', 'staging', '--operator', 'human release owner', '--mode', 'test',
    ])).toThrow('--reason');
    expect(() => parseArgs(baseArgv([]))).toThrow('exactly one');
    expect(() => parseArgs(baseArgv(['--mode', 'test', '--promptpay', 'false']))).toThrow('exactly one');
    expect(() => parseArgs(baseArgv(['--mode', 'sandbox']))).toThrow('--mode');
    expect(() => parseArgs(baseArgv(['--promptpay', 'maybe']))).toThrow('--promptpay');
  });

  it('refuses live mode outside production before any credential or network use', async () => {
    const { calls, deps } = makeDeps();
    await expect(runSetPaymentMode([
      '--env', 'staging', '--operator', 'human release owner',
      '--reason', 'attempt live outside production', '--mode', 'live',
    ], deps)).rejects.toThrow('live payment mode outside the production environment');
    expect(calls.filter((call) => call.args.includes('put'))).toHaveLength(0);
  });

  it('refuses to run without CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from the environment', async () => {
    const { deps } = makeDeps({ env: {} });
    await expect(runSetPaymentMode(baseArgv(['--mode', 'test']), deps))
      .rejects.toThrow('CLOUDFLARE_ACCOUNT_ID');
  });

  it('dry-run prints the intended change and snapshot but writes nothing', async () => {
    const { calls, output, deps } = makeDeps();
    const summary = await runSetPaymentMode(baseArgv(['--mode', 'test', '--dry-run']), deps);

    expect(calls.some((call) => call.args.includes('put'))).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(summary.inFlightAttemptCount).toBe(2);
    const printed = output.join('\n');
    expect(printed).toContain('DRY_RUN_NO_WRITES');
    expect(printed).toContain('attempt-1');
  });

  it('writes the override and an audit entry with previous/next and the stale-attempt snapshot', async () => {
    const { calls, deps } = makeDeps();
    await runSetPaymentMode(baseArgv(['--mode', 'test']), deps);

    const puts = calls.filter((call) => call.args[0] === 'kv' && call.args[2] === 'put');
    expect(puts).toHaveLength(2);

    const overridePut = puts.find((call) => call.args[3] === OVERRIDE_KEY);
    expect(overridePut).toBeDefined();
    const overrideValue = JSON.parse(overridePut!.args[4]);
    expect(overrideValue).toMatchObject({
      paymentMode: 'test',
      promptPayEnabled: false,
      operator: 'human release owner',
      reason: 'T-033 rehearse audited toggle',
      approvedAt: '2026-07-24T12:00:00.000Z',
      previousMode: 'disabled',
      previousPromptPayEnabled: false,
    });
    expect(overridePut!.args).toContain('--env');
    expect(overridePut!.args).toContain('staging');

    const auditPut = puts.find((call) => call.args[3].startsWith(AUDIT_KEY_PREFIX));
    expect(auditPut).toBeDefined();
    expect(auditPut!.args[3]).toBe(`${AUDIT_KEY_PREFIX}2026-07-24T12:00:00.000Z`);
    const auditValue = JSON.parse(auditPut!.args[4]);
    expect(auditValue).toMatchObject({
      environment: 'staging',
      operator: 'human release owner',
      reason: 'T-033 rehearse audited toggle',
      previous: { paymentMode: 'disabled', promptPayEnabled: false, source: 'static-floor' },
      next: { paymentMode: 'test', effectiveMode: 'test' },
    });
    expect(auditValue.inFlightAttempts).toEqual(SNAPSHOT_ROWS);
  });

  it('records the previous override as previous state when one exists', async () => {
    const existing = JSON.stringify({
      paymentMode: 'test',
      promptPayEnabled: true,
      operator: 'human release owner',
      reason: 'earlier enable',
      approvedAt: '2026-07-23T00:00:00.000Z',
      previousMode: 'disabled',
      previousPromptPayEnabled: false,
    });
    const { calls, deps } = makeDeps({ kvGet: existing });
    await runSetPaymentMode(baseArgv(['--promptpay', 'false']), deps);

    const puts = calls.filter((call) => call.args[0] === 'kv' && call.args[2] === 'put');
    const overrideValue = JSON.parse(puts.find((call) => call.args[3] === OVERRIDE_KEY)!.args[4]);
    expect(overrideValue).toMatchObject({
      paymentMode: 'test',
      promptPayEnabled: false,
      previousMode: 'test',
      previousPromptPayEnabled: true,
    });
    const auditValue = JSON.parse(puts.find((call) => call.args[3].startsWith(AUDIT_KEY_PREFIX))!.args[4]);
    expect(auditValue.previous).toMatchObject({ paymentMode: 'test', promptPayEnabled: true, source: 'override' });
  });

  it('queries in-flight attempts from the target D1 before writing', async () => {
    const { calls, deps } = makeDeps();
    await runSetPaymentMode(baseArgv(['--promptpay', 'false']), deps);

    const d1 = calls.find((call) => call.args[0] === 'd1');
    expect(d1).toBeDefined();
    expect(d1!.args).toContain('tirak-staging');
    expect(d1!.args.join(' ')).toContain("status IN ('creating','indeterminate','pending')");

    const putIndex = calls.findIndex((call) => call.args.includes('put'));
    const d1Index = calls.indexOf(d1!);
    expect(d1Index).toBeLessThan(putIndex);
  });

  it('aborts without writes when the stale-attempt snapshot cannot be proven', async () => {
    const { calls, deps } = makeDeps({ snapshotFails: true });
    await expect(runSetPaymentMode(baseArgv(['--promptpay', 'false']), deps))
      .rejects.toThrow('stale-attempt ownership snapshot failed');
    expect(calls.some((call) => call.args.includes('put'))).toBe(false);
  });

  it('allows live mode only in production and targets the default env without --env for development', async () => {
    const { calls, deps } = makeDeps();
    await runSetPaymentMode([
      '--env', 'production', '--operator', 'human release owner',
      '--reason', 'go live after T-072 approval', '--mode', 'live',
    ], deps);
    const overrideValue = JSON.parse(
      calls.filter((call) => call.args.includes('put'))
        .find((call) => call.args[3] === OVERRIDE_KEY)!.args[4],
    );
    expect(overrideValue.paymentMode).toBe('live');

    const dev = makeDeps();
    await runSetPaymentMode([
      '--env', 'development', '--operator', 'human release owner',
      '--reason', 'enable local test charges', '--mode', 'test',
    ], dev.deps);
    expect(dev.calls.every((call) => !call.args.includes('--env'))).toBe(true);
  });

  it('never prints the API token, account id, or override key values', async () => {
    const { output, deps } = makeDeps();
    await runSetPaymentMode(baseArgv(['--mode', 'test']), deps);
    const printed = output.join('\n');
    expect(printed).not.toContain(TEST_CREDENTIALS.CLOUDFLARE_API_TOKEN);
    expect(printed).not.toContain(TEST_CREDENTIALS.CLOUDFLARE_ACCOUNT_ID);

    const dry = makeDeps();
    await runSetPaymentMode(baseArgv(['--mode', 'test', '--dry-run']), dry.deps);
    const dryPrinted = dry.output.join('\n');
    expect(dryPrinted).not.toContain(TEST_CREDENTIALS.CLOUDFLARE_API_TOKEN);
    expect(dryPrinted).not.toContain(TEST_CREDENTIALS.CLOUDFLARE_ACCOUNT_ID);
  });
});

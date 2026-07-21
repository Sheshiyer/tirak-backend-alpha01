import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('backend release gate', () => {
  it('accepts confirmed staging identities while preserving placeholder refusal coverage', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-release-gate.mjs'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'PASS',
      placeholderStagingRefusal: 'PASS',
      productionTargetStaticValidation: 'PASS',
      externalCommandsExecuted: 0,
    });
  });
});

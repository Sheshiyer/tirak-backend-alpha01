import { describe, expect, it } from 'vitest';
import { loadMigrationChain } from './helpers/artifacts';
import { applySql, createDb, fullSchemaDump } from './helpers/sqlite';

/**
 * T-028 requirement (2): idempotency.
 *
 * The repair-lineage migrations (corrected 008, additive 010, restitutions
 * 011) must be safely re-appliable: applying them twice produces no error and
 * no schema change. This is what makes the ledger-checked repair/re-run path
 * safe on a recognized target.
 *
 * The generated canonical baseline is a special case: it is designed to be
 * applied exactly once on an empty target and recorded as a single
 * d1_migrations ledger row. The suite therefore proves the safety property
 * that matters operationally — replaying the baseline can never corrupt or
 * change the schema: a second application either succeeds as a no-op or fails
 * benignly ("already exists") leaving the schema untouched.
 */

function repairArtifacts() {
  const chain = loadMigrationChain();
  return {
    baseline: chain.find((a) => a.key === 'baseline')!,
    repairs: chain.filter((a) => a.key !== 'baseline'),
  };
}

describe('T-028 migration idempotency', () => {
  it('re-applying the repair migrations (008, 010, 011) over the baseline is a no-op', () => {
    const { baseline, repairs } = repairArtifacts();
    const db = createDb();

    applySql(db, baseline.sql, baseline.name);
    for (const artifact of repairs) {
      expect(() => applySql(db, artifact.sql, artifact.name), artifact.name).not.toThrow();
    }
    const firstPass = fullSchemaDump(db);

    for (const artifact of repairs) {
      expect(
        () => applySql(db, artifact.sql, `${artifact.name} (second pass)`),
        `${artifact.name} must be re-appliable`,
      ).not.toThrow();
    }
    expect(fullSchemaDump(db)).toEqual(firstPass);
  });

  it('each repair migration tolerates immediate replay on its own chain prefix', () => {
    const { baseline, repairs } = repairArtifacts();
    const db = createDb();
    applySql(db, baseline.sql, baseline.name);
    for (const artifact of repairs) {
      applySql(db, artifact.sql, artifact.name);
      const before = fullSchemaDump(db);
      expect(
        () => applySql(db, artifact.sql, `${artifact.name} (immediate replay)`),
        `${artifact.name} must be idempotent`,
      ).not.toThrow();
      expect(fullSchemaDump(db)).toEqual(before);
    }
    expect(repairs.map((a) => a.key)).toEqual(['payments', 'chat', 'restitutions']);
  });

  it('replaying the apply-once baseline never corrupts or changes the schema', () => {
    const { baseline } = repairArtifacts();
    const db = createDb();
    applySql(db, baseline.sql, baseline.name);
    const firstPass = fullSchemaDump(db);

    let replayError: Error | null = null;
    try {
      db.exec(baseline.sql);
    } catch (err) {
      replayError = err as Error;
    }
    // Either the baseline is fully idempotent (no error) or it fails benignly
    // with "already exists"; any other error is a defect.
    if (replayError) {
      expect(
        replayError.message,
        `baseline replay must fail benignly, got: ${replayError.message}`,
      ).toMatch(/already exists/i);
    }
    expect(fullSchemaDump(db)).toEqual(firstPass);
  });
});

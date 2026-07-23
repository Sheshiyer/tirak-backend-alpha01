import { describe, expect, it } from 'vitest';
import {
  loadArtifact,
  loadMigrationChain,
  quarantinedMigrations,
} from './helpers/artifacts';
import { stripSqlComments } from './helpers/sqlite';

/**
 * T-028 requirement (5): quarantine guard. The baseline is a generated
 * artifact that must exclude the quarantined migrations, and no artifact in
 * the release chain may reference them or destroy legacy chat tables
 * (migration-strategy.md forbidden patterns).
 */

const LEGACY_DESTRUCTION_PATTERNS = [
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`[]?chat_(rooms|messages)\b/i,
  /ALTER\s+TABLE\s+["'`[]?chat_(rooms|messages)\s+RENAME/i,
];

describe('T-028 quarantine guard', () => {
  // References are checked against executable SQL only (comments stripped):
  // an exclusion note in a header comment is documentation, not lineage.
  it('the baseline does not reference either quarantined migration', () => {
    const baseline = loadArtifact('baseline');
    const executableSql = stripSqlComments(baseline.sql);
    for (const quarantined of quarantinedMigrations) {
      expect(
        executableSql.includes(quarantined),
        `baseline must not reference quarantined ${quarantined}`,
      ).toBe(false);
    }
  });

  it('no artifact in the release chain references a quarantined migration', () => {
    for (const artifact of loadMigrationChain()) {
      const executableSql = stripSqlComments(artifact.sql);
      for (const quarantined of quarantinedMigrations) {
        expect(
          executableSql.includes(quarantined),
          `${artifact.name} must not reference quarantined ${quarantined}`,
        ).toBe(false);
      }
    }
  });

  it('no artifact renames or drops the legacy chat tables', () => {
    for (const artifact of loadMigrationChain()) {
      const executableSql = stripSqlComments(artifact.sql);
      for (const pattern of LEGACY_DESTRUCTION_PATTERNS) {
        expect(
          pattern.test(executableSql),
          `${artifact.name} must not rename/drop legacy chat tables (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it('the baseline contains the legacy chat tables themselves (they are not quarantined)', () => {
    const baseline = loadArtifact('baseline');
    expect(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?chat_rooms\b/i.test(baseline.sql)).toBe(
      true,
    );
    expect(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?chat_messages\b/i.test(baseline.sql),
    ).toBe(true);
  });
});

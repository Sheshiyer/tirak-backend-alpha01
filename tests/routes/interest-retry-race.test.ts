import { it, expect } from 'vitest';
import { Hono } from 'hono';
import { interestRoutes } from '@/routes/interest';
import { createTestEnv } from '@tests/setup';

it('returns the winning interest receipt after an identical concurrent insert loses uniqueness', async () => {
  const env = createTestEnv(); let reads = 0; let digest: unknown;
  env.DB = { prepare(sql: string) { return { bind(...values: unknown[]) {
    if (sql.includes('INSERT')) digest = values[5];
    return {
      first: async () => ++reads === 1 ? null : { id: 'winner', payload_digest: digest },
      run: async () => { throw new Error('UNIQUE constraint failed: interest_entries.idempotency_key_hash'); },
    };
  } }; } } as any;
  const app = new Hono(); app.route('/interest', interestRoutes as any);
  const response = await app.request('/interest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '123e4567-e89b-12d3-a456-426614174088' }, body: JSON.stringify({ email: 'race@example.invalid' }) }, env);
  expect(response.status).toBe(201);
  expect((await response.json() as any).data.interestId).toBe('winner');
  expect(reads).toBe(2);
});

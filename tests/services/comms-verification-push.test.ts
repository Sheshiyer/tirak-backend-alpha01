import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { commsDatabase } from '../helpers/comms-sqlite';
import { requestEmailVerification, verifyEmailCode } from '@/services/email-verification';
import { sendExpoPushNotification } from '@/background/notifications';
import { createTestEnv } from '../setup';

describe('verification and Expo provider contracts', () => {
  let harness: ReturnType<typeof commsDatabase>;
  let env: any;
  beforeEach(() => {
    harness = commsDatabase(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER DEFAULT 0, updated_at TEXT);
      INSERT INTO users(id,email) VALUES ('owner','owner@example.test');
      CREATE TABLE email_verification_challenges (user_id TEXT PRIMARY KEY,email TEXT,code_hash TEXT,issued_at INTEGER,expires_at INTEGER,attempts INTEGER,delivery_status TEXT);
      CREATE TABLE user_devices (id TEXT PRIMARY KEY,user_id TEXT,push_tokens TEXT);`);
    env = { ...createTestEnv(), DB: harness.db, EMAIL_PROVIDER: 'cloudflare', EMAIL_FROM: 'noreply@tirak.app', EMAIL: { send: vi.fn().mockResolvedValue({ messageId: 'provider-id' }) } };
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { harness.sqlite.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('preserves verification failure, cooldown, success, and one-use code state', async () => {
    const user = { id: 'owner', email: 'owner@example.test' };
    env.EMAIL.send.mockRejectedValueOnce({ code: 'E_RECIPIENT_SUPPRESSED', message: 'private' });
    const now = Date.now();
    expect(await requestEmailVerification(env, user, now)).toMatchObject({ deliveryStatus: 'unavailable', retryAfterSeconds: 60 });
    expect(await requestEmailVerification(env, user, now + 1000)).toMatchObject({ deliveryStatus: 'unavailable', retryAfterSeconds: 59 });
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    const failedCode = env.EMAIL.send.mock.calls[0][0].html.match(/code is (\d{6})/)[1];
    expect(await verifyEmailCode(env, user, failedCode, now + 2000)).toBe(false);
    expect(await requestEmailVerification(env, user, now + 61000)).toMatchObject({ deliveryStatus: 'sent' });
    const code = env.EMAIL.send.mock.calls[1][0].html.match(/code is (\d{6})/)[1];
    expect(await verifyEmailCode(env, user, code, now + 62000)).toBe(true);
    expect(await verifyEmailCode(env, user, code, now + 63000)).toBe(false);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/owner@example|private|code is/);
  });
  it('keeps timeout delivery unknown while a received pending code can verify once', async () => {
    vi.useFakeTimers();
    const user = { id: 'owner', email: 'owner@example.test' };
    env.EMAIL.send.mockImplementation(() => new Promise(() => {}));
    const pending = requestEmailVerification(env, user);
    // HMAC requires real WebCrypto microtasks before the binding timer is created.
    await vi.waitFor(() => expect(env.EMAIL.send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toMatchObject({ deliveryStatus: 'unavailable' });
    expect((harness.sqlite.prepare('SELECT delivery_status FROM email_verification_challenges').get() as any).delivery_status).toBe('pending');
    const code = env.EMAIL.send.mock.calls[0][0].html.match(/code is (\d{6})/)[1];
    expect(await verifyEmailCode(env, user, code)).toBe(true);
    expect(await verifyEmailCode(env, user, code)).toBe(false);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).toContain('unknown');
  });
  it('enforces the attempt ceiling and expiry for uncertain pending deliveries', async () => {
    const user = { id: 'owner', email: 'owner@example.test' };
    const now = Date.now();
    await requestEmailVerification(env, user, now);
    const code = env.EMAIL.send.mock.calls[0][0].html.match(/code is (\d{6})/)[1];
    harness.sqlite.exec("UPDATE email_verification_challenges SET delivery_status='pending'");
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let index = 0; index < 5; index++) expect(await verifyEmailCode(env, user, wrongCode, now + index)).toBe(false);
    expect(await verifyEmailCode(env, user, code, now + 5000)).toBe(false);
    harness.sqlite.exec('UPDATE email_verification_challenges SET attempts=0');
    expect(await verifyEmailCode(env, user, code, now + 600001)).toBe(false);
  });
  it('removes rejected Expo installations, inspects later tickets, and preserves a reassigned token', async () => {
    harness.sqlite.exec(`INSERT INTO user_devices VALUES ('a','owner','["ExpoPushToken[one]","ExpoPushToken[two]"]'),('b','newowner','["ExpoPushToken[three]"]')`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { status: 'ok', id: 'ticket-one' }, { status: 'error', message: 'private', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ] }))));
    await expect(sendExpoPushNotification({ userId: 'owner', tokens: ['ExpoPushToken[one]', 'ExpoPushToken[two]', 'ExpoPushToken[three]'] }, env)).rejects.toThrow('not all accepted');
    expect((harness.sqlite.prepare("SELECT push_tokens FROM user_devices WHERE id='a'").get() as any).push_tokens).toBe('["ExpoPushToken[one]"]');
    expect((harness.sqlite.prepare("SELECT push_tokens FROM user_devices WHERE id='b'").get() as any).push_tokens).toContain('three');
  });
  it('rejects missing provider tickets instead of fabricating acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }))));
    await expect(sendExpoPushNotification({ userId: 'owner', tokens: ['ExpoPushToken[one]'] }, env)).rejects.toThrow('not all accepted');
  });
});

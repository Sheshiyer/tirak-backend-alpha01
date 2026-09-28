import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '@/utils/communication';

afterEach(() => vi.useRealTimers());
describe('Cloudflare email acceptance and safe failures', () => {
  it('preserves the structured binding API and records acceptance, not delivery', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'accepted-id' });
    expect(await sendEmail({ provider: 'cloudflare', env: { EMAIL: { send } }, fromEmail: 'noreply@tirak.app' }, 'owner@example.test', 'Subject', 'Body'))
      .toMatchObject({ status: 'sent', id: 'accepted-id', provider: 'cloudflare' });
    expect(send.mock.calls[0][0]).toMatchObject({ to: 'owner@example.test', from: { email: 'noreply@tirak.app' }, subject: 'Subject', text: 'Body' });
  });
  it.each(['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_RECIPIENT_SUPPRESSED'])('retains only safe provider code %s and request id', async code => {
    const send = vi.fn().mockRejectedValue({ code, message: 'owner@example.test secret reset token', requestId: 'aaaa1111-bbbb2222' });
    const result = await sendEmail({ provider: 'cloudflare', env: { EMAIL: { send } }, fromEmail: 'noreply@tirak.app' }, 'owner@example.test', 'Subject', 'private');
    expect(result).toMatchObject({ status: 'failed', errorCode: code, providerRequestId: 'aaaa1111-bbbb2222' });
    expect(JSON.stringify(result)).not.toMatch(/owner@example|secret|private/);
  });
  it('fails safely on unknown exception metadata', async () => {
    const send = vi.fn().mockRejectedValue({ code: 'owner@example.test', message: 'secret', requestId: 'owner@example.test' });
    const result = await sendEmail({ provider: 'cloudflare', env: { EMAIL: { send } }, fromEmail: 'noreply@tirak.app' }, 'owner@example.test', 'Subject', 'private');
    expect(result.errorCode).toBe('EMAIL_PROVIDER_REJECTED'); expect(result.providerRequestId).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/owner@example|secret|private/);
  });
  it('bounds a stuck binding without claiming success', async () => {
    vi.useFakeTimers();
    const pending = sendEmail({ provider: 'cloudflare', env: { EMAIL: { send: () => new Promise(() => {}) } }, fromEmail: 'noreply@tirak.app' }, 'owner@example.test', 'Subject', 'private');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: 'failed', errorCode: 'EMAIL_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailConfig, getEmailReadiness, recordEmailOutcome, sendEmail, type EmailConfig } from '@/utils/communication';

const id = 'f99089d1-7ec8-4d45-8b72-bde78c42c665';
const config: EmailConfig = { provider: 'resend', apiKey: 'test-resend-key', fromEmail: 'noreply@example.test', fromName: 'Tirak', replyTo: 'support@example.test' };
const send = (overrides: Partial<EmailConfig> = {}, content = 'Your code is 123456.') => sendEmail({ ...config, ...overrides }, 'owner@example.test', 'Confirm email', content);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Resend transport', () => {
  it('sends the documented payload and records only the actual provider receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await send();
    expect(result).toMatchObject({ status: 'sent', id, providerRequestId: id, provider: 'resend' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(options.headers.Authorization).toBe('Bearer test-resend-key');
    expect(JSON.parse(options.body)).toMatchObject({ from: '"Tirak" <noreply@example.test>', to: ['owner@example.test'], reply_to: 'support@example.test', subject: 'Confirm email', text: 'Your code is 123456.', html: expect.stringContaining('Your code is 123456.') });
    expect(vi.getTimerCount()).toBe(0);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    recordEmailOutcome('password_reset', result, 'test-request');
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({ outcome: 'accepted', providerRequestId: id });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/owner@example|123456|test-resend-key/);
  });
  it('preserves HTML and action URLs in plain text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id }));
    vi.stubGlobal('fetch', fetchMock);
    const html = '<p><a href="https://example.test/auth#token=sample"><strong>Reset</strong></a></p>';
    await send({ replyTo: undefined }, html);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ html, text: 'Reset (https://example.test/auth#token=sample)', reply_to: config.fromEmail });
  });
  it.each([301, 400, 401, 403, 429, 500])('reports HTTP %s as rejection without raw provider details', async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('secret body owner@example.test', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await send();
    expect(result).toMatchObject({ status: 'failed', errorCode: 'EMAIL_PROVIDER_REJECTED', error: `Resend email request rejected with status ${status}` });
    expect(JSON.stringify(result)).not.toMatch(/secret|owner@example|test-resend-key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{}, null, { id: '' }, { id: ' ' }, { id: 'owner@example.test' }, { id, error: { message: 'private' } }])('does not fabricate acceptance for malformed success %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    expect(await send()).toMatchObject({ status: 'failed', errorCode: 'EMAIL_TIMEOUT', error: 'Resend email request outcome is unknown' });
  });
  it.each(['network', 'json'])('preserves unknown %s errors without leaking exceptions', async (failure) => {
    vi.stubGlobal('fetch', failure === 'network'
      ? vi.fn().mockRejectedValue(new Error('private owner@example.test test-resend-key'))
      : vi.fn().mockResolvedValue(new Response('private malformed JSON')));
    const result = await send();
    expect(result.errorCode).toBe('EMAIL_TIMEOUT');
    expect(JSON.stringify(result)).not.toMatch(/private|owner@example|test-resend-key/);
  });
  it.each(['fetch', 'body'])('bounds a stalled %s with one deadline and clears its timer', async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      signal = options.signal;
      if (stage === 'fetch') return new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, 7000));
      return { status: 200, json: () => new Promise(() => {}) };
    }));
    const pending = send();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: 'failed', errorCode: 'EMAIL_TIMEOUT' });
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{ apiKey: '' }, { apiKey: ' ' }, { fromEmail: undefined }, { fromEmail: 'invalid' }, { replyTo: 'invalid' }, { fromName: 'Bad\r\nName' }])('does not call the provider with invalid configuration %j', async (overrides) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await send(overrides)).toMatchObject({ status: 'failed', errorCode: 'EMAIL_CONFIGURATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects an invalid recipient without network access', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await sendEmail(config, 'invalid', 'subject', 'body')).toMatchObject({ errorCode: 'EMAIL_CONFIGURATION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires the selected provider key and explicit valid sender', () => {
    const env = { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test-resend-key', EMAIL_FROM: 'noreply@example.test' };
    expect(createEmailConfig(env)).toMatchObject({ provider: 'resend', apiKey: env.RESEND_API_KEY, fromEmail: env.EMAIL_FROM });
    expect(getEmailReadiness(env).configured).toBe(true);
    for (const broken of [{ RESEND_API_KEY: undefined }, { RESEND_API_KEY: ' ' }, { EMAIL_FROM: undefined }, { EMAIL_FROM: 'invalid' }, { EMAIL_REPLY_TO: 'invalid' }, { EMAIL_FROM_NAME: 'Bad\r\nName' }]) {
      expect(getEmailReadiness({ ...env, SENDGRID_API_KEY: 'another-key', ...broken }).configured).toBe(false);
    }
    expect(getEmailReadiness({ ...env, EMAIL_PROVIDER: 'cloudflare' }).configured).toBe(false);
  });
});

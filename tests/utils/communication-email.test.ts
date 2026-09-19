import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailConfig, getEmailReadiness, sendEmail, type EmailConfig } from '@/utils/communication';

const sendgrid: EmailConfig = {
  provider: 'sendgrid',
  apiKey: 'test-sendgrid-api-key',
  fromEmail: 'noreply@example.test',
  fromName: 'Tirak',
  replyTo: 'support@example.test',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SendGrid email delivery', () => {
  it('POSTs plain text and HTML to the provider with required authorization and addressing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202, headers: { 'X-Message-Id': 'sg-message-id' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendEmail(sendgrid, 'customer@example.test', 'Verify your email', 'Your code is 123456.');

    expect(result).toMatchObject({ id: 'sg-message-id', status: 'sent', provider: 'sendgrid' });
    expect(result.status).not.toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-sendgrid-api-key');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toMatchObject({
      personalizations: [{ to: [{ email: 'customer@example.test' }] }],
      from: { email: 'noreply@example.test', name: 'Tirak' },
      reply_to: { email: 'support@example.test' },
      subject: 'Verify your email',
      content: [
        { type: 'text/plain', value: 'Your code is 123456.' },
        { type: 'text/html', value: expect.stringContaining('Your code is 123456.') },
      ],
    });
  });

  it('retains HTML while providing a readable plain-text part and fallback message id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendEmail({ ...sendgrid, replyTo: undefined }, 'customer@example.test', 'Welcome', '<p>Welcome <strong>friend</strong>.</p>');
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(result.status).toBe('sent');
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload.reply_to.email).toBe('noreply@example.test');
    expect(payload.content[0]).toEqual({ type: 'text/plain', value: 'Welcome friend .' });
    expect(payload.content[1]).toEqual({ type: 'text/html', value: '<p>Welcome <strong>friend</strong>.</p>' });
  });

  it.each([200, 400, 401, 403, 429, 500])('fails truthfully on HTTP %s without exposing provider response content', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private recipient and provider detail', { status })));
    const result = await sendEmail(sendgrid, 'customer@example.test', 'Subject', 'private body');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('SendGrid email request rejected with status ' + status);
    expect(JSON.stringify(result)).not.toMatch(/private|test-sendgrid-api-key|customer@example/);
  });

  it('sanitizes network failure details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-sendgrid-api-key customer@example.test private body')));
    const result = await sendEmail(sendgrid, 'customer@example.test', 'Subject', 'private body');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('SendGrid email request failed');
  });

  it('aborts slow requests and returns failed after the bounded timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const sending = sendEmail(sendgrid, 'customer@example.test', 'Subject', 'Body');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sending).resolves.toMatchObject({ status: 'failed', error: 'SendGrid email request timed out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...sendgrid, apiKey: '' },
    { ...sendgrid, fromEmail: undefined },
    { ...sendgrid, fromEmail: 'invalid' },
    { ...sendgrid, replyTo: 'invalid' },
  ])('does not send with incomplete or invalid configuration', async (config) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await sendEmail(config, 'customer@example.test', 'Subject', 'Body')).status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('email provider readiness', () => {
  it('does not claim AWS SES sends emails even with credentials configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      EMAIL_PROVIDER: 'aws-ses', AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_REGION: 'eu-west-1', AWS_SES_FROM_EMAIL: 'noreply@example.test',
    };
    expect(getEmailReadiness(env).configured).toBe(false);
    expect((await sendEmail(createEmailConfig(env), 'customer@example.test', 'Subject', 'Body'))).toMatchObject({
      status: 'failed', provider: 'aws-ses', error: expect.stringContaining('not implemented'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only the selected provider and requires its sender configuration', () => {
    expect(getEmailReadiness({ SENDGRID_API_KEY: 'test-key' }).configured).toBe(false);
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'test-key' }).configured).toBe(false);
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'test-key', EMAIL_FROM: 'noreply@example.test' })).toMatchObject({
      configured: true, provider: 'sendgrid', from: 'noreply@example.test',
    });
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'sendgrid', MAILCHANNELS_API_KEY: 'test-key', EMAIL_FROM: 'noreply@example.test' }).configured).toBe(false);
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'mailchannels', MAILCHANNELS_API_KEY: 'test-key' }).configured).toBe(true);
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'mailchannels', MAILCHANNELS_API_KEY: ' ' }).configured).toBe(false);
  });

  it('requires a callable Cloudflare binding and rejects unsupported providers', () => {
    expect(getEmailReadiness({ EMAIL: {} }).configured).toBe(false);
    expect(getEmailReadiness({ EMAIL: { send() {} } })).toMatchObject({ configured: true, provider: 'cloudflare' });
    expect(getEmailReadiness({ EMAIL: { send() {} }, EMAIL_FROM: 'invalid' }).configured).toBe(false);
    expect(getEmailReadiness({ EMAIL_PROVIDER: 'unknown', SENDGRID_API_KEY: 'test-key' })).toMatchObject({
      configured: false, provider: 'unsupported', from: null,
    });
  });
});

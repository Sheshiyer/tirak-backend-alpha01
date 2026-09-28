import { z } from 'zod';

// Types for communication services
export interface SMSConfig {
  provider: 'twilio' | 'aws-sns';
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface EmailConfig {
  provider: 'cloudflare' | 'mailchannels' | 'sendgrid' | 'aws-ses' | 'resend';
  env?: any;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface OTPData {
  code: string;
  expiresAt: Date;
  attempts: number;
  verified: boolean;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  type: 'sms' | 'email';
  subject?: string;
  content: string;
  variables: string[];
}

export interface DeliveryStatus {
  id: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  timestamp: Date;
  error?: string;
  provider?: string;
  errorCode?: EmailFailureCode;
  providerRequestId?: string;
}

export type EmailFailureCode = 'E_SENDER_NOT_VERIFIED' | 'E_SENDER_DOMAIN_NOT_AVAILABLE'
  | 'E_RECIPIENT_SUPPRESSED' | 'E_RECIPIENT_NOT_ALLOWED' | 'E_RATE_LIMIT_EXCEEDED' | 'E_DAILY_LIMIT_EXCEEDED'
  | 'E_DELIVERY_FAILED' | 'E_INTERNAL_SERVER_ERROR' | 'EMAIL_CONFIGURATION' | 'EMAIL_TIMEOUT' | 'EMAIL_PROVIDER_REJECTED';
const EMAIL_PROVIDER_CODES = new Set(['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_RECIPIENT_SUPPRESSED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_DELIVERY_FAILED', 'E_INTERNAL_SERVER_ERROR']);

function safeEmailFailure(error: unknown): { error: string; errorCode: EmailFailureCode; providerRequestId?: string } {
  const candidate = error as { code?: unknown; requestId?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' && EMAIL_PROVIDER_CODES.has(candidate.code)
    ? candidate.code as EmailFailureCode : candidate?.code === 'EMAIL_TIMEOUT' ? 'EMAIL_TIMEOUT' : 'EMAIL_PROVIDER_REJECTED';
  // Only our own fixed adapter messages may survive. Arbitrary provider messages can include PII.
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  const safe = /^(SendGrid email request (failed|timed out|rejected with status [0-9]{3})|Resend email request (outcome is unknown|rejected with status [0-9]{3})|Missing (Cloudflare Email Service binding or sender|SendGrid configuration|MailChannels configuration|Resend configuration)|Invalid (SendGrid|Resend) email address configuration|AWS SES email sending is not implemented)$/.test(message);
  return { error: safe ? message : message === 'AWS SES email delivery is not implemented. Configure a supported email provider.' ? 'AWS SES email delivery is not implemented' : 'Email provider rejected the request',
    errorCode: message.startsWith('Missing ') || message.startsWith('Invalid SendGrid') || message.startsWith('Invalid Resend') ? 'EMAIL_CONFIGURATION' : code,
    ...(typeof candidate?.requestId === 'string' && /^[a-fA-F0-9-]{16,64}$/.test(candidate.requestId)
      ? { providerRequestId: candidate.requestId } : {}) };
}

/** Structured operational receipt: no recipient, token, code, content, or raw exception. */
export function recordEmailOutcome(purpose: 'password_reset' | 'email_verification' | 'supplier_invite', delivery: DeliveryStatus, requestId: string): void {
  console.info(JSON.stringify({ event: 'email_delivery', purpose, requestId, provider: delivery.provider,
    outcome: delivery.errorCode === 'EMAIL_TIMEOUT' ? 'unknown' : delivery.status === 'sent' || delivery.status === 'delivered' ? 'accepted' : 'failed',
    errorCode: delivery.errorCode, providerRequestId: delivery.providerRequestId }));
}

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const renderBasicEmail = (title: string, body: string, action?: { label: string; url: string }) => {
  const safeTitle = htmlEscape(title);
  const safeBody = htmlEscape(body).replace(/\n/g, '<br />');
  const actionHtml = action
    ? `<p style="margin:24px 0"><a href="${htmlEscape(action.url)}" style="background:#A85CF9;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">${htmlEscape(action.label)}</a></p>`
    : '';

  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#161827;line-height:1.5;background:#fff8f5;margin:0;padding:24px">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #f0e5ef">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 16px">${safeTitle}</h1>
      <p style="font-size:16px;margin:0 0 8px">${safeBody}</p>
      ${actionHtml}
      <p style="font-size:13px;color:#6e7584;margin-top:28px">Tirak support: support@tirak.app</p>
    </main>
  </body>
</html>`;
};

// OTP generation and validation
export function generateOTP(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  
  return otp;
}

export function createOTPData(code?: string): OTPData {
  return {
    code: code || generateOTP(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    attempts: 0,
    verified: false
  };
}

export function isOTPValid(otpData: OTPData, inputCode: string): boolean {
  if (otpData.verified) return false;
  if (otpData.attempts >= 3) return false;
  if (new Date() > otpData.expiresAt) return false;
  
  return otpData.code === inputCode;
}

export function isOTPExpired(otpData: OTPData): boolean {
  return new Date() > otpData.expiresAt;
}

// Template processing
export function processTemplate(template: string, variables: Record<string, string>): string {
  let processed = template;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    processed = processed.replace(new RegExp(placeholder, 'g'), value);
  }
  
  return processed;
}

// Default templates
export const DEFAULT_TEMPLATES: Record<string, NotificationTemplate> = {
  phone_verification: {
    id: 'phone_verification',
    name: 'Phone Verification',
    type: 'sms',
    content: 'Your Tirak verification code is: {{code}}. This code expires in 10 minutes.',
    variables: ['code']
  },
  password_reset: {
    id: 'password_reset',
    name: 'Password Reset',
    type: 'sms',
    content: 'Your Tirak password reset code is: {{code}}. This code expires in 10 minutes.',
    variables: ['code']
  },
  email_verification: {
    id: 'email_verification',
    name: 'Email Verification',
    type: 'email',
    subject: 'Verify your Tirak account',
    content: 'Hello {{name}},\n\nPlease verify your email address by entering this code: {{code}}\n\nThis code expires in 10 minutes.\n\nBest regards,\nTirak Team',
    variables: ['name', 'code']
  },
  booking_confirmation: {
    id: 'booking_confirmation',
    name: 'Booking Confirmation',
    type: 'sms',
    content: 'Your booking with {{companionName}} on {{date}} at {{time}} has been confirmed. Booking ID: {{bookingId}}',
    variables: ['companionName', 'date', 'time', 'bookingId']
  }
};

// SMS sending function
export async function sendSMS(
  config: SMSConfig,
  to: string,
  message: string,
  templateId?: string
): Promise<DeliveryStatus> {
  const deliveryId = crypto.randomUUID();
  
  try {
    if (config.provider === 'twilio') {
      return await sendTwilioSMS(config, to, message, deliveryId);
    } else if (config.provider === 'aws-sns') {
      return await sendAWSSMS(config, to, message, deliveryId);
    } else {
      throw new Error(`Unsupported SMS provider: ${config.provider}`);
    }
  } catch (error) {
    return {
      id: deliveryId,
      status: 'failed',
      timestamp: new Date(),
      error: error instanceof Error ? error.message : 'Unknown error',
      provider: config.provider
    };
  }
}

// Email sending function
export async function sendEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  templateId?: string
): Promise<DeliveryStatus> {
  const deliveryId = crypto.randomUUID();
  
  try {
    if (config.provider === 'sendgrid') {
      return await sendSendGridEmail(config, to, subject, content, deliveryId);
    } else if (config.provider === 'aws-ses') {
      return await sendAWSEmail(config, to, subject, content, deliveryId);
    } else if (config.provider === 'cloudflare') {
      return await sendCloudflareEmail(config, to, subject, content, deliveryId);
    } else if (config.provider === 'mailchannels') {
      return await sendMailChannelsEmail(config, to, subject, content, deliveryId);
    } else if (config.provider === 'resend') {
      return await sendResendEmail(config, to, subject, content);
    } else {
      throw new Error(`Unsupported email provider: ${config.provider}`);
    }
  } catch (error) {
    return {
      id: deliveryId,
      status: 'failed',
      timestamp: new Date(),
      ...safeEmailFailure(error),
      provider: config.provider
    };
  }
}

async function sendCloudflareEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  if (!config.env?.EMAIL?.send || !config.fromEmail) {
    throw new Error('Missing Cloudflare Email Service binding or sender');
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const sending = config.env.EMAIL.send({
    to,
    from: { email: config.fromEmail, name: config.fromName || 'Tirak' },
    replyTo: config.replyTo || config.fromEmail,
    subject,
    html: content.includes('<html') || content.includes('<p') ? content : renderBasicEmail(subject, content),
    text: content.replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject
  });

  // The binding has no AbortSignal. Bound our wait; timeout is unknown delivery, never success.
  let response: any;
  try {
    response = await Promise.race([sending, new Promise((_, reject) => {
      timeout = setTimeout(() => reject({ code: 'EMAIL_TIMEOUT' }), 10_000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }

  return {
    id: response?.messageId || deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'cloudflare'
  };
}

async function sendMailChannelsEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  if (!config.apiKey || !config.fromEmail) {
    throw new Error('Missing MailChannels configuration');
  }

  const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.fromEmail, name: config.fromName || 'Tirak' },
      reply_to: config.replyTo ? { email: config.replyTo } : undefined,
      subject,
      content: [
        {
          type: 'text/html',
          value: content.includes('<html') || content.includes('<p') ? content : renderBasicEmail(subject, content),
        },
        {
          type: 'text/plain',
          value: content.replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`MailChannels email failed with ${response.status}`);
  }

  return {
    id: deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'mailchannels'
  };
}

// Twilio SMS implementation
async function sendTwilioSMS(
  config: SMSConfig,
  to: string,
  message: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  // In a real implementation, you would use the Twilio SDK
  // For now, we'll simulate the API call
  
  if (!config.accountSid || !config.authToken || !config.fromNumber) {
    throw new Error('Missing Twilio configuration');
  }

  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // For development, we'll always return success
  // In production, replace with actual Twilio API call
  return {
    id: deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'twilio'
  };
}

// AWS SNS SMS implementation
async function sendAWSSMS(
  config: SMSConfig,
  to: string,
  message: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  // In a real implementation, you would use the AWS SDK
  // For now, we'll simulate the API call
  
  if (!config.accessKeyId || !config.secretAccessKey || !config.region) {
    throw new Error('Missing AWS SNS configuration');
  }

  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // For development, we'll always return success
  // In production, replace with actual AWS SNS API call
  return {
    id: deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'aws-sns'
  };
}

// SendGrid email implementation
async function sendSendGridEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  if (!config.apiKey?.trim() || !config.fromEmail?.trim()) {
    throw new Error('Missing SendGrid configuration');
  }
  const emailAddress = z.string().email();
  if (!emailAddress.safeParse(to).success || !emailAddress.safeParse(config.fromEmail).success
    || (config.replyTo && !emailAddress.safeParse(config.replyTo).success)) {
    throw new Error('Invalid SendGrid email address configuration');
  }

  const isHtml = /<[a-z][^>]*>/i.test(content);
  const html = isHtml ? content : renderBasicEmail(subject, content);
  const plainText = isHtml
    ? content.replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject
    : content || subject;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: config.fromEmail, name: config.fromName || 'Tirak' },
        reply_to: { email: config.replyTo || config.fromEmail },
        subject,
        content: [
          { type: 'text/plain', value: plainText },
          { type: 'text/html', value: html },
        ],
      }),
    });
  } catch {
    // Provider errors can contain credentials, recipients or message bodies.
    throw new Error(controller.signal.aborted ? 'SendGrid email request timed out' : 'SendGrid email request failed');
  } finally {
    clearTimeout(timeout);
  }

  // SendGrid accepts Mail Send requests with 202; acceptance is not delivery.
  if (response.status !== 202) {
    throw new Error(`SendGrid email request rejected with status ${response.status}`);
  }
  return {
    id: response.headers.get('X-Message-Id') || deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'sendgrid'
  };
}


async function sendResendEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string
): Promise<DeliveryStatus> {
  if (!config.apiKey?.trim() || !config.fromEmail?.trim()) {
    throw new Error('Missing Resend configuration');
  }
  const emailAddress = z.string().email();
  if (!emailAddress.safeParse(to).success || !emailAddress.safeParse(config.fromEmail).success
    || (config.replyTo !== undefined && !emailAddress.safeParse(config.replyTo).success)
    || (config.fromName && /[\r\n<>]/.test(config.fromName))) {
    throw new Error('Invalid Resend email address configuration');
  }
  const isHtml = /<[a-z][^>]*>/i.test(content);
  const html = isHtml ? content : renderBasicEmail(subject, content);
  const text = isHtml
    ? content.replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject
    : content || subject;
  // EMAIL_TIMEOUT is the existing consumer contract for uncertain acceptance.
  // Network and success-body failures also use it so possibly delivered reset
  // tokens/challenges remain usable under their original expiry and limits.
  const unknown = () => Object.assign(new Error('Resend email request outcome is unknown'), { code: 'EMAIL_TIMEOUT' });
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: { status: number; body: unknown };
  try {
    result = await Promise.race([
      (async () => {
        const response = await fetch('https://api.resend.com/emails', {
          // The retained Workers compatibility runtime rejects redirect: 'error'.
          // Manual returns 3xx for rejection below without forwarding credentials.
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey!.trim()}` },
          body: JSON.stringify({
            from: config.fromName ? `${JSON.stringify(config.fromName)} <${config.fromEmail}>` : config.fromEmail,
            to: [to], subject, html, text, reply_to: config.replyTo || config.fromEmail,
          }),
        });
        return { status: response.status, body: response.status === 200 ? await response.json() : null };
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(unknown()); }, 10_000);
      }),
    ]);
  } catch {
    throw unknown();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Resend email request rejected with status ${result.status}`);
  }
  const body = result.body as { id?: unknown; error?: unknown } | null;
  if (result.status !== 200 || !z.string().uuid().safeParse(body?.id).success || body?.error != null) {
    throw unknown();
  }
  const id = body!.id as string;
  return { id, providerRequestId: id, status: 'sent', timestamp: new Date(), provider: 'resend' };
}

// AWS SES email implementation
async function sendAWSEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  throw new Error('AWS SES email delivery is not implemented. Configure a supported email provider.');
}

// High-level helper functions
export async function sendOTPSMS(
  config: SMSConfig,
  phone: string,
  otp: string,
  templateId: string = 'phone_verification'
): Promise<DeliveryStatus> {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template || template.type !== 'sms') {
    throw new Error(`Invalid SMS template: ${templateId}`);
  }

  const message = processTemplate(template.content, { code: otp });
  return await sendSMS(config, phone, message, templateId);
}

export async function sendOTPEmail(
  config: EmailConfig,
  email: string,
  name: string,
  otp: string,
  templateId: string = 'email_verification'
): Promise<DeliveryStatus> {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template || template.type !== 'email') {
    throw new Error(`Invalid email template: ${templateId}`);
  }

  const subject = template.subject || 'Verification Code';
  const content = processTemplate(template.content, { name, code: otp });

  return await sendEmail(config, email, subject, content, templateId);
}

export async function sendNotificationSMS(
  config: SMSConfig,
  phone: string,
  templateId: string,
  variables: Record<string, string>
): Promise<DeliveryStatus> {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template || template.type !== 'sms') {
    throw new Error(`Invalid SMS template: ${templateId}`);
  }

  const message = processTemplate(template.content, variables);
  return await sendSMS(config, phone, message, templateId);
}

export async function sendNotificationEmail(
  config: EmailConfig,
  email: string,
  templateId: string,
  variables: Record<string, string>
): Promise<DeliveryStatus> {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template || template.type !== 'email') {
    throw new Error(`Invalid email template: ${templateId}`);
  }

  const subject = template.subject ? processTemplate(template.subject, variables) : 'Notification';
  const content = processTemplate(template.content, variables);

  return await sendEmail(config, email, subject, content, templateId);
}

// Configuration helpers
export interface EmailReadiness {
  configured: boolean;
  provider: string;
  from: string | null;
  reason?: string;
}

/** Configuration readiness only; this does not prove delivery or sender-domain approval. */
export function getEmailReadiness(env: object): EmailReadiness {
  let config: EmailConfig;
  try {
    config = createEmailConfig(env);
  } catch {
    return { configured: false, provider: 'unsupported', from: null, reason: 'Unsupported email provider' };
  }
  const from = config.fromEmail || null;
  if (config.provider === 'aws-ses') {
    return { configured: false, provider: config.provider, from, reason: 'AWS SES email delivery is not implemented' };
  }
  if (!z.string().email().safeParse(from).success
    || (config.replyTo && !z.string().email().safeParse(config.replyTo).success)
    || (config.provider === 'resend' && config.fromName && /[\r\n<>]/.test(config.fromName))) {
    return { configured: false, provider: config.provider, from, reason: 'A valid sender and reply-to address are required' };
  }
  const configured = config.provider === 'cloudflare'
    ? typeof config.env?.EMAIL?.send === 'function'
    : Boolean(config.apiKey?.trim());
  return {
    configured,
    provider: config.provider,
    from,
    ...(!configured ? { reason: config.provider === 'cloudflare' ? 'Email service binding is unavailable' : 'Provider API key is missing' } : {}),
  };
}

export function createSMSConfig(env: any): SMSConfig {
  const provider = env.SMS_PROVIDER || 'twilio';

  if (provider === 'twilio') {
    return {
      provider: 'twilio',
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER
    };
  } else if (provider === 'aws-sns') {
    return {
      provider: 'aws-sns',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION || 'us-east-1'
    };
  }

  throw new Error(`Unsupported SMS provider: ${provider}`);
}

export function createEmailConfig(env: any): EmailConfig {
  const provider = env.EMAIL_PROVIDER || 'cloudflare';

  if (provider === 'cloudflare') {
    return {
      provider: 'cloudflare',
      env,
      fromEmail: env.EMAIL_FROM || 'noreply@tirak.app',
      fromName: env.EMAIL_FROM_NAME || 'Tirak',
      replyTo: env.EMAIL_REPLY_TO || 'support@tirak.app'
    };
  } else if (provider === 'resend') {
    return {
      provider: 'resend', apiKey: env.RESEND_API_KEY, fromEmail: env.EMAIL_FROM,
      fromName: env.EMAIL_FROM_NAME || 'Tirak', replyTo: env.EMAIL_REPLY_TO || 'support@tirak.app'
    };
  } else if (provider === 'mailchannels') {
    return {
      provider: 'mailchannels',
      apiKey: env.MAILCHANNELS_API_KEY,
      fromEmail: env.MAILCHANNELS_FROM_EMAIL || env.EMAIL_FROM || 'noreply@tirak.app',
      fromName: env.MAILCHANNELS_FROM_NAME || env.EMAIL_FROM_NAME || 'Tirak',
      replyTo: env.EMAIL_REPLY_TO || 'support@tirak.app'
    };
  } else if (provider === 'sendgrid') {
    return {
      provider: 'sendgrid',
      apiKey: env.SENDGRID_API_KEY,
      fromEmail: env.SENDGRID_FROM_EMAIL || env.EMAIL_FROM,
      fromName: env.SENDGRID_FROM_NAME || env.EMAIL_FROM_NAME || 'Tirak',
      replyTo: env.EMAIL_REPLY_TO || 'support@tirak.app'
    };
  } else if (provider === 'aws-ses') {
    return {
      provider: 'aws-ses',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION || 'us-east-1',
      fromEmail: env.AWS_SES_FROM_EMAIL || env.EMAIL_FROM,
      fromName: env.AWS_SES_FROM_NAME || env.EMAIL_FROM_NAME || 'Tirak',
      replyTo: env.EMAIL_REPLY_TO || 'support@tirak.app'
    };
  }

  throw new Error(`Unsupported email provider: ${provider}`);
}

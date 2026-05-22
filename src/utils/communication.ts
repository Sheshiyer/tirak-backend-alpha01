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
  provider: 'cloudflare' | 'mailchannels' | 'sendgrid' | 'aws-ses';
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
    } else {
      throw new Error(`Unsupported email provider: ${config.provider}`);
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

  const response = await config.env.EMAIL.send({
    to,
    from: { email: config.fromEmail, name: config.fromName || 'Tirak' },
    replyTo: config.replyTo || config.fromEmail,
    subject,
    html: content.includes('<html') || content.includes('<p') ? content : renderBasicEmail(subject, content),
    text: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject
  });

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
          value: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || subject,
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
  // In a real implementation, you would use the SendGrid SDK
  // For now, we'll simulate the API call
  
  if (!config.apiKey || !config.fromEmail) {
    throw new Error('Missing SendGrid configuration');
  }

  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // For development, we'll always return success
  // In production, replace with actual SendGrid API call
  return {
    id: deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'sendgrid'
  };
}

// AWS SES email implementation
async function sendAWSEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  content: string,
  deliveryId: string
): Promise<DeliveryStatus> {
  // In a real implementation, you would use the AWS SDK
  // For now, we'll simulate the API call

  if (!config.accessKeyId || !config.secretAccessKey || !config.region || !config.fromEmail) {
    throw new Error('Missing AWS SES configuration');
  }

  // Simulate API call delay
  await new Promise(resolve => setTimeout(resolve, 100));

  // For development, we'll always return success
  // In production, replace with actual AWS SES API call
  return {
    id: deliveryId,
    status: 'sent',
    timestamp: new Date(),
    provider: 'aws-ses'
  };
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

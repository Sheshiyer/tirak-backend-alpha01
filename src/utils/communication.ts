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
  provider: 'sendgrid' | 'aws-ses';
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
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
  const provider = env.EMAIL_PROVIDER || 'sendgrid';

  if (provider === 'sendgrid') {
    return {
      provider: 'sendgrid',
      apiKey: env.SENDGRID_API_KEY,
      fromEmail: env.SENDGRID_FROM_EMAIL,
      fromName: env.SENDGRID_FROM_NAME || 'Tirak'
    };
  } else if (provider === 'aws-ses') {
    return {
      provider: 'aws-ses',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION || 'us-east-1',
      fromEmail: env.AWS_SES_FROM_EMAIL,
      fromName: env.AWS_SES_FROM_NAME || 'Tirak'
    };
  }

  throw new Error(`Unsupported email provider: ${provider}`);
}

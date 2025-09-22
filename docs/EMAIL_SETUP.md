# Email Worker Setup Guide

This guide explains how to set up Cloudflare Email Workers for sending password reset emails and other transactional emails in the Tirak backend.

## Overview

The email system consists of:
- **Email Worker**: A separate Cloudflare Worker that handles email sending
- **Email Templates**: HTML templates stored in KV storage
- **Email Routing**: Cloudflare Email Routing for actual email delivery

## Setup Steps

### 1. Create Email Worker

The email worker is already created in `src/email-worker.ts`. Deploy it using:

```bash
# Windows PowerShell
.\scripts\setup-email-worker.ps1

# Or manually:
wrangler deploy --config=wrangler-email.toml
```

### 2. Set up Email Templates

Email templates are stored in `src/email-templates/`:
- `password-reset.html` - Password reset email template
- `welcome.html` - Welcome email template

Templates use `{{variable}}` syntax for dynamic content.

### 3. Configure Email Routing

1. Go to Cloudflare Dashboard → Email Routing
2. Add your domain (e.g., `tirak.app`)
3. Set up email addresses:
   - `noreply@tirak.app` for transactional emails
   - `support@tirak.app` for support emails

### 4. Update Main Worker Configuration

Add the email worker binding to your main `wrangler.toml`:

```toml
# Add this to your main wrangler.toml
[[services]]
binding = "EMAIL_WORKER"
service = "tirak-email-worker"
environment = "production"
```

### 5. Environment Variables

Set these secrets in your main worker:

```bash
wrangler secret put FROM_EMAIL
wrangler secret put FROM_NAME
```

## Usage

### Password Reset Email

The forgot password endpoint automatically sends emails:

```typescript
// In your auth route
await c.env.EMAIL_WORKER.send({
  to: user.email,
  subject: 'Password Reset Request - Tirak',
  template: 'password_reset',
  data: {
    resetToken,
    resetUrl: `https://tirak.app/reset-password?token=${resetToken}`,
    userName: user.display_name || user.email,
    expiresIn: '1 hour'
  }
});
```

### Custom Email Templates

1. Create HTML template in `src/email-templates/`
2. Upload to KV: `wrangler kv:key put --binding=EMAIL_TEMPLATES "template_name" --path="src/email-templates/template.html"`
3. Use in code: `template: 'template_name'`

## Template Variables

Available variables for email templates:

### Password Reset Template
- `{{userName}}` - User's display name or email
- `{{resetToken}}` - Password reset token
- `{{resetUrl}}` - Complete reset URL
- `{{expiresIn}}` - Token expiration time

### Welcome Template
- `{{userName}}` - User's display name or email
- `{{profileUrl}}` - Link to complete profile

## Testing

### Development Mode
In development, emails are logged to console instead of being sent.

### Production Mode
In production, emails are sent via Cloudflare Email Routing.

### Manual Testing
```bash
# Test email worker directly
curl -X POST https://tirak-email-worker.your-subdomain.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "to": "test@example.com",
    "subject": "Test Email",
    "template": "password_reset",
    "data": {
      "userName": "Test User",
      "resetToken": "test-token",
      "resetUrl": "https://example.com/reset?token=test-token",
      "expiresIn": "1 hour"
    }
  }'
```

## Troubleshooting

### Common Issues

1. **Email not sending**: Check Cloudflare Email Routing configuration
2. **Template not found**: Verify template is uploaded to KV storage
3. **Invalid template**: Check HTML syntax and variable names

### Debug Mode

Enable debug logging by setting `ENVIRONMENT=development` in your worker.

### Monitoring

Check Cloudflare Workers analytics for email worker performance and errors.

## Security Considerations

1. **Rate Limiting**: Implement rate limiting for email sending
2. **Template Validation**: Validate template data before sending
3. **Email Verification**: Verify email addresses before sending
4. **Spam Prevention**: Follow email best practices to avoid spam filters

## Cost Considerations

- **Email Routing**: Free for up to 1,000 emails/month
- **KV Storage**: Minimal cost for template storage
- **Worker Invocations**: Standard Cloudflare Workers pricing

## Support

For issues with email functionality:
1. Check Cloudflare Workers logs
2. Verify Email Routing configuration
3. Test with development mode first
4. Contact Cloudflare support if needed

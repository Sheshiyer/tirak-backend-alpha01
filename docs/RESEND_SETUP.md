# Resend Email Setup Guide

This guide explains how to set up Resend for sending emails through the Tirak email worker.

## What is Resend?

Resend is a modern email API for developers. It's perfect for transactional emails like password resets, welcome emails, and notifications.

**Free Tier:**
- 3,000 emails per month
- 100 emails per day
- No credit card required

## Setup Steps

### 1. Create Resend Account

1. Go to [resend.com](https://resend.com)
2. Sign up for a free account
3. Verify your email address

### 2. Get API Key

1. Log into your Resend dashboard
2. Go to **API Keys** section
3. Click **Create API Key**
4. Give it a name like "Tirak Email Worker"
5. Copy the API key (starts with `re_`)

### 3. Set Up Domain (Optional but Recommended)

For production, you should verify your domain:

1. Go to **Domains** in Resend dashboard
2. Click **Add Domain**
3. Enter your domain (e.g., `tirak.app`)
4. Follow the DNS setup instructions
5. Wait for verification

### 4. Configure Email Worker

Set the Resend API key as a secret in your email worker:

```bash
# Set the API key as a secret
wrangler secret put RESEND_API_KEY --config=wrangler-email.toml

# When prompted, paste your Resend API key
```

### 5. Update From Email

Update the `FROM_EMAIL` in your configuration to use your verified domain:

```toml
# In wrangler-email.toml
[vars]
FROM_EMAIL = "noreply@tirak.app"  # Use your verified domain
FROM_NAME = "Tirak"
```

### 6. Deploy Email Worker

```bash
wrangler deploy --config=wrangler-email.toml
```

## Testing

### Test Email Sending

You can test the email worker directly:

```bash
curl -X POST https://tirak-email-worker.tirak-court.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "to": "your-email@example.com",
    "subject": "Test Email from Tirak",
    "template": "password_reset",
    "data": {
      "userName": "Test User",
      "resetToken": "test-token-123",
      "resetUrl": "https://tirak.app/reset?token=test-token-123",
      "expiresIn": "1 hour"
    }
  }'
```

### Test Password Reset

Test the full password reset flow:

```bash
curl -X POST https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"identifier": "your-email@example.com"}'
```

## Monitoring

### Resend Dashboard

- Check email delivery status in Resend dashboard
- View email logs and analytics
- Monitor API usage and limits

### Cloudflare Workers Logs

```bash
# View email worker logs
wrangler tail tirak-email-worker --config=wrangler-email.toml
```

## Troubleshooting

### Common Issues

1. **"Invalid API key"**
   - Check that the API key is correctly set as a secret
   - Verify the API key is active in Resend dashboard

2. **"Domain not verified"**
   - Use a verified domain in FROM_EMAIL
   - Or use the default Resend domain: `onboarding@resend.dev`

3. **"Rate limit exceeded"**
   - Check your Resend usage in the dashboard
   - Free tier: 100 emails per day

4. **"Email not delivered"**
   - Check spam folder
   - Verify recipient email address
   - Check Resend delivery logs

### Debug Mode

To see email content in logs (for development):

```bash
# Temporarily remove the API key to enable debug mode
wrangler secret delete RESEND_API_KEY --config=wrangler-email.toml
```

## Production Checklist

- [ ] Resend account created and verified
- [ ] API key set as secret in email worker
- [ ] Domain verified in Resend (recommended)
- [ ] FROM_EMAIL updated to verified domain
- [ ] Email worker deployed
- [ ] Test emails sent successfully
- [ ] Password reset flow tested end-to-end

## Cost

- **Free Tier**: 3,000 emails/month
- **Pro Plan**: $20/month for 50,000 emails
- **Enterprise**: Custom pricing

For most applications, the free tier is sufficient for development and early production use.

## Support

- [Resend Documentation](https://resend.com/docs)
- [Resend Support](https://resend.com/support)
- [Resend Discord](https://discord.gg/resend)

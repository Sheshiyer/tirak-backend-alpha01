#!/bin/bash

# Setup script for Tirak Email Worker
# This script sets up the email worker and uploads templates

set -e

echo "📧 Setting up Tirak Email Worker..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Please install it first:"
    echo "   npm install -g wrangler"
    exit 1
fi

# Create KV namespace for email templates
echo "🔧 Creating KV namespace for email templates..."
EMAIL_TEMPLATES_ID=$(wrangler kv:namespace create "EMAIL_TEMPLATES" --preview | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
echo "✅ Created EMAIL_TEMPLATES namespace with ID: $EMAIL_TEMPLATES_ID"

# Update wrangler-email.toml with the actual KV namespace ID
if [ -f "wrangler-email.toml" ]; then
    sed -i "s/placeholder-email-templates-id/$EMAIL_TEMPLATES_ID/g" wrangler-email.toml
    echo "✅ Updated wrangler-email.toml with KV namespace ID"
fi

# Upload email templates
echo "📤 Uploading email templates..."

# Password reset template
wrangler kv:key put --binding=EMAIL_TEMPLATES "password_reset" --path="src/email-templates/password-reset.html"
echo "✅ Uploaded password_reset template"

# Welcome template
wrangler kv:key put --binding=EMAIL_TEMPLATES "welcome" --path="src/email-templates/welcome.html"
echo "✅ Uploaded welcome template"

# Deploy email worker
echo "🚀 Deploying email worker..."
wrangler deploy --config=wrangler-email.toml

echo "✅ Email worker setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Update your main wrangler.toml with the EMAIL_WORKER binding"
echo "2. Set up email routing in Cloudflare dashboard"
echo "3. Test the forgot password functionality"
echo ""
echo "🔗 Email Worker URL: https://tirak-email-worker.your-subdomain.workers.dev"

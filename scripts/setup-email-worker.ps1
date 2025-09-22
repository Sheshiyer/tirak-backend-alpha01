# PowerShell script for setting up Tirak Email Worker
# Run with: .\scripts\setup-email-worker.ps1

Write-Host "📧 Setting up Tirak Email Worker..." -ForegroundColor Cyan

# Check if wrangler is installed
try {
    $wranglerVersion = wrangler --version
    Write-Host "✅ Wrangler CLI found: $wranglerVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Wrangler CLI not found. Please install it first:" -ForegroundColor Red
    Write-Host "   npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

# Create KV namespace for email templates
Write-Host "🔧 Creating KV namespace for email templates..." -ForegroundColor Yellow
$namespaceOutput = wrangler kv:namespace create "EMAIL_TEMPLATES" --preview
$emailTemplatesId = ($namespaceOutput | Select-String 'id = "([^"]*)"').Matches[0].Groups[1].Value
Write-Host "✅ Created EMAIL_TEMPLATES namespace with ID: $emailTemplatesId" -ForegroundColor Green

# Update wrangler-email.toml with the actual KV namespace ID
if (Test-Path "wrangler-email.toml") {
    (Get-Content "wrangler-email.toml") -replace "placeholder-email-templates-id", $emailTemplatesId | Set-Content "wrangler-email.toml"
    Write-Host "✅ Updated wrangler-email.toml with KV namespace ID" -ForegroundColor Green
}

# Upload email templates
Write-Host "📤 Uploading email templates..." -ForegroundColor Yellow

# Password reset template
wrangler kv:key put --binding=EMAIL_TEMPLATES "password_reset" --path="src/email-templates/password-reset.html"
Write-Host "✅ Uploaded password_reset template" -ForegroundColor Green

# Welcome template
wrangler kv:key put --binding=EMAIL_TEMPLATES "welcome" --path="src/email-templates/welcome.html"
Write-Host "✅ Uploaded welcome template" -ForegroundColor Green

# Deploy email worker
Write-Host "🚀 Deploying email worker..." -ForegroundColor Yellow
wrangler deploy --config=wrangler-email.toml

Write-Host "✅ Email worker setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next steps:" -ForegroundColor Cyan
Write-Host "1. Update your main wrangler.toml with the EMAIL_WORKER binding" -ForegroundColor White
Write-Host "2. Set up email routing in Cloudflare dashboard" -ForegroundColor White
Write-Host "3. Test the forgot password functionality" -ForegroundColor White
Write-Host ""
Write-Host "🔗 Email Worker URL: https://tirak-email-worker.your-subdomain.workers.dev" -ForegroundColor Yellow

#!/usr/bin/env node

/**
 * Script to upload email templates to Cloudflare KV
 * Run with: node scripts/setup-email-templates.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const templates = [
  {
    key: 'password_reset',
    file: 'password-reset.html'
  },
  {
    key: 'welcome',
    file: 'welcome.html'
  }
];

async function uploadTemplates() {
  console.log('📧 Setting up email templates...');
  
  for (const template of templates) {
    try {
      const templatePath = join(__dirname, '..', 'src', 'email-templates', template.file);
      const content = readFileSync(templatePath, 'utf8');
      
      // In a real setup, you would use wrangler kv:put here
      // For now, we'll just log the content
      console.log(`✅ Template '${template.key}' loaded from ${template.file}`);
      console.log(`   Content length: ${content.length} characters`);
      
      // Example wrangler command:
      // npx wrangler kv:key put --binding=EMAIL_TEMPLATES "${template.key}" --path="${templatePath}"
      
    } catch (error) {
      console.error(`❌ Failed to load template '${template.key}':`, error.message);
    }
  }
  
  console.log('\n📋 Manual setup required:');
  console.log('1. Create KV namespace for email templates:');
  console.log('   npx wrangler kv:namespace create "EMAIL_TEMPLATES"');
  console.log('\n2. Upload templates to KV:');
  templates.forEach(template => {
    console.log(`   npx wrangler kv:key put --binding=EMAIL_TEMPLATES "${template.key}" --path="src/email-templates/${template.file}"`);
  });
  
  console.log('\n3. Add KV binding to wrangler.toml:');
  console.log('   [[kv_namespaces]]');
  console.log('   binding = "EMAIL_TEMPLATES"');
  console.log('   id = "your-kv-namespace-id"');
}

uploadTemplates().catch(console.error);

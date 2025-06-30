// Script to apply the missing companion_experiences migration
// This script connects to the Cloudflare D1 database and applies migration 009

// To run this script:
// 1. Make sure you're authenticated with Cloudflare CLI (wrangler)
// 2. Execute with: npx wrangler d1 execute TIRAK_DB --file=./migrations/009_add_companion_features.sql

console.log('Applying migration 009_add_companion_features.sql...');
console.log('Run this script using:');
console.log('npx wrangler d1 execute TIRAK_DB --file=./migrations/009_add_companion_features.sql');
console.log('\nNote: Replace TIRAK_DB with your actual D1 database name if different'); 
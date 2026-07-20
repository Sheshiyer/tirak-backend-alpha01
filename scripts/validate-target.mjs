import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [environment, expectedDatabase, configArgument = 'wrangler.toml'] = process.argv.slice(2);
const allowed = {
  staging: {
    worker: 'tirak-backend-staging',
    database: 'tirak-staging',
    authorization: 'T-024_APPROVED',
  },
  production: {
    worker: 'tirak-backend-production',
    database: 'tirak-mobile-production',
    authorization: 'T-072_APPROVED',
  },
};

function fail(message) {
  console.error(`Target validation failed: ${message}`);
  process.exit(1);
}

if (!allowed[environment]) fail('environment must be explicitly staging or production');
if (expectedDatabase !== allowed[environment].database) {
  fail(`expected database ${allowed[environment].database}, received ${expectedDatabase || '<missing>'}`);
}

const configPath = resolve(process.cwd(), configArgument);
const config = readFileSync(configPath, 'utf8');

const accountMatch = config.match(/^account_id\s*=\s*"([^"]+)"/m);
if (!accountMatch || !/^[a-f0-9]{32}$/i.test(accountMatch[1])) fail('account_id is missing or malformed');

let activeSection = '';
const environmentLines = [];
for (const line of config.split('\n')) {
  const sectionMatch = line.trim().match(/^\[\[?([^\]]+)\]\]?$/);
  if (sectionMatch) activeSection = sectionMatch[1];
  if (activeSection === `env.${environment}` || activeSection.startsWith(`env.${environment}.`)) {
    environmentLines.push(line);
  }
}
const environmentBlock = environmentLines.join('\n');
if (!environmentBlock) fail(`missing [env.${environment}] sections`);

if (/placeholder|changeme|your[-_]/i.test(environmentBlock)) {
  fail(`configuration ${configArgument} contains a placeholder resource identity for ${environment}`);
}

if (!environmentBlock.includes(`name = "${allowed[environment].worker}"`)) {
  fail(`Worker name does not match ${allowed[environment].worker}`);
}
if (!environmentBlock.includes(`database_name = "${allowed[environment].database}"`)) {
  fail(`D1 database does not match ${allowed[environment].database}`);
}

const databaseIdMatch = environmentBlock.match(/database_id\s*=\s*"([^"]+)"/);
if (!databaseIdMatch || !/^[a-f0-9-]{36}$/i.test(databaseIdMatch[1])) fail('D1 database_id is missing or malformed');
if (!environmentBlock.includes(`ENVIRONMENT = "${environment}"`)) fail('runtime ENVIRONMENT does not match target');
if (!environmentBlock.includes('PAYMENT_MODE = "disabled"')) fail('payment mode must be disabled at deploy boundary');
if (!environmentBlock.includes('PROMPTPAY_ENABLED = "false"')) fail('PromptPay creation must be disabled at deploy boundary');

console.log(JSON.stringify({
  status: 'PASS',
  environment,
  worker: allowed[environment].worker,
  database: allowed[environment].database,
  accountId: accountMatch[1],
  databaseId: databaseIdMatch[1],
  requiredAuthorization: allowed[environment].authorization,
  paymentMode: 'disabled',
  promptPayEnabled: false,
}, null, 2));

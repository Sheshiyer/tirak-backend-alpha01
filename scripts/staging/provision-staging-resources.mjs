import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  APPLY_CONFIRMATION,
  PINNED_ACCOUNT_ID,
  runStagingProvisioning,
  SafeProvisioningError,
} from './staging-provisioner.mjs';
import {
  assertCredentialGitBoundary,
  DEFAULT_STAGING_ENV_FILE,
  loadStagingCredentials,
  SafeCloudflareError,
} from './cloudflare-read-only-client.mjs';

const args = process.argv.slice(2);
let apply = false;
let confirmation = null;
let accountId = PINNED_ACCOUNT_ID;
let ledgerPath = 'docs/execution/phase-2/t-025-staging-provisioning-ledger.json';
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--apply') apply = true;
  else if (['--confirm', '--account', '--ledger'].includes(argument) && args[index + 1] !== undefined) {
    const value = args[index + 1];
    index += 1;
    if (argument === '--confirm') confirmation = value;
    if (argument === '--account') accountId = value;
    if (argument === '--ledger') ledgerPath = value;
  } else {
    console.error('T-025 staging provisioning refused: unsupported or incomplete option');
    process.exit(1);
  }
}

const resolvedLedger = resolve(ledgerPath);
const ledgerRelative = relative(process.cwd(), resolvedLedger);
if (!ledgerRelative || ledgerRelative.startsWith('..') || isAbsolute(ledgerRelative)) {
  console.error('T-025 staging provisioning refused: ledger must be a file inside the project worktree');
  process.exit(1);
}

const bootstrapPath = resolve('scripts/staging/bootstrap-worker.mjs');
const credentialPath = resolve(DEFAULT_STAGING_ENV_FILE);
try {
  const stat = lstatSync(bootstrapPath);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(bootstrapPath) !== bootstrapPath) {
    throw new Error('unsafe bootstrap module');
  }
} catch {
  console.error('T-025 staging provisioning refused: bootstrap module is missing or unsafe');
  process.exit(1);
}

let credentials;
try {
  assertCredentialGitBoundary({ envFilePath: credentialPath });
  credentials = loadStagingCredentials({ envFilePath: credentialPath, allowMissing: false });
  if (credentials.accountId !== accountId) throw new SafeCloudflareError('CLI account did not match the owner-only credential boundary', 'ACCOUNT_MISMATCH');
} catch (error) {
  const code = error instanceof SafeCloudflareError ? error.code : 'CREDENTIAL_BOUNDARY_REFUSED';
  console.error(`T-025 staging provisioning refused: ${code}`);
  process.exit(1);
}

try {
  const ledger = await runStagingProvisioning({
    mode: apply ? 'apply' : 'plan',
    confirmation,
    token: credentials.token,
    accountId: credentials.accountId,
    ledgerPath: resolvedLedger,
    bootstrapSource: readFileSync(bootstrapPath, 'utf8'),
  });
  console.log(JSON.stringify({
    taskId: ledger.taskId,
    mode: ledger.mode,
    status: ledger.status,
    accountId: ledger.accountId,
    preFingerprint: ledger.preFingerprint,
    postFingerprint: ledger.postFingerprint,
    exactMissingDiff: ledger.exactMissingDiff,
    mutationCounts: ledger.mutationCounts,
    ledger: resolvedLedger,
    applyConfirmationRequired: apply ? null : APPLY_CONFIRMATION,
  }, null, 2));
} catch (error) {
  const code = error instanceof SafeProvisioningError ? error.code : 'STAGING_PROVISIONING_REFUSED';
  console.error(`T-025 staging provisioning refused: ${code}`);
  process.exit(1);
}

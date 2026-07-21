import { resolve } from 'node:path';
import {
  assertCredentialGitBoundary,
  createCloudflareReadOnlyClient,
  DEFAULT_STAGING_ENV_FILE,
  loadStagingCredentials,
  PINNED_TIRAK_ACCOUNT_ID,
  SafeCloudflareError,
} from './cloudflare-read-only-client.mjs';
import { READ_ONLY_AUTHORIZATION } from './staging-ledger-lib.mjs';

function refuse(message) {
  console.error(`T-025 Cloudflare token preflight refused: ${message}`);
  process.exit(1);
}

let credentials;
try {
  assertCredentialGitBoundary({ envFilePath: resolve(DEFAULT_STAGING_ENV_FILE) });
  credentials = loadStagingCredentials({
    envFilePath: resolve(DEFAULT_STAGING_ENV_FILE),
    allowMissing: false,
  });
} catch (error) {
  refuse(error instanceof SafeCloudflareError ? error.message : 'credential validation failed');
}

if (credentials.authorization !== READ_ONLY_AUTHORIZATION) {
  refuse(`set TIRAK_STAGING_READ_ONLY_AUTHORIZATION=${READ_ONLY_AUTHORIZATION} in the owner-only credential file`);
}

try {
  const client = createCloudflareReadOnlyClient({ token: credentials.token, accountId: credentials.accountId });
  const token = await client.inspectCurrentTokenScope();
  if (!token.pinnedAccountIncluded) {
    throw new SafeCloudflareError('Cloudflare API token policies do not include the pinned Tirak account', 'ACCOUNT_SCOPE_MISMATCH');
  }
  const account = await client.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}`);
  if (account.result?.id !== PINNED_TIRAK_ACCOUNT_ID) {
    throw new SafeCloudflareError('authenticated account does not match the pinned Tirak account', 'ACCOUNT_MISMATCH');
  }
  console.log(JSON.stringify({
    status: 'PASS',
    environment: 'staging',
    verificationType: token.verificationType,
    permissionRisk: token.permissionRisk,
    pinnedAccountInTokenScope: true,
    pinnedAccountVerified: true,
    requestsExecuted: client.requestLog.length,
    remoteMutationsExecuted: 0,
    secretsCaptured: false,
  }, null, 2));
} catch (error) {
  refuse(error instanceof SafeCloudflareError ? error.message : 'read-only account preflight failed');
}

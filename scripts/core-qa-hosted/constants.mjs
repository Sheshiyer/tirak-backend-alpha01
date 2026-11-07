// Synthetic defaults for adapter regression tests. Live operator pins and credentials stay private.
export const HOSTED_RUNTIME = Object.freeze({
  workerUrl: 'https://qa-api.example.invalid',
  workerOrigin: 'https://qa-api.example.invalid',
  socketPathPattern: /^\/api\/chat\/rooms\/[^/]+\/ws$/,
  websiteOrigin: 'https://qa-website.example.invalid',
  adminOrigin: 'https://qa-admin.example.invalid',
  accountId: '00000000000000000000000000000000',
  workerName: 'tirak-core-qa-example',
  d1Binding: 'DB',
  d1DatabaseId: '11111111-1111-4111-8111-111111111111',
  d1DatabaseName: 'tirak-core-qa-example',
  r2Binding: 'STORAGE',
  r2BucketName: 'tirak-core-qa-example',
  cacheBinding: 'CACHE',
  cacheNamespaceId: '22222222222222222222222222222222',
  environment: 'core-qa',
  qaMode: 'cohort',
  paymentMode: 'disabled',
  promptPayEnabled: 'false',
  paymentProductionPolicyWritesEnabled: 'false',
  publicAssetBaseUrl: 'https://qa-api.example.invalid/api/uploads/public',
  oauthConfigPath: '',
  wranglerConfigPath: 'wrangler.core-qa.toml',
  localRuntimeModulePath: './scripts/core-qa/run-local-runtime.mjs',
  maxCallCount: 512,
  perCallTimeoutMs: 30_000,
  overallTimeoutMs: 7 * 60_000,
});

export const SYNTHETIC_IDENTITIES = Object.freeze({
  admin: 'qa-admin@core.local',
  traveler: 'qa-traveler@core.local',
  ordinary: 'qa-ordinary@core.local',
  guide: 'qa-guide@core.local',
  futureTraveler: 'qa-future-traveler@core.local',
  interest: 'qa-interest@core.local',
});

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

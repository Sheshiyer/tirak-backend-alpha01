export const HOSTED_RUNTIME = Object.freeze({
  workerUrl: 'https://tirak-core-qa-20261005.tirak-court.workers.dev',
  workerOrigin: 'https://tirak-core-qa-20261005.tirak-court.workers.dev',
  socketPathPattern: /^\/api\/chat\/rooms\/[^/]+\/ws$/,
  websiteOrigin: 'https://tirak-core-qa-website-20261005.tirak-court.workers.dev',
  adminOrigin: 'https://tirak-core-qa-admin-20261005.tirak-court.workers.dev',
  accountId: '2c0c96c68f0ee73b6d980054557bca5b',
  workerName: 'tirak-core-qa-20261005',
  d1Binding: 'DB',
  d1DatabaseId: '83574656-cd4b-4483-902c-06dfd9e77496',
  d1DatabaseName: 'tirak-core-qa-20261005',
  r2Binding: 'STORAGE',
  r2BucketName: 'tirak-core-qa-20261005',
  cacheBinding: 'CACHE',
  cacheNamespaceId: '20d12ac0b70749059926c2e30ad19b9b',
  environment: 'core-qa',
  qaMode: 'cohort',
  paymentMode: 'disabled',
  promptPayEnabled: 'false',
  paymentProductionPolicyWritesEnabled: 'false',
  publicAssetBaseUrl: 'https://tirak-core-qa-20261005.tirak-court.workers.dev/api/uploads/public',
  oauthConfigPath: '/Users/sheshnarayaniyer/Library/Preferences/.wrangler/config/tirak.toml',
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

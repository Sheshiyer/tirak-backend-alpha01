import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalJson,
  CONFIRMATION_STATEMENT,
  CONTRACT_VERSION,
  evaluateStagingEvidence,
  REST_METADATA_VARIANCE,
  REST_METADATA_VARIANCE_ID,
  TASK_ID,
} from './staging-ledger-lib.mjs';

const LEDGER_PATH = resolve('docs/execution/phase-2/t-025-staging-resource-ledger.json');
const args = process.argv.slice(2);

function fail(message) {
  console.error(`T-025 staging confirmation refused: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const supplied = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!['--fingerprint', '--statement'].includes(key) || value === undefined || supplied.has(key)) {
    fail('provide exactly one --fingerprint and one --statement option');
  }
  supplied.set(key, value);
}
if (supplied.size !== 2) fail('provide exactly one --fingerprint and one --statement option');
const suppliedFingerprint = supplied.get('--fingerprint');
const suppliedStatement = supplied.get('--statement');
assert(/^[a-f0-9]{64}$/.test(suppliedFingerprint ?? ''), 'fingerprint must be the exact 64-character current target fingerprint');
assert(suppliedStatement === CONFIRMATION_STATEMENT, 'statement must exactly match CONFIRMATION_STATEMENT');

function readOwnerOnlyLedger(path) {
  const projectRelative = relative(process.cwd(), path);
  assert(projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative), 'ledger path escaped the project worktree');
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'ledger must be a bounded regular file');
  assert((stat.mode & 0o777) === 0o600, 'ledger mode must be exactly 0600');
  if (typeof process.getuid === 'function') assert(stat.uid === process.getuid(), 'ledger must be owned by the current user');
  const realRelative = relative(process.cwd(), realpathSync(path));
  assert(realRelative && !realRelative.startsWith('..') && !isAbsolute(realRelative), 'ledger resolves outside the project worktree');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('ledger is not valid bounded JSON');
  }
}

function atomicWriteOwnerOnly(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.confirmation.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort only */ }
    fail('atomic owner-only confirmation write failed');
  }
}

const manifest = readOwnerOnlyLedger(LEDGER_PATH);
assert(manifest?.schemaVersion === 2 && manifest?.taskId === TASK_ID
  && manifest?.contractVersion === CONTRACT_VERSION && manifest?.environment === 'staging',
'ledger contract identity is invalid');
assert(manifest.authority === 'T-024 approved authenticated read-only staging evidence only', 'ledger authority changed');
assert(manifest.discoveryTransport === 'Cloudflare REST API token through fixed read-only client', 'ledger transport changed');
assert(canonicalJson(manifest.evidence?.acceptanceVariance) === canonicalJson(REST_METADATA_VARIANCE),
  'ledger does not contain the exact proposed REST metadata variance');
assert(manifest.evidence?.credential?.present === true
  && manifest.evidence?.credential?.tokenCaptured === false
  && manifest.evidence?.credential?.scopeInspected === true
  && manifest.evidence?.credential?.pinnedAccountIncluded === true
  && ['read-only', 'write-capable-or-broad'].includes(manifest.evidence?.credential?.permissionRisk),
'ledger lacks fail-closed current-token scope evidence');
assert(manifest.evidence?.account?.authenticated === true && manifest.evidence?.account?.targetAccountPresent === true,
  'ledger lacks authenticated pinned-account evidence');
assert(manifest.productionCommandsExecuted === 0 && manifest.remoteMutationsExecuted === 0
  && manifest.secretsCaptured === false && manifest.mutationAllowed === false,
'ledger violates the zero-mutation or secret-safety boundary');
assert(Array.isArray(manifest.requestLog) && manifest.requestLog.length > 0, 'ledger lacks read-only request evidence');
assert(manifest.humanConfirmation === null, 'ledger already contains a human confirmation; rerun discovery to revalidate it');

const beforeApproval = evaluateStagingEvidence(manifest.configured, manifest.evidence);
assert(beforeApproval.targetFingerprint === manifest.targetFingerprint
  && beforeApproval.targetFingerprint === suppliedFingerprint,
'supplied fingerprint does not match freshly recomputed ledger evidence');
assert(canonicalJson(manifest.blockers) === canonicalJson(beforeApproval.blockers)
  && canonicalJson(manifest.checks) === canonicalJson(beforeApproval.checks),
'ledger checks differ from freshly recomputed evidence');
const nonConfigurationBlockers = beforeApproval.blockers
  .filter((blocker) => blocker?.code !== 'CONFIGURED_IDENTITIES_CONCRETE');
assert(nonConfigurationBlockers.length === 0, 'machine evidence has blockers other than the local placeholder correction');
assert(beforeApproval.resourcesVerified === true
  || (beforeApproval.blockers.length === 1 && beforeApproval.blockers[0]?.code === 'CONFIGURED_IDENTITIES_CONCRETE'),
'ledger is not ready for fingerprint-bound owner confirmation');

const humanConfirmation = {
  taskId: TASK_ID,
  targetFingerprint: suppliedFingerprint,
  approvedBy: 'human release owner',
  approvedAt: new Date().toISOString(),
  statement: CONFIRMATION_STATEMENT,
  acceptedVarianceIds: [REST_METADATA_VARIANCE_ID],
};
const afterApproval = evaluateStagingEvidence(manifest.configured, manifest.evidence, humanConfirmation);
assert(afterApproval.humanConfirmation !== null && afterApproval.mutationAllowed === false,
  'exact approval did not revalidate without mutation authority');
assert(['HUMAN_CONFIRMED_STAGING_IDENTITIES', 'HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION'].includes(afterApproval.status),
  'approval did not produce an allowed T-025 state');

const complete = afterApproval.status === 'HUMAN_CONFIRMED_STAGING_IDENTITIES';
const confirmedManifest = {
  ...manifest,
  discoveryState: complete
    ? 'READ_ONLY_EVIDENCE_HUMAN_CONFIRMED'
    : 'READ_ONLY_EVIDENCE_HUMAN_CONFIRMED_WITH_CONFIG_BLOCKER',
  ...afterApproval,
  t026Blocked: !complete,
  requiredNextAction: complete
    ? 'T-025 accepted; T-026 remains separately evidence-gated and mutation remains unauthorized.'
    : 'Replace only the staging D1/KV placeholder identities with exact proposedConfiguration values, then rerun discovery to revalidate this same approval fingerprint.',
};
atomicWriteOwnerOnly(LEDGER_PATH, confirmedManifest);

console.log(JSON.stringify({
  status: confirmedManifest.status,
  targetFingerprint: confirmedManifest.targetFingerprint,
  localConfigurationCorrectionAuthorized: confirmedManifest.localConfigurationCorrectionAuthorized,
  mutationAllowed: false,
  remoteMutationsExecuted: 0,
  output: LEDGER_PATH,
}, null, 2));

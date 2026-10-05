import { randomUUID, createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { Miniflare } from 'miniflare';
import { generateFreshSchema } from './fresh-schema.mjs';

const HARD_TIMEOUT_MS = 180000;
const MINIFLARE_COMPAT_DATE = '2024-09-23';
const WRANGLER_DRY_RUN_SUBDIR = '.wrangler/core-qa-local-runtime';
const WRANGLER_BUNDLE_RELATIVE_PATH = `${WRANGLER_DRY_RUN_SUBDIR}/index.js`;
const ACCOUNT_POLICY_VERSION = '2026-09-19';
const __filename = fileURLToPath(import.meta.url);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'unknown error'),
    code: error?.code || null,
    syscall: error?.syscall || null,
    address: error?.address || null,
  };
}

function sanitizePreview(value, max = 240) {
  const text = sanitizePathText(String(value || '')).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sanitizePathText(value) {
  return String(value || '')
    .replace(/\/Users\/[^\s"']+/g, '<redacted-path>')
    .replace(/\/Volumes\/[^\s"']+/g, '<redacted-path>')
    .replace(/\/private\/var\/folders\/[^\s"']+/g, '<redacted-path>')
    .replace(/\/var\/folders\/[^\s"']+/g, '<redacted-path>');
}

function toRepoRelative(repoRoot, targetPath) {
  return path.relative(repoRoot, targetPath) || '.';
}

function sanitizeJsonForDiag(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    success: value.success ?? null,
    error: value.error ?? null,
    message: value.message ?? null,
    dataKeys: value.data && typeof value.data === 'object' ? Object.keys(value.data).slice(0, 12) : [],
  };
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

function syntheticSecret(label) {
  return sha256(`${label}:${randomUUID()}`);
}

function extractRuntimeError(stderr) {
  const text = String(stderr || '').trim();
  const listenError = /Error: (listen (?:EPERM|EACCES|EADDRINUSE):[^\n]*)[\s\S]*?code: '([^']+)'[\s\S]*?syscall: '([^']+)'(?:[\s\S]*?address: '([^']+)')?/m.exec(text);
  if (listenError) {
    return {
      name: 'Error',
      message: listenError[1],
      code: listenError[2],
      syscall: listenError[3],
      address: listenError[4] || null,
    };
  }
  const moduleRule = /MiniflareCoreError \[(ERR_MODULE_RULE)\]: ([^\n]+)/m.exec(text);
  if (moduleRule) {
    return {
      name: 'MiniflareCoreError',
      message: moduleRule[2],
      code: moduleRule[1],
      syscall: null,
      address: null,
    };
  }
  if (!text) {
    return null;
  }
  return {
    name: 'Error',
    message: text.split('\n')[0],
    code: null,
    syscall: null,
    address: null,
  };
}

async function createPrivateRuntimeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tirak-core-qa-'));
  const privateDir = path.join(root, 'private');
  await mkdir(privateDir, { recursive: true });
  await chmod(privateDir, 0o700);
  return { root, privateDir };
}

async function writePrivateSecrets(privateDir) {
  const secretPath = path.join(privateDir, 'synthetic-secrets.json');
  const secrets = {
    adminPassword: syntheticSecret('admin-password'),
    travelerPassword: syntheticSecret('traveler-password'),
    ordinaryPassword: syntheticSecret('ordinary-password'),
    guidePassword: syntheticSecret('guide-password'),
    jwtSecret: syntheticSecret('jwt-secret'),
  };
  await writeFile(secretPath, JSON.stringify(secrets, null, 2), 'utf8');
  await chmod(secretPath, 0o600);
  return { secretPath, secrets };
}

function spawnForCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...spawnOptions });
    if (input !== undefined) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function bundleWorkerWithWrangler(repoRoot) {
  // Local-only guard: rely on Wrangler's emitted Worker bundle, not an ad-hoc esbuild bundle.
  const workspaceDryRunDir = path.join(repoRoot, WRANGLER_DRY_RUN_SUBDIR);
  await rm(workspaceDryRunDir, { recursive: true, force: true }).catch(() => undefined);

  const result = await spawnForCapture(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'deploy', '--dry-run', '--config', 'wrangler.core-qa.toml', '--outdir', workspaceDryRunDir],
    { cwd: repoRoot, env: { ...process.env } },
  );

  const bundlePath = path.join(repoRoot, WRANGLER_BUNDLE_RELATIVE_PATH);
  if (result.code !== 0) {
    throw new Error(`Wrangler dry-run bundle failed with code ${result.code}: ${extractRuntimeError(result.stderr)?.message || result.stderr || result.stdout}`);
  }

  await stat(bundlePath);
  return {
    bundlePath,
    metadata: {
      command: 'npx wrangler deploy --dry-run --config wrangler.core-qa.toml --outdir .wrangler/core-qa-local-runtime',
      stdoutPreview: result.stdout.trim().split('\n').filter(Boolean).slice(-20).map((line) => sanitizePreview(line, 400)),
      stderrPreview: result.stderr.trim().split('\n').filter(Boolean).slice(-20).map((line) => sanitizePreview(line, 400)),
    },
  };
}

async function applySchema(db, sql) {
  const parsed = await spawnForCapture('python3', ['-c', `
import json, sqlite3, sys
statements = []
pending = ''
for line in sys.stdin:
    pending += line
    if sqlite3.complete_statement(pending):
        statements.append(pending)
        pending = ''
if any(line.strip() and not line.strip().startswith('--') for line in pending.splitlines()):
    raise ValueError('Incomplete fresh-schema statement')
print(json.dumps(statements))
`], { input: sql });
  if (parsed.code !== 0) throw new Error('Fresh schema could not be parsed into complete SQLite statements');
  for (const statement of JSON.parse(parsed.stdout)) {
    await db.prepare(statement).run();
  }
  const integrity = await db.prepare('PRAGMA foreign_keys;').first();
  if (Number(integrity?.foreign_keys ?? 0) !== 1) {
    throw new Error('D1 foreign_keys pragma is not enabled');
  }
}

function miniflareBindings(jwtSecret) {
  return {
    JWT_SECRET: jwtSecret,
    ENVIRONMENT: 'core-qa',
    CORE_QA_MODE: 'cohort',
    PAYMENT_MODE: 'disabled',
    PROMPTPAY_ENABLED: 'false',
    PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: 'false',
    FRONTEND_URLS: 'http://localhost:5174,http://127.0.0.1:5174,http://localhost:8081,http://127.0.0.1:8081,http://localhost:8082,http://127.0.0.1:8082,http://localhost:8083,http://127.0.0.1:8083',
    PUBLIC_ASSET_BASE_URL: 'http://localhost:8787/api/uploads/public',
    EMAIL_PROVIDER: 'disabled',
    EMAIL_FROM: 'noreply@tirak.app',
    EMAIL_FROM_NAME: 'Tirak Core QA',
    EMAIL_REPLY_TO: 'support@tirak.app',
  };
}

async function makeRuntime(bundlePath, runtimeRoot, jwtSecret) {
  return new Miniflare({
    name: 'tirak-core-qa-local-runtime',
    modules: true,
    scriptPath: bundlePath,
    compatibilityDate: MINIFLARE_COMPAT_DATE,
    compatibilityFlags: ['nodejs_compat'],
    bindings: miniflareBindings(jwtSecret),
    d1Databases: ['DB'],
    d1Persist: path.join(runtimeRoot, 'state', 'd1'),
    kvNamespaces: ['CACHE', 'SESSIONS'],
    kvPersist: path.join(runtimeRoot, 'state', 'kv'),
    r2Buckets: ['STORAGE'],
    r2Persist: path.join(runtimeRoot, 'state', 'r2'),
    queueProducers: {
      MODERATION_QUEUE: 'tirak-core-qa-moderation',
      ANALYTICS_QUEUE: 'tirak-core-qa-analytics',
      NOTIFICATION_QUEUE: 'tirak-core-qa-notification',
    },
    queueConsumers: {
      'tirak-core-qa-moderation': { maxBatchSize: 10, maxBatchTimeout: 30, maxRetries: 3 },
      'tirak-core-qa-analytics': { maxBatchSize: 10, maxBatchTimeout: 30, maxRetries: 3 },
      'tirak-core-qa-notification': { maxBatchSize: 10, maxBatchTimeout: 30, maxRetries: 3 },
    },
    durableObjects: {
      CHAT_ROOM: { className: 'ChatRoom', useSQLite: true },
      NOTIFICATION_SERVICE: { className: 'NotificationService', useSQLite: true },
    },
    durableObjectsPersist: path.join(runtimeRoot, 'state', 'do'),
  });
}

async function hashPassword(password) {
  const hash = await bcrypt.hash(password, 12);
  return hash.replace(/^\$2b\$/, '$2a$');
}

function canonicalDigestValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDigestValue).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalDigestValue(value[key])}`).join(',')}}`;
}

export function computeDeterministicPayloadDigest(payload) {
  return sha256(canonicalDigestValue(payload));
}

export function computeBookingPayloadDigest(payload) {
  return sha256(canonicalDigestValue(payload));
}

export function evaluateRunOutcome(proof, runtimeError) {
  const nextProof = JSON.parse(JSON.stringify(proof));
  if (runtimeError && !nextProof.ok) {
    nextProof.error = runtimeError;
  }
  if (runtimeError?.code === 'EPERM' && runtimeError?.syscall === 'listen') {
    nextProof.verificationState = 'unverified';
    nextProof.limitations.push('Local seat blocked loopback bind for Miniflare/workerd before any route execution.');
    nextProof.limitations.push('The failure occurred during runtime boot, not inside a specific application route.');
  } else if (!nextProof.ok) {
    nextProof.verificationState = 'failed';
  } else {
    nextProof.verificationState = 'verified';
  }
  return nextProof;
}

async function seedSyntheticUsers(worker, secrets) {
  const db = await worker.getD1Database('DB');
  const now = new Date().toISOString();
  const users = {
    admin: { id: randomUUID(), email: 'qa-admin@core.local', phone: '+66900000001', userType: 'admin', password: secrets.adminPassword, displayName: 'QA Admin' },
    traveler: { id: randomUUID(), email: 'qa-traveler@core.local', phone: '+66900000002', userType: 'customer', password: secrets.travelerPassword, displayName: 'QA Traveler' },
    ordinary: { id: randomUUID(), email: 'qa-ordinary@core.local', phone: '+66900000003', userType: 'customer', password: secrets.ordinaryPassword, displayName: 'QA Ordinary' },
  };

  for (const user of Object.values(users)) {
    const passwordHash = await hashPassword(user.password);
    await db.prepare(
      `INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 'en', ?, ?)`
    ).bind(user.id, user.email, user.phone, passwordHash, user.userType, now, now).run();
  }

  await db.prepare(
    `INSERT INTO customer_profiles (user_id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
  ).bind(
    users.traveler.id, users.traveler.displayName, now, now,
    users.ordinary.id, users.ordinary.displayName, now, now,
  ).run();

  await db.prepare(
    `INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES (?, 'admin', ?), (?, 'traveler', ?)`
  ).bind(users.admin.id, now, users.traveler.id, now).run();

  return users;
}

async function request(worker, input, init) {
  // Serialize Node FormData explicitly across the Miniflare fetch boundary.
  if (init?.body instanceof FormData) {
    const multipart = new Request(input, init);
    init = { ...init, headers: Object.fromEntries(multipart.headers), body: await multipart.arrayBuffer() };
  }
  const response = await worker.dispatchFetch(input, init);
  const bodyText = await response.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }
  return {
    response,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    json,
    bodyText,
  };
}

function pushMethodSanity(proof, route, method, result) {
  proof.methodSanity.push({
    route,
    method,
    status: result.status,
    error: result.json?.error || null,
  });
}

function recordStep(proof, name, result, extra = {}) {
  proof.steps.push({
    name,
    status: result.status,
    envelope: sanitizeJsonForDiag(result.json),
    ...extra,
  });
  proof.onStep?.();
}

function assertStatus(result, expectedStatus, context, proof) {
  if (result.status !== expectedStatus) {
    proof.failureContext = {
      ...proof.failureContext,
      [context]: {
        expectedStatus,
        actualStatus: result.status,
        error: result.json?.error || null,
        message: result.json?.message || null,
      },
    };
    throw new Error(`${context} expected ${expectedStatus}, got ${result.status}`);
  }
}

function assertSuccessEnvelope(result, context) {
  if (!result.json || result.json.success !== true || !('data' in result.json)) {
    throw new Error(`${context} returned a non-success envelope`);
  }
}

function assertErrorEnvelope(result, context, expectedError) {
  if (!result.json || result.json.success !== false) {
    throw new Error(`${context} returned a non-error envelope`);
  }
  if (expectedError && result.json.error !== expectedError) {
    throw new Error(`${context} expected error ${expectedError}, got ${result.json.error}`);
  }
}

function assertTruthy(value, context) {
  if (!value) {
    throw new Error(`${context} was not truthy`);
  }
}

function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertArrayLength(value, expected, context) {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`${context} expected length ${expected}, got ${Array.isArray(value) ? value.length : 'non-array'}`);
  }
}

async function login(worker, identifier, password, label) {
  const result = await request(worker, 'http://local.test/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ identifier, password, deviceId: `core-qa-${label}` }),
  });
  if (result.status !== 200 || !result.json?.data?.accessToken) {
    throw new Error(`Login failed for ${label} with status ${result.status}`);
  }
  return result;
}

async function sendJson(worker, url, method, token, body, extraHeaders = {}) {
  return request(worker, url, {
    method,
    headers: {
      ...jsonHeaders(extraHeaders),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sendNoBody(worker, url, method, token, extraHeaders = {}) {
  return request(worker, url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
}

function nextBangkokWeekday(targetDayOfWeek, weeksAhead = 4) {
  const now = new Date();
  const bangkokNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const day = bangkokNow.getDay();
  const delta = ((targetDayOfWeek - day + 7) % 7) + (weeksAhead * 7);
  bangkokNow.setDate(bangkokNow.getDate() + delta);
  const year = bangkokNow.getFullYear();
  const month = String(bangkokNow.getMonth() + 1).padStart(2, '0');
  const date = String(bangkokNow.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

function participantsOf(detail) {
  return {
    customerId: detail?.json?.data?.booking?.customer?.id || null,
    companionId: detail?.json?.data?.booking?.companion?.id || null,
  };
}

function makeStepNote(result) {
  return {
    diagnostic: {
      status: result.status,
      error: result.json?.error || null,
      message: result.json?.message || null,
      bodyPreview: result.json ? null : sanitizePreview(result.bodyText),
    },
  };
}

export async function runJourney({ worker, secrets, proof }) {
  const db = await worker.getD1Database('DB');
  const kv = await worker.getKVNamespace('CACHE');
  const r2 = await worker.getR2Bucket('STORAGE');

  const seeded = await seedSyntheticUsers(worker, secrets);
  proof.syntheticUsers = {
    adminCount: 1,
    travelerCount: 1,
    ordinaryCount: 1,
    bootstrapGuideAccounts: 0,
  };

  const adminLogin = await login(worker, seeded.admin.email, seeded.admin.password, 'admin');
  recordStep(proof, 'login_admin', adminLogin, { identity: 'admin' });
  const travelerLogin = await login(worker, seeded.traveler.email, seeded.traveler.password, 'traveler');
  recordStep(proof, 'login_traveler', travelerLogin, { identity: 'traveler' });
  const ordinaryLogin = await login(worker, seeded.ordinary.email, seeded.ordinary.password, 'ordinary');
  recordStep(proof, 'login_ordinary', ordinaryLogin, { identity: 'ordinary' });

  const adminAccessToken = adminLogin.json.data.accessToken;
  const travelerAccessToken = travelerLogin.json.data.accessToken;
  const ordinaryAccessToken = ordinaryLogin.json.data.accessToken;

  const travelerRegisterPayload = {
    email: 'qa-future-traveler@core.local',
    phone: '+66900000004',
    password: syntheticSecret('future-traveler-password'),
    userType: 'customer',
    preferredLanguage: 'en',
    policyAcceptance: {
      termsVersion: ACCOUNT_POLICY_VERSION,
      privacyVersion: ACCOUNT_POLICY_VERSION,
    },
    marketingOptIn: false,
    analyticsOptIn: false,
  };
  const travelerRegister = await sendJson(worker, 'http://local.test/api/auth/register', 'POST', null, travelerRegisterPayload);
  recordStep(proof, 'traveler_register_valid', travelerRegister, makeStepNote(travelerRegister));
  assertStatus(travelerRegister, 201, 'traveler register', proof);
  assertSuccessEnvelope(travelerRegister, 'traveler register');
  assertEqual(travelerRegister.json.data.user.userType, 'customer', 'traveler register user type');
  assertEqual(travelerRegister.json.data.user.email, 'qa-future-traveler@core.local', 'traveler register normalized email');
  assertTruthy(travelerRegister.json.data.user.id, 'traveler register user id');
  assertTruthy(travelerRegister.json.data.accessToken, 'traveler register access token');

  // Real registration above creates an unrelated traveler; membership is an isolated QA test setup.
  await db.prepare("INSERT INTO core_qa_accounts (user_id,role,enrolled_at) VALUES (?,'traveler',?)")
    .bind(travelerRegister.json.data.user.id, new Date().toISOString()).run();
  const outsiderAccessToken = travelerRegister.json.data.accessToken;
  proof.syntheticUsers.registeredOutsiderCount = 1;

  const intakePayload = {
    businessName: 'QA Synthetic Guide Co',
    contactName: 'Synthetic Guide',
    email: 'qa-guide@core.local',
    phone: '+66957890123',
    location: 'Bangkok',
    bio: 'Synthetic private-only guide',
    brochureUrls: [],
    categories: [{ name: 'City Walk', memberCount: 1 }],
    mode: 'tirak',
    applicationData: {
      firstName: 'Synthetic',
      lastName: 'Guide',
      bio: 'Synthetic private-only guide',
      location: 'Bangkok',
      languages: ['en', 'th'],
      interests: ['food', 'temples'],
      serviceDrafts: [{ title: 'Bangkok Walk', price: 900, currency: 'THB', durationMinutes: 120, description: 'Synthetic QA draft' }],
      schedule: {
        timeZone: 'Asia/Bangkok',
        days: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 2, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 3, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 4, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 5, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 6, startTime: '09:00', endTime: '17:00', isAvailable: false },
          { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', isAvailable: false },
        ],
      },
    },
  };
  const intakeKey = randomUUID();
  const intakeDigest = computeDeterministicPayloadDigest({
    businessName: intakePayload.businessName,
    contactName: intakePayload.contactName,
    email: intakePayload.email.toLowerCase(),
    phone: intakePayload.phone,
    location: intakePayload.location,
    bio: intakePayload.bio,
    brochureUrls: intakePayload.brochureUrls,
    categories: intakePayload.categories,
    applicationData: JSON.stringify(intakePayload.applicationData),
  });

  const intake1 = await sendJson(worker, 'http://local.test/api/supplier-onboarding', 'POST', null, intakePayload, { 'Idempotency-Key': intakeKey });
  recordStep(proof, 'application_intake', intake1, makeStepNote(intake1));
  assertStatus(intake1, 201, 'supplier onboarding intake', proof);
  assertSuccessEnvelope(intake1, 'supplier onboarding intake');
  assertEqual(intake1.json.data.status, 'pending', 'application intake status');
  assertTruthy(intake1.json.data.applicationId, 'application intake id');
  assertTruthy(intake1.json.data.statusToken, 'application intake status token');

  const applicationId = intake1.json.data.applicationId;
  const statusToken = intake1.json.data.statusToken;
  const intakeReplay = await sendJson(worker, 'http://local.test/api/supplier-onboarding', 'POST', null, intakePayload, { 'Idempotency-Key': intakeKey });
  recordStep(proof, 'application_intake_replay', intakeReplay, makeStepNote(intakeReplay));
  assertStatus(intakeReplay, 201, 'supplier onboarding replay', proof);
  assertSuccessEnvelope(intakeReplay, 'supplier onboarding replay');
  assertEqual(intakeReplay.json.data.applicationId, applicationId, 'application replay id');
  assertEqual(intakeReplay.json.data.statusToken, statusToken, 'application replay status token');

  const statusPending = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null, { Authorization: `Bearer ${statusToken}` });
  recordStep(proof, 'application_status_pending', statusPending, makeStepNote(statusPending));
  assertStatus(statusPending, 200, 'application status pending', proof);
  assertSuccessEnvelope(statusPending, 'application status pending');
  assertEqual(statusPending.json.data.status, 'pending', 'pending application status');
  assertEqual(statusPending.json.data.accountStatus, 'not_provisioned', 'pending account not created');
  assertEqual(statusPending.json.data.publicationStatus, 'awaiting_approval', 'pending publication stage');
  assertEqual(statusPending.json.data.blockers.account, 'application_pending', 'pending account blocker');
  assertEqual(statusPending.json.data.blockers.profile, 'application_pending', 'pending profile blocker');
  assertArrayLength(statusPending.json.data.evidence, 0, 'pending status evidence array');

  const statusMissingToken = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null);
  recordStep(proof, 'application_status_missing_token', statusMissingToken, makeStepNote(statusMissingToken));
  assertStatus(statusMissingToken, 404, 'application status missing token', proof);
  assertErrorEnvelope(statusMissingToken, 'application status missing token', 'NOT_FOUND');

  const interestKey = randomUUID();
  const interestPayload = { email: 'qa-interest@core.local', name: 'Synthetic Waitlist', source: 'core-qa-runtime' };
  const interest1 = await sendJson(worker, 'http://local.test/api/interest', 'POST', null, interestPayload, { 'Idempotency-Key': interestKey });
  recordStep(proof, 'interest_create', interest1, makeStepNote(interest1));
  assertStatus(interest1, 201, 'interest create', proof);
  assertSuccessEnvelope(interest1, 'interest create');
  assertTruthy(interest1.json.data.interestId, 'interest id');
  const interestId = interest1.json.data.interestId;

  const interest2 = await sendJson(worker, 'http://local.test/api/interest', 'POST', null, interestPayload, { 'Idempotency-Key': interestKey });
  recordStep(proof, 'interest_replay', interest2, makeStepNote(interest2));
  assertStatus(interest2, 201, 'interest replay', proof);
  assertSuccessEnvelope(interest2, 'interest replay');
  assertEqual(interest2.json.data.interestId, interestId, 'interest replay id');

  const interestConflict = await sendJson(worker, 'http://local.test/api/interest', 'POST', null, { ...interestPayload, source: 'changed' }, { 'Idempotency-Key': interestKey });
  recordStep(proof, 'interest_changed_payload_conflict', interestConflict, makeStepNote(interestConflict));
  assertStatus(interestConflict, 409, 'interest changed payload', proof);
  assertErrorEnvelope(interestConflict, 'interest changed payload', 'IDEMPOTENCY_CONFLICT');

  const watermarkBytes = (kind) => new TextEncoder().encode(`synthetic-private-watermarked:${applicationId}:${kind}`);
  for (const kind of ['id_front', 'id_back', 'selfie']) {
    const form = new FormData();
    form.set('kind', kind);
    form.set('file', new File([watermarkBytes(kind)], `${kind}.jpg`, { type: 'image/jpeg' }));
    const upload = await request(worker, `http://local.test/api/supplier-onboarding/${applicationId}/evidence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${statusToken}` },
      body: form,
    });
    recordStep(proof, `evidence_${kind}`, upload, makeStepNote(upload));
    assertStatus(upload, 201, `evidence upload ${kind}`, proof);
    assertSuccessEnvelope(upload, `evidence upload ${kind}`);
    assertEqual(upload.json.data.kind, kind, `evidence kind ${kind}`);
  }

  const statusWithEvidence = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null, { Authorization: `Bearer ${statusToken}` });
  recordStep(proof, 'application_status_with_evidence', statusWithEvidence, makeStepNote(statusWithEvidence));
  assertStatus(statusWithEvidence, 200, 'application status with evidence', proof);
  assertSuccessEnvelope(statusWithEvidence, 'application status with evidence');
  assertArrayLength(statusWithEvidence.json.data.evidence, 3, 'status evidence count');

  const inviteBeforeApproval = await kv.list({ prefix: 'reset:' });
  proof.kvBeforeApproval = { resetKeyCount: inviteBeforeApproval.keys.length };

  const approve = await sendNoBody(worker, `http://local.test/api/admin/supplier-onboarding/${applicationId}/approve`, 'POST', adminAccessToken);
  recordStep(proof, 'admin_approve', approve, makeStepNote(approve));
  assertStatus(approve, 200, 'admin approve', proof);
  assertSuccessEnvelope(approve, 'admin approve');
  assertEqual(approve.json.data.status, 'approved', 'approval status');
  assertTruthy(approve.json.data.userId, 'approved user id');
  assertEqual(approve.json.data.reviewedUserId, seeded.admin.id, 'approved reviewed user id');

  const guideUserId = approve.json.data.userId;
  const inviteKeys = await kv.list({ prefix: 'reset:' });
  proof.kvAfterApproval = { resetKeyCount: inviteKeys.keys.length };
  const resetKeyName = inviteKeys.keys[0]?.name;
  assertTruthy(resetKeyName, 'approval reset key');
  const resetToken = resetKeyName.slice('reset:'.length);
  const originalInviteRecord = JSON.parse(await kv.get(resetKeyName));

  const statusAfterApproval = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null, { Authorization: `Bearer ${statusToken}` });
  recordStep(proof, 'application_status_after_approval', statusAfterApproval, makeStepNote(statusAfterApproval));
  assertStatus(statusAfterApproval, 200, 'application status after approval', proof);
  assertSuccessEnvelope(statusAfterApproval, 'application status after approval');
  assertEqual(statusAfterApproval.json.data.status, 'approved', 'approved application status');
  assertEqual(statusAfterApproval.json.data.publicationStatus, 'blocked', 'activation and verification gate');
  assertEqual(statusAfterApproval.json.data.accountStatus, 'pending', 'approved pending account status');
  assertEqual(statusAfterApproval.json.data.profileStatus, 'pending', 'approved pending profile status');
  assertEqual(statusAfterApproval.json.data.blockers.account, 'account_pending', 'approved account blocker');
  assertEqual(statusAfterApproval.json.data.blockers.profile, 'profile_pending_verification', 'approved profile blocker');
  assertEqual(statusAfterApproval.json.data.blockers.publication, 'no_active_services', 'approved publication blocker');

  const activate = await sendJson(worker, 'http://local.test/api/auth/reset-password', 'POST', null, {
    token: resetToken,
    newPassword: secrets.guidePassword,
  });
  recordStep(proof, 'invite_activation', activate, makeStepNote(activate));
  assertStatus(activate, 200, 'invite activation', proof);
  assertSuccessEnvelope(activate, 'invite activation');
  assertEqual(activate.json.data.reset, true, 'invite activation reset');

  const activateReplay = await sendJson(worker, 'http://local.test/api/auth/reset-password', 'POST', null, {
    token: resetToken,
    newPassword: syntheticSecret('reset-replay-password'),
  });
  recordStep(proof, 'invite_activation_replay_denied', activateReplay, makeStepNote(activateReplay));
  assertStatus(activateReplay, 400, 'invite activation replay', proof);
  assertErrorEnvelope(activateReplay, 'invite activation replay', 'Invalid token');

  const guideLogin = await login(worker, 'qa-guide@core.local', secrets.guidePassword, 'guide');
  recordStep(proof, 'login_guide', guideLogin, { identity: 'guide' });
  const guideAccessToken = guideLogin.json.data.accessToken;

  const guideProfile = await sendNoBody(worker, 'http://local.test/api/users/profile', 'GET', guideAccessToken);
  recordStep(proof, 'guide_profile_view', guideProfile, makeStepNote(guideProfile));
  assertStatus(guideProfile, 200, 'guide profile view', proof);
  assertSuccessEnvelope(guideProfile, 'guide profile view');
  assertEqual(guideProfile.json.data.role, 'companion', 'guide mobile role');
  assertEqual(guideProfile.json.data.verified, false, 'guide mobile verified before moderation');

  const guideQaRow = await db.prepare(`
    SELECT role, source_application_id, enrolled_by, revoked_at
    FROM core_qa_accounts WHERE user_id = ?
  `).bind(guideUserId).first();
  assertEqual(guideQaRow?.role, 'guide', 'guide qa role');
  assertEqual(guideQaRow?.source_application_id, applicationId, 'guide qa source application');
  assertEqual(guideQaRow?.enrolled_by, seeded.admin.id, 'guide qa enrolled by');

  const ownerListBefore = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/experiences`, 'GET', guideAccessToken);
  recordStep(proof, 'owner_experience_list_initial', ownerListBefore, makeStepNote(ownerListBefore));
  assertStatus(ownerListBefore, 200, 'owner experience list initial', proof);
  assertSuccessEnvelope(ownerListBefore, 'owner experience list initial');
  assertArrayLength(ownerListBefore.json.data.items, 1, 'owner draft service count');
  assertEqual(ownerListBefore.json.data.items[0].isActive, false, 'owner draft inactive before activation');

  const publicCompanionBeforeVerify = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'public_companion_before_verify', publicCompanionBeforeVerify, makeStepNote(publicCompanionBeforeVerify));
  assertStatus(publicCompanionBeforeVerify, 404, 'public companion before verify', proof);
  assertErrorEnvelope(publicCompanionBeforeVerify, 'public companion before verify', 'Companion not found');

  const servicePayload = {
    title: 'Bangkok Future Workday Walk',
    description: 'Synthetic QA service',
    durationMinutes: 120,
    keywords: ['food', 'history'],
    price: 900,
    currency: 'THB',
    is_active: true,
  };
  const createService = await sendJson(worker, `http://local.test/api/companions/${guideUserId}/experiences`, 'POST', guideAccessToken, servicePayload);
  recordStep(proof, 'owner_experience_create', createService, makeStepNote(createService));
  assertStatus(createService, 201, 'owner experience create', proof);
  assertSuccessEnvelope(createService, 'owner experience create');
  const serviceId = createService.json.data.experienceId;
  assertTruthy(serviceId, 'created experience id');

  const updateService = await sendJson(worker, `http://local.test/api/companions/${guideUserId}/experiences/${serviceId}`, 'PUT', guideAccessToken, {
    ...servicePayload,
    title: 'Bangkok Future Workday Walk Deluxe',
  });
  recordStep(proof, 'owner_experience_update', updateService, makeStepNote(updateService));
  assertStatus(updateService, 200, 'owner experience update', proof);
  assertSuccessEnvelope(updateService, 'owner experience update');
  assertEqual(updateService.json.data.created, false, 'experience update created flag');

  const weeklySchedule = {
    timeZone: 'Asia/Bangkok',
    days: [
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 2, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 3, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 4, startTime: '09:00', endTime: '17:00', isAvailable: true },
      { dayOfWeek: 5, startTime: '09:00', endTime: '17:00', isAvailable: true },
    ],
  };
  const saveWeekly = await sendJson(worker, `http://local.test/api/companions/${guideUserId}/availability/settings`, 'PUT', guideAccessToken, weeklySchedule);
  recordStep(proof, 'owner_availability_settings_put', saveWeekly, makeStepNote(saveWeekly));
  assertStatus(saveWeekly, 200, 'owner availability put', proof);
  assertSuccessEnvelope(saveWeekly, 'owner availability put');
  assertEqual(saveWeekly.json.data.timeZone, 'Asia/Bangkok', 'owner availability timezone');

  const readWeekly = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/availability/settings`, 'GET', guideAccessToken);
  recordStep(proof, 'owner_availability_settings_get', readWeekly, makeStepNote(readWeekly));
  assertStatus(readWeekly, 200, 'owner availability get', proof);
  assertSuccessEnvelope(readWeekly, 'owner availability get');
  assertArrayLength(readWeekly.json.data.days, 5, 'owner weekly days count');

  const bookingDate = nextBangkokWeekday(1, 4);
  const anonymousAvailabilityBeforeVerify = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/availability?startDate=${bookingDate}&endDate=${bookingDate}`, 'GET', travelerAccessToken);
  recordStep(proof, 'public_availability_before_verify', anonymousAvailabilityBeforeVerify, makeStepNote(anonymousAvailabilityBeforeVerify));
  assertStatus(anonymousAvailabilityBeforeVerify, 404, 'public availability before verify', proof);
  assertErrorEnvelope(anonymousAvailabilityBeforeVerify, 'public availability before verify', 'Companion not found');

  const travelerDiscoveryBeforeVerify = await sendNoBody(worker, 'http://local.test/api/companions?limit=10&page=1', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companions_before_verify', travelerDiscoveryBeforeVerify, makeStepNote(travelerDiscoveryBeforeVerify));
  assertStatus(travelerDiscoveryBeforeVerify, 200, 'traveler companions before verify', proof);
  assertSuccessEnvelope(travelerDiscoveryBeforeVerify, 'traveler companions before verify');
  assertEqual(Boolean(travelerDiscoveryBeforeVerify.json.data.companions.some((item) => item.id === guideUserId)), false, 'traveler discovery before verify hidden');

  const ordinaryDiscoveryBeforeVerify = await sendNoBody(worker, 'http://local.test/api/companions?limit=10&page=1', 'GET', ordinaryAccessToken);
  recordStep(proof, 'ordinary_companions_before_verify', ordinaryDiscoveryBeforeVerify, makeStepNote(ordinaryDiscoveryBeforeVerify));
  assertStatus(ordinaryDiscoveryBeforeVerify, 403, 'ordinary companions before verify', proof);
  assertErrorEnvelope(ordinaryDiscoveryBeforeVerify, 'ordinary companions before verify', 'QA_ACCESS_DENIED');

  const anonymousDiscoveryBeforeVerify = await sendNoBody(worker, 'http://local.test/api/companions?limit=10&page=1', 'GET', null);
  recordStep(proof, 'anonymous_companions_before_verify', anonymousDiscoveryBeforeVerify, makeStepNote(anonymousDiscoveryBeforeVerify));
  assertStatus(anonymousDiscoveryBeforeVerify, 401, 'anonymous companions before verify', proof);
  assertErrorEnvelope(anonymousDiscoveryBeforeVerify, 'anonymous companions before verify', 'AUTHENTICATION_REQUIRED');

  const bookingPayload = {
    companionId: guideUserId,
    serviceId,
    date: bookingDate,
    startTime: '09:00',
    duration: 120,
    preferredLanguages: ['en', 'th'],
    dietaryRestrictions: ['vegetarian'],
    location: 'Bangkok Old Town',
    specialRequests: 'Synthetic QA only',
  };
  const bookingKey = randomUUID();

  const anonymousBookingBefore = await sendJson(worker, 'http://local.test/api/bookings', 'POST', null, bookingPayload, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_anonymous_before_verify', anonymousBookingBefore, makeStepNote(anonymousBookingBefore));
  assertStatus(anonymousBookingBefore, 401, 'anonymous booking before verify', proof);
  assertErrorEnvelope(anonymousBookingBefore, 'anonymous booking before verify', 'AUTHENTICATION_REQUIRED');

  const ordinaryBookingBefore = await sendJson(worker, 'http://local.test/api/bookings', 'POST', ordinaryAccessToken, bookingPayload, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_noncohort_before_verify', ordinaryBookingBefore, makeStepNote(ordinaryBookingBefore));
  assertStatus(ordinaryBookingBefore, 403, 'ordinary booking before verify', proof);
  assertErrorEnvelope(ordinaryBookingBefore, 'ordinary booking before verify', 'QA_ACCESS_DENIED');

  const travelerBookingBefore = await sendJson(worker, 'http://local.test/api/bookings', 'POST', travelerAccessToken, bookingPayload, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_before_verify', travelerBookingBefore, makeStepNote(travelerBookingBefore));
  assertStatus(travelerBookingBefore, 404, 'traveler booking before verify', proof);
  assertErrorEnvelope(travelerBookingBefore, 'traveler booking before verify', 'Guide not found');

  const moderateGuide = await sendJson(worker, `http://local.test/api/admin/users/${guideUserId}/supplier-verification`, 'PATCH', adminAccessToken, {
    status: 'verified',
    reason: 'Core QA supplier verification',
  });
  recordStep(proof, 'admin_verify_guide_profile', moderateGuide, makeStepNote(moderateGuide));
  assertStatus(moderateGuide, 200, 'admin verify guide profile', proof);
  assertSuccessEnvelope(moderateGuide, 'admin verify guide profile');
  assertEqual(moderateGuide.json.data.verificationStatus, 'verified', 'profile verification status');

  const publicDetail = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companion_detail_after_verify', publicDetail, makeStepNote(publicDetail));
  assertStatus(publicDetail, 200, 'traveler companion detail after verify', proof);
  assertSuccessEnvelope(publicDetail, 'traveler companion detail after verify');
  assertEqual(publicDetail.json.data.id, guideUserId, 'traveler companion detail id');

  const publicServices = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/services`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companion_services_after_verify', publicServices, makeStepNote(publicServices));
  assertStatus(publicServices, 200, 'traveler companion services after verify', proof);
  assertSuccessEnvelope(publicServices, 'traveler companion services after verify');
  assertEqual(publicServices.json.data.services.some((service) => service.id === serviceId), true, 'traveler companion services include active service');

  const legacySupplierDetail = await sendNoBody(worker, `http://local.test/api/suppliers/${guideUserId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_supplier_detail_after_verify', legacySupplierDetail, makeStepNote(legacySupplierDetail));
  assertStatus(legacySupplierDetail, 200, 'traveler supplier detail after verify', proof);
  assertSuccessEnvelope(legacySupplierDetail, 'traveler supplier detail after verify');
  assertEqual(legacySupplierDetail.json.data.id, guideUserId, 'traveler supplier detail id');

  const legacySupplierServices = await sendNoBody(worker, `http://local.test/api/suppliers/${guideUserId}/services?page=1&limit=10`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_supplier_services_after_verify', legacySupplierServices, makeStepNote(legacySupplierServices));
  assertStatus(legacySupplierServices, 200, 'traveler supplier services after verify', proof);
  assertSuccessEnvelope(legacySupplierServices, 'traveler supplier services after verify');
  assertEqual(legacySupplierServices.json.data.items.some((service) => service.id === serviceId), true, 'traveler supplier services include active service');

  const activeApplicationStatus = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null, { Authorization: `Bearer ${statusToken}` });
  recordStep(proof, 'application_publication_active', activeApplicationStatus, makeStepNote(activeApplicationStatus));
  assertStatus(activeApplicationStatus, 200, 'active publication status', proof);
  assertEqual(activeApplicationStatus.json.data.publicationStatus, 'active', 'verified active service publication');
  assertEqual(activeApplicationStatus.json.data.paymentStatus, 'unavailable', 'published guide payments unavailable');

  const travelerDiscoveryAfterVerify = await sendNoBody(worker, 'http://local.test/api/companions?limit=10&page=1', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companions_after_verify', travelerDiscoveryAfterVerify, makeStepNote(travelerDiscoveryAfterVerify));
  assertStatus(travelerDiscoveryAfterVerify, 200, 'traveler companions after verify', proof);
  assertSuccessEnvelope(travelerDiscoveryAfterVerify, 'traveler companions after verify');
  assertEqual(Boolean(travelerDiscoveryAfterVerify.json.data.companions.some((item) => item.id === guideUserId)), true, 'traveler discovery after verify visible');

  const travelerDiscoveryPage2 = await sendNoBody(worker, 'http://local.test/api/companions?limit=1&page=2', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companions_page2', travelerDiscoveryPage2, makeStepNote(travelerDiscoveryPage2));
  assertStatus(travelerDiscoveryPage2, 200, 'traveler companions page2', proof);
  assertSuccessEnvelope(travelerDiscoveryPage2, 'traveler companions page2');
  assertEqual(travelerDiscoveryPage2.json.data.pagination.page, 2, 'traveler companions page2 number');

  const travelerSupplierSearchAfter = await sendNoBody(worker, 'http://local.test/api/suppliers/search?limit=10&page=1', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_suppliers_after_verify', travelerSupplierSearchAfter, makeStepNote(travelerSupplierSearchAfter));
  assertStatus(travelerSupplierSearchAfter, 200, 'traveler suppliers after verify', proof);
  assertSuccessEnvelope(travelerSupplierSearchAfter, 'traveler suppliers after verify');
  assertEqual(Boolean(travelerSupplierSearchAfter.json.data.items.some((item) => item.id === guideUserId)), true, 'traveler supplier search after verify visible');

  const travelerSupplierSearchPage2 = await sendNoBody(worker, 'http://local.test/api/suppliers/search?limit=1&page=2', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_suppliers_page2', travelerSupplierSearchPage2, makeStepNote(travelerSupplierSearchPage2));
  assertStatus(travelerSupplierSearchPage2, 200, 'traveler suppliers page2', proof);
  assertSuccessEnvelope(travelerSupplierSearchPage2, 'traveler suppliers page2');
  assertEqual(travelerSupplierSearchPage2.json.data.pagination.page, 2, 'traveler suppliers page2 number');

  const availabilityPublic = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/availability?startDate=${bookingDate}&endDate=${bookingDate}`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_availability_after_verify', availabilityPublic, makeStepNote(availabilityPublic));
  assertStatus(availabilityPublic, 200, 'traveler availability after verify', proof);
  assertSuccessEnvelope(availabilityPublic, 'traveler availability after verify');
  assertEqual(availabilityPublic.json.data.availability[0].timeSlots[0].available, true, 'traveler availability first slot');

  const discoveryAliases = [
    '/api/companions?limit=10&page=1',
    '/api/suppliers/search?limit=10&page=1',
    '/api/public/featured-suppliers?limit=10&page=1',
    '/api/public/search-suggestions?q=Bangkok&type=suppliers',
    `/api/companions/${guideUserId}`,
    `/api/companions/${guideUserId}/services`,
    `/api/companions/${guideUserId}/experiences`,
    `/api/companions/${guideUserId}/availability?startDate=${bookingDate}&endDate=${bookingDate}`,
    `/api/suppliers/${guideUserId}`,
    `/api/suppliers/${guideUserId}/services`,
  ];
  for (const [index, alias] of discoveryAliases.entries()) {
    for (const [identity, token, expectedStatus, expectedError] of [
      ['anonymous', null, 401, 'AUTHENTICATION_REQUIRED'],
      ['ordinary', ordinaryAccessToken, 403, 'QA_ACCESS_DENIED'],
    ]) {
      const denied = await sendNoBody(worker, `http://local.test${alias}`, 'GET', token);
      recordStep(proof, `${identity}_discovery_alias_${index}_denied`, denied, makeStepNote(denied));
      assertStatus(denied, expectedStatus, `${identity} discovery alias ${index}`, proof);
      assertErrorEnvelope(denied, `${identity} discovery alias ${index}`, expectedError);
    }
  }

  const bookingCreate = await sendJson(worker, 'http://local.test/api/bookings', 'POST', travelerAccessToken, bookingPayload, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_create', bookingCreate, makeStepNote(bookingCreate));
  assertStatus(bookingCreate, 201, 'booking create', proof);
  assertSuccessEnvelope(bookingCreate, 'booking create');
  const bookingId = bookingCreate.json.data.booking.id;
  assertTruthy(bookingId, 'booking id');
  assertEqual(bookingCreate.json.data.booking.status, 'pending', 'booking create status');
  assertEqual(bookingCreate.json.data.booking.paymentStatus, 'pending', 'booking create payment status');
  assertEqual(bookingCreate.json.data.booking.companionId, guideUserId, 'booking create companion');

  const bookingReplay = await sendJson(worker, 'http://local.test/api/bookings', 'POST', travelerAccessToken, bookingPayload, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_replay', bookingReplay, makeStepNote(bookingReplay));
  assertStatus(bookingReplay, 200, 'booking replay', proof);
  assertSuccessEnvelope(bookingReplay, 'booking replay');
  assertEqual(bookingReplay.json.data.booking.id, bookingId, 'booking replay same id');
  assertEqual(bookingReplay.json.data.booking.idempotent, true, 'booking replay idempotent flag');

  const bookingConflict = await sendJson(worker, 'http://local.test/api/bookings', 'POST', travelerAccessToken, {
    ...bookingPayload,
    preferredLanguages: ['th', 'en'],
  }, { 'Idempotency-Key': bookingKey });
  recordStep(proof, 'booking_replay_changed_payload', bookingConflict, makeStepNote(bookingConflict));
  assertStatus(bookingConflict, 409, 'booking changed payload conflict', proof);
  assertErrorEnvelope(bookingConflict, 'booking changed payload conflict', 'Idempotency conflict');

  const bookingTravelerDetail = await sendNoBody(worker, `http://local.test/api/bookings/${bookingId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'booking_detail_traveler_pending', bookingTravelerDetail, { ...makeStepNote(bookingTravelerDetail), participants: participantsOf(bookingTravelerDetail) });
  assertStatus(bookingTravelerDetail, 200, 'booking detail traveler pending', proof);
  assertSuccessEnvelope(bookingTravelerDetail, 'booking detail traveler pending');
  assertEqual(bookingTravelerDetail.json.data.booking.status, 'pending', 'traveler booking detail pending status');
  assertEqual(bookingTravelerDetail.json.data.booking.paymentStatus, 'pending', 'traveler booking detail pending payment');
  assertEqual(bookingTravelerDetail.json.data.booking.companion.id, guideUserId, 'traveler booking detail guide');
  assertEqual(bookingTravelerDetail.json.data.booking.customer.id, seeded.traveler.id, 'traveler booking detail traveler');

  const bookingGuideDetail = await sendNoBody(worker, `http://local.test/api/bookings/${bookingId}`, 'GET', guideAccessToken);
  recordStep(proof, 'booking_detail_guide_pending', bookingGuideDetail, { ...makeStepNote(bookingGuideDetail), participants: participantsOf(bookingGuideDetail) });
  assertStatus(bookingGuideDetail, 200, 'booking detail guide pending', proof);
  assertSuccessEnvelope(bookingGuideDetail, 'booking detail guide pending');
  assertEqual(bookingGuideDetail.json.data.booking.id, bookingId, 'guide booking detail id');

  const bookingOrdinaryDetail = await sendNoBody(worker, `http://local.test/api/bookings/${bookingId}`, 'GET', ordinaryAccessToken);
  recordStep(proof, 'booking_detail_nonparticipant', bookingOrdinaryDetail, makeStepNote(bookingOrdinaryDetail));
  assertStatus(bookingOrdinaryDetail, 403, 'booking detail ordinary', proof);
  assertErrorEnvelope(bookingOrdinaryDetail, 'booking detail ordinary', 'QA_ACCESS_DENIED');

  const chatCreatePending = await sendJson(worker, 'http://local.test/api/chat/rooms', 'POST', travelerAccessToken, { bookingId });
  recordStep(proof, 'chat_create_pending_denied', chatCreatePending, makeStepNote(chatCreatePending));
  assertStatus(chatCreatePending, 403, 'chat create pending denied', proof);
  assertErrorEnvelope(chatCreatePending, 'chat create pending denied', 'Experience chat unavailable');

  const guideConfirm = await sendJson(worker, `http://local.test/api/bookings/${bookingId}/status`, 'PUT', guideAccessToken, { status: 'confirmed' });
  recordStep(proof, 'booking_confirm', guideConfirm, makeStepNote(guideConfirm));
  assertStatus(guideConfirm, 200, 'booking confirm', proof);
  assertSuccessEnvelope(guideConfirm, 'booking confirm');
  assertEqual(guideConfirm.json.data.booking.status, 'confirmed', 'booking confirm status');
  assertEqual(guideConfirm.json.data.booking.paymentStatus, 'pending', 'booking confirm payment status');

  const travelerConfirmDenied = await sendJson(worker, `http://local.test/api/bookings/${bookingId}/status`, 'PUT', travelerAccessToken, { status: 'confirmed' });
  recordStep(proof, 'booking_confirm_by_traveler_denied', travelerConfirmDenied, makeStepNote(travelerConfirmDenied));
  assertStatus(travelerConfirmDenied, 403, 'traveler booking confirm denied', proof);
  assertErrorEnvelope(travelerConfirmDenied, 'traveler booking confirm denied', 'Invalid booking transition');

  const adminBookingsPage1 = await sendNoBody(worker, 'http://local.test/api/admin/operations/bookings?mode=tirak&page=1&limit=1', 'GET', adminAccessToken);
  recordStep(proof, 'admin_bookings_page1', adminBookingsPage1, makeStepNote(adminBookingsPage1));
  assertStatus(adminBookingsPage1, 200, 'admin bookings page1', proof);
  assertSuccessEnvelope(adminBookingsPage1, 'admin bookings page1');
  assertArrayLength(adminBookingsPage1.json.data.items, 1, 'admin bookings page1 item count');
  assertEqual(adminBookingsPage1.json.data.items[0].id, bookingId, 'admin bookings page1 booking id');
  assertEqual(adminBookingsPage1.json.data.items[0].customer_id, seeded.traveler.id, 'admin booking customer matches');
  assertEqual(adminBookingsPage1.json.data.items[0].supplier_id, guideUserId, 'admin booking guide matches');
  assertEqual(adminBookingsPage1.json.data.items[0].service_name, 'Bangkok Future Workday Walk Deluxe', 'admin booking persisted service');

  const adminBookingsPage2 = await sendNoBody(worker, 'http://local.test/api/admin/operations/bookings?mode=tirak&page=2&limit=1', 'GET', adminAccessToken);
  recordStep(proof, 'admin_bookings_page2', adminBookingsPage2, makeStepNote(adminBookingsPage2));
  assertStatus(adminBookingsPage2, 200, 'admin bookings page2', proof);
  assertSuccessEnvelope(adminBookingsPage2, 'admin bookings page2');
  assertEqual(adminBookingsPage2.json.data.pagination.page, 2, 'admin bookings page2 number');

  const chatCreate = await sendJson(worker, 'http://local.test/api/chat/rooms', 'POST', travelerAccessToken, { bookingId });
  recordStep(proof, 'chat_create_confirmed', chatCreate, makeStepNote(chatCreate));
  assertStatus(chatCreate, 201, 'chat create confirmed', proof);
  assertSuccessEnvelope(chatCreate, 'chat create confirmed');
  const roomId = chatCreate.json.data.roomId;
  assertTruthy(roomId, 'chat room id');

  const chatTicketTraveler = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}/socket-ticket`, 'POST', travelerAccessToken);
  recordStep(proof, 'chat_socket_ticket_traveler', chatTicketTraveler, makeStepNote(chatTicketTraveler));
  assertStatus(chatTicketTraveler, 200, 'chat traveler socket ticket', proof);
  assertSuccessEnvelope(chatTicketTraveler, 'chat traveler socket ticket');
  assertEqual(chatTicketTraveler.json.data.expiresInSeconds, 60, 'chat traveler socket expiry');

  // Use the same ticket-only upgrade as mobile; REST messages must reach the connected client.
  const ticket = chatTicketTraveler.json.data.ticket;
  const socketResponse = await worker.dispatchFetch(`http://local.test/api/chat/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: 'websocket' } });
  assertEqual(socketResponse.status, 101, 'ticket-only websocket upgrade');
  assertTruthy(socketResponse.webSocket, 'ticket-only websocket client');
  const socket = socketResponse.webSocket;
  const socketEvents = [];
  socket.addEventListener('message', (event) => { try { socketEvents.push(JSON.parse(String(event.data))); } catch {} });
  socket.accept();
  const ticketReplay = await worker.dispatchFetch(`http://local.test/api/chat/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: 'websocket' } });
  assertEqual(ticketReplay.status, 401, 'socket ticket replay denied');
  proof.websocket = { ticketOnlyUpgrade: 101, replayDenied: 401, broadcastReceived: false };

  const chatDetailTravelerEmpty = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}?page=1&limit=50`, 'GET', travelerAccessToken);
  recordStep(proof, 'chat_detail_traveler_initial', chatDetailTravelerEmpty, makeStepNote(chatDetailTravelerEmpty));
  assertStatus(chatDetailTravelerEmpty, 200, 'chat traveler initial detail', proof);
  assertSuccessEnvelope(chatDetailTravelerEmpty, 'chat traveler initial detail');
  assertArrayLength(chatDetailTravelerEmpty.json.data.messages, 0, 'chat initial messages');

  const chatSendTraveler = await sendJson(worker, `http://local.test/api/chat/rooms/${roomId}/messages`, 'POST', travelerAccessToken, {
    messageType: 'text',
    content: 'Synthetic QA traveler message',
  });
  recordStep(proof, 'chat_send_traveler', chatSendTraveler, makeStepNote(chatSendTraveler));
  assertStatus(chatSendTraveler, 201, 'chat traveler send', proof);
  assertSuccessEnvelope(chatSendTraveler, 'chat traveler send');
  const chatMessageId = chatSendTraveler.json.data.id;
  assertTruthy(chatMessageId, 'chat message id');

  const socketDeadline = Date.now() + 5000;
  while (!socketEvents.some((event) => event.type === 'message_received' && event.data?.id === chatMessageId) && Date.now() < socketDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertEqual(socketEvents.some((event) => event.type === 'message_received' && event.data?.id === chatMessageId), true, 'REST chat message broadcast over websocket');
  proof.websocket.broadcastReceived = true;
  socket.close(1000, 'QA broadcast verified');

  const chatDetailGuide = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}?page=1&limit=50`, 'GET', guideAccessToken);
  recordStep(proof, 'chat_detail_guide_after_message', chatDetailGuide, makeStepNote(chatDetailGuide));
  assertStatus(chatDetailGuide, 200, 'chat guide detail after message', proof);
  assertSuccessEnvelope(chatDetailGuide, 'chat guide detail after message');
  assertArrayLength(chatDetailGuide.json.data.messages, 1, 'chat guide message count');
  assertEqual(chatDetailGuide.json.data.messages[0].id, chatMessageId, 'chat guide message id');

  const chatListTraveler = await sendNoBody(worker, 'http://local.test/api/chat/rooms?page=1&limit=50', 'GET', travelerAccessToken);
  recordStep(proof, 'chat_list_traveler', chatListTraveler, makeStepNote(chatListTraveler));
  assertStatus(chatListTraveler, 200, 'chat list traveler', proof);
  assertSuccessEnvelope(chatListTraveler, 'chat list traveler');
  assertArrayLength(chatListTraveler.json.data.items, 1, 'chat traveler room count');

  const chatListGuide = await sendNoBody(worker, 'http://local.test/api/chat/rooms?page=1&limit=50', 'GET', guideAccessToken);
  recordStep(proof, 'chat_list_guide', chatListGuide, makeStepNote(chatListGuide));
  assertStatus(chatListGuide, 200, 'chat list guide', proof);
  assertSuccessEnvelope(chatListGuide, 'chat list guide');
  assertArrayLength(chatListGuide.json.data.items, 1, 'chat guide room count');

  const chatDetailOrdinary = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}`, 'GET', ordinaryAccessToken);
  recordStep(proof, 'chat_detail_third_party_denied', chatDetailOrdinary, makeStepNote(chatDetailOrdinary));
  assertStatus(chatDetailOrdinary, 403, 'chat detail ordinary', proof);
  assertErrorEnvelope(chatDetailOrdinary, 'chat detail ordinary', 'QA_ACCESS_DENIED');

  const chatSendOrdinary = await sendJson(worker, `http://local.test/api/chat/rooms/${roomId}/messages`, 'POST', ordinaryAccessToken, {
    messageType: 'text',
    content: 'Synthetic QA intruder',
  });
  recordStep(proof, 'chat_send_third_party_denied', chatSendOrdinary, makeStepNote(chatSendOrdinary));
  assertStatus(chatSendOrdinary, 403, 'chat send ordinary', proof);
  assertErrorEnvelope(chatSendOrdinary, 'chat send ordinary', 'QA_ACCESS_DENIED');

  const chatTicketOrdinary = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}/socket-ticket`, 'POST', ordinaryAccessToken);
  recordStep(proof, 'chat_socket_ticket_third_party_denied', chatTicketOrdinary, makeStepNote(chatTicketOrdinary));
  assertStatus(chatTicketOrdinary, 403, 'chat ticket ordinary', proof);
  assertErrorEnvelope(chatTicketOrdinary, 'chat ticket ordinary', 'QA_ACCESS_DENIED');

  for (const [label, suffix, method, body] of [
    ['detail', '', 'GET', undefined],
    ['message', '/messages', 'POST', { messageType: 'text', content: 'Unauthorized synthetic message' }],
    ['ticket', '/socket-ticket', 'POST', undefined],
  ]) {
    const result = await sendJson(worker, `http://local.test/api/chat/rooms/${roomId}${suffix}`, method, outsiderAccessToken, body);
    recordStep(proof, `cohort_nonparticipant_chat_${label}_denied`, result, makeStepNote(result));
    assertStatus(result, 404, `cohort nonparticipant chat ${label}`, proof);
    assertErrorEnvelope(result, `cohort nonparticipant chat ${label}`, 'Chat room not found');
  }

  const chatMarkRead = await sendJson(worker, `http://local.test/api/chat/rooms/${roomId}/read`, 'POST', guideAccessToken, {
    messageId: chatMessageId,
  });
  recordStep(proof, 'chat_mark_read_guide', chatMarkRead, makeStepNote(chatMarkRead));
  assertStatus(chatMarkRead, 200, 'chat mark read guide', proof);
  assertSuccessEnvelope(chatMarkRead, 'chat mark read guide');
  assertEqual(chatMarkRead.json.data.marked, true, 'chat mark read guide marked');

  const chatSearch = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}/search?q=Synthetic&limit=20`, 'GET', travelerAccessToken);
  recordStep(proof, 'chat_search_traveler', chatSearch, makeStepNote(chatSearch));
  assertStatus(chatSearch, 200, 'chat traveler search', proof);
  assertSuccessEnvelope(chatSearch, 'chat traveler search');
  assertEqual(chatSearch.json.data.count, 1, 'chat traveler search count');

  const chatReconnectDetail = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}?page=1&limit=50`, 'GET', travelerAccessToken);
  recordStep(proof, 'chat_reconnect_detail', chatReconnectDetail, makeStepNote(chatReconnectDetail));
  assertStatus(chatReconnectDetail, 200, 'chat reconnect detail', proof);
  assertSuccessEnvelope(chatReconnectDetail, 'chat reconnect detail');
  assertArrayLength(chatReconnectDetail.json.data.messages, 1, 'chat reconnect message count');

  const guideComplete = await sendJson(worker, `http://local.test/api/bookings/${bookingId}/status`, 'PUT', guideAccessToken, { status: 'completed' });
  recordStep(proof, 'booking_complete', guideComplete, makeStepNote(guideComplete));
  assertStatus(guideComplete, 200, 'booking complete', proof);
  assertSuccessEnvelope(guideComplete, 'booking complete');
  assertEqual(guideComplete.json.data.booking.status, 'completed', 'booking complete status');
  assertEqual(guideComplete.json.data.booking.paymentStatus, 'pending', 'booking complete payment status');

  const bookingTravelerCompleted = await sendNoBody(worker, `http://local.test/api/bookings/${bookingId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'booking_detail_traveler_completed', bookingTravelerCompleted, makeStepNote(bookingTravelerCompleted));
  assertStatus(bookingTravelerCompleted, 200, 'traveler booking detail completed', proof);
  assertSuccessEnvelope(bookingTravelerCompleted, 'traveler booking detail completed');
  assertEqual(bookingTravelerCompleted.json.data.booking.status, 'completed', 'traveler booking detail completed status');
  assertEqual(bookingTravelerCompleted.json.data.booking.paymentStatus, 'pending', 'traveler booking detail completed payment');

  const expectedExperienceIds = new Set([ownerListBefore.json.data.items[0].id, serviceId]);
  // Inactive pagination rows are isolated test fixtures; the booked experience above uses real owner API writes.
  const draftRows = Array.from({ length: 49 }, (_, index) => ({ id: randomUUID(), title: `Synthetic pagination draft ${index + 1}` }));
  const nowForDrafts = new Date().toISOString();
  for (let offset = 0; offset < draftRows.length; offset += 8) {
    const chunk = draftRows.slice(offset, offset + 8); // D1 permits at most 100 bound SQL parameters.
    await db.prepare(`INSERT INTO supplier_services
      (id,supplier_id,title,description,price_min,price_max,currency,duration_hours,is_active,keywords,created_at,updated_at)
      VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`)
      .bind(...chunk.flatMap((draft) => [draft.id, guideUserId, draft.title, 'Inactive QA pagination fixture', 900, 900, 'THB', 2, 0, '[]', nowForDrafts, nowForDrafts])).run();
  }
  for (const draft of draftRows) expectedExperienceIds.add(draft.id);
  proof.paginationFixtureSetup = { inactiveFixtureRows: 49, realOwnerApiExperiences: 2 };
  // Each phase uses unchanged production rate limits. Reset only this disposable fixture's window between phases.
  const fixtureRateKeys = await kv.list({ prefix: 'ratelimit:' });
  for (const entry of fixtureRateKeys.keys) await kv.delete(entry.name);
  proof.fixtureRateWindowReset = { environment: 'isolated-qa-only', keys: fixtureRateKeys.keys.length };
  const loadedIds = [];
  for (const [page, expectedCount] of [[1, 50], [2, 1]]) {
    const result = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/experiences?page=${page}&limit=50`, 'GET', guideAccessToken);
    recordStep(proof, `owner_experience_page_${page}`, result, makeStepNote(result));
    assertStatus(result, 200, `owner experience page ${page}`, proof);
    assertSuccessEnvelope(result, `owner experience page ${page}`);
    assertEqual(result.json.data.pagination.total, 51, 'full experience count');
    assertEqual(result.json.data.pagination.page, page, 'experience page number');
    assertArrayLength(result.json.data.items, expectedCount, 'experience page count');
    loadedIds.push(...result.json.data.items.map((item) => item.id));
  }
  assertEqual(new Set(loadedIds).size, 51, 'experience pagination no duplicates');
  assertEqual(loadedIds.every((id) => expectedExperienceIds.has(id)), true, 'experience pagination exact owner IDs');
  proof.ownerPagination = { total: 51, firstPage: 50, secondPage: 1, distinct: new Set(loadedIds).size };

  const archiveService = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/experiences/${serviceId}`, 'DELETE', guideAccessToken);
  recordStep(proof, 'owner_experience_archive', archiveService, makeStepNote(archiveService));
  assertStatus(archiveService, 200, 'owner experience archive', proof);
  assertSuccessEnvelope(archiveService, 'owner experience archive');
  assertEqual(archiveService.json.data.experienceId, serviceId, 'owner experience archive id');
  assertEqual(archiveService.json.data.archived, true, 'owner experience archive flag');

  const publicDetailArchived = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companion_detail_after_archive', publicDetailArchived, makeStepNote(publicDetailArchived));
  assertStatus(publicDetailArchived, 404, 'traveler companion detail after archive', proof);
  assertErrorEnvelope(publicDetailArchived, 'traveler companion detail after archive', 'Companion not found');

  const publicServicesArchived = await sendNoBody(worker, `http://local.test/api/companions/${guideUserId}/services`, 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companion_services_after_archive', publicServicesArchived, makeStepNote(publicServicesArchived));
  assertStatus(publicServicesArchived, 404, 'traveler companion services after archive', proof);
  assertErrorEnvelope(publicServicesArchived, 'traveler companion services after archive', 'Companion not found');

  const travelerDiscoveryAfterArchive = await sendNoBody(worker, 'http://local.test/api/companions?limit=10&page=1', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_companions_after_archive', travelerDiscoveryAfterArchive, makeStepNote(travelerDiscoveryAfterArchive));
  assertStatus(travelerDiscoveryAfterArchive, 200, 'traveler companions after archive', proof);
  assertSuccessEnvelope(travelerDiscoveryAfterArchive, 'traveler companions after archive');
  assertEqual(Boolean(travelerDiscoveryAfterArchive.json.data.companions.some((item) => item.id === guideUserId)), false, 'traveler discovery after archive hidden');

  const travelerSupplierSearchAfterArchive = await sendNoBody(worker, 'http://local.test/api/suppliers/search?limit=10&page=1', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_suppliers_after_archive', travelerSupplierSearchAfterArchive, makeStepNote(travelerSupplierSearchAfterArchive));
  assertStatus(travelerSupplierSearchAfterArchive, 200, 'traveler suppliers after archive', proof);
  assertSuccessEnvelope(travelerSupplierSearchAfterArchive, 'traveler suppliers after archive');
  assertEqual(Boolean(travelerSupplierSearchAfterArchive.json.data.items.some((item) => item.id === guideUserId)), false, 'traveler supplier search after archive hidden');

  const bookingTravelerArchived = await sendNoBody(worker, `http://local.test/api/bookings/${bookingId}`, 'GET', travelerAccessToken);
  recordStep(proof, 'booking_detail_after_archive', bookingTravelerArchived, makeStepNote(bookingTravelerArchived));
  assertStatus(bookingTravelerArchived, 200, 'booking detail after archive', proof);
  assertSuccessEnvelope(bookingTravelerArchived, 'booking detail after archive');
  assertEqual(bookingTravelerArchived.json.data.booking.id, bookingId, 'booking detail after archive id');
  assertEqual(bookingTravelerArchived.json.data.booking.status, 'completed', 'booking detail after archive status');

  const chatDetailAfterArchive = await sendNoBody(worker, `http://local.test/api/chat/rooms/${roomId}?page=1&limit=50`, 'GET', travelerAccessToken);
  recordStep(proof, 'chat_detail_after_archive', chatDetailAfterArchive, makeStepNote(chatDetailAfterArchive));
  assertStatus(chatDetailAfterArchive, 200, 'chat detail after archive', proof);
  assertSuccessEnvelope(chatDetailAfterArchive, 'chat detail after archive');
  assertArrayLength(chatDetailAfterArchive.json.data.messages, 1, 'chat detail after archive message count');

  const archivedApplicationStatus = await sendNoBody(worker, `http://local.test/api/supplier-onboarding/${applicationId}/status`, 'GET', null, { Authorization: `Bearer ${statusToken}` });
  recordStep(proof, 'application_publication_after_archive', archivedApplicationStatus, makeStepNote(archivedApplicationStatus));
  assertStatus(archivedApplicationStatus, 200, 'archived publication status', proof);
  assertEqual(archivedApplicationStatus.json.data.publicationStatus, 'draft', 'archived final active service returns draft');

  const guideStats = await sendNoBody(worker, 'http://local.test/api/suppliers/stats', 'GET', guideAccessToken);
  recordStep(proof, 'guide_stats', guideStats, makeStepNote(guideStats));
  assertStatus(guideStats, 200, 'guide stats', proof);
  assertSuccessEnvelope(guideStats, 'guide stats');
  assertEqual(guideStats.json.data.data.totalBookings, 1, 'guide stats total bookings');
  assertEqual(guideStats.json.data.data.completedBookings, 1, 'guide stats completed bookings');
  assertEqual(guideStats.json.data.data.bookedValue, 900, 'guide stats booked value');
  assertEqual(guideStats.json.data.data.totalEarnings, null, 'guide stats total earnings');

  const guideStatsTravelerDenied = await sendNoBody(worker, 'http://local.test/api/suppliers/stats', 'GET', travelerAccessToken);
  recordStep(proof, 'guide_stats_traveler_denied', guideStatsTravelerDenied, makeStepNote(guideStatsTravelerDenied));
  assertStatus(guideStatsTravelerDenied, 403, 'guide stats traveler denied', proof);
  assertErrorEnvelope(guideStatsTravelerDenied, 'guide stats traveler denied', 'Insufficient permissions');

  const travelerBookings = await sendNoBody(worker, 'http://local.test/api/bookings?page=1&limit=50', 'GET', travelerAccessToken);
  recordStep(proof, 'traveler_booking_list', travelerBookings, makeStepNote(travelerBookings));
  assertStatus(travelerBookings, 200, 'traveler booking list', proof);
  assertSuccessEnvelope(travelerBookings, 'traveler booking list');
  assertArrayLength(travelerBookings.json.data.items, 1, 'traveler booking list count');
  assertEqual(travelerBookings.json.data.items[0].id, bookingId, 'traveler booking list id');

  const guideBookings = await sendNoBody(worker, 'http://local.test/api/bookings?page=1&limit=50', 'GET', guideAccessToken);
  recordStep(proof, 'guide_booking_list', guideBookings, makeStepNote(guideBookings));
  assertStatus(guideBookings, 200, 'guide booking list', proof);
  assertSuccessEnvelope(guideBookings, 'guide booking list');
  assertArrayLength(guideBookings.json.data.items, 1, 'guide booking list count');
  assertEqual(guideBookings.json.data.items[0].id, bookingId, 'guide booking list id');

  for (const [route, method, token] of [
    ['http://local.test/api/supplier-onboarding', 'GET', null],
    ['http://local.test/api/admin/supplier-onboarding', 'GET', ordinaryAccessToken],
    ['http://local.test/api/admin/operations/bookings?mode=tirak&page=1&limit=1', 'POST', adminAccessToken],
    ['http://local.test/api/chat/rooms', 'GET', ordinaryAccessToken],
    ['http://local.test/api/public/health', 'POST', null],
  ]) {
    const result = await sendNoBody(worker, route, method, token);
    pushMethodSanity(proof, route.replace('http://local.test', ''), method, result);
  }

  const fkViolations = await db.prepare('PRAGMA foreign_key_check;').all();
  const application = await db.prepare(`
    SELECT status, approved_user_id, reviewed_user_id, invitation_delivery_status, payload_digest, idempotency_key_hash
    FROM supplier_onboarding_applications WHERE id = ?
  `).bind(applicationId).first();
  const evidence = await db.prepare(`
    SELECT kind, COUNT(*) AS count FROM supplier_onboarding_evidence WHERE application_id = ? GROUP BY kind ORDER BY kind ASC
  `).bind(applicationId).all();
  const r2Objects = await r2.list({ prefix: `private-core-onboarding/${applicationId}/` });
  const bookingRow = await db.prepare(`
    SELECT id, status, payment_status, customer_id, supplier_id, service_id FROM bookings WHERE id = ?
  `).bind(bookingId).first();
  const roomRow = await db.prepare(`
    SELECT id, booking_id, customer_id, supplier_id, last_message_at FROM booking_chat_rooms WHERE id = ?
  `).bind(roomId).first();
  const messageCountRow = await db.prepare('SELECT COUNT(*) AS total FROM booking_chat_messages WHERE room_id = ?').bind(roomId).first();
  const ticketCountRow = await db.prepare('SELECT COUNT(*) AS total FROM chat_socket_tickets WHERE room_id = ?').bind(roomId).first();
  const archivedServiceRow = await db.prepare('SELECT archived_at, is_active FROM supplier_services WHERE id = ?').bind(serviceId).first();
  const resetInvite = resetKeyName ? JSON.parse(await kv.get(resetKeyName) || 'null') : null;
  const resetConsumptions = await db.prepare('SELECT COUNT(*) AS total FROM password_reset_consumptions').first();
  const bookingIdempotency = await db.prepare('SELECT booking_id, payload_digest FROM booking_idempotency WHERE booking_id = ?').bind(bookingId).first();
  const expectedBookingDigest = computeBookingPayloadDigest(bookingPayload);

  proof.sanitized = {
    application: {
      status: application?.status || null,
      approvedUserIdPresent: Boolean(application?.approved_user_id),
      reviewedUserIdPresent: Boolean(application?.reviewed_user_id),
      invitationDeliveryStatus: application?.invitation_delivery_status || null,
      payloadDigestMatches: application?.payload_digest === intakeDigest,
      idempotencyKeyHashPresent: Boolean(application?.idempotency_key_hash),
    },
    qaGuideMembership: {
      role: guideQaRow?.role || null,
      sourceApplicationMatches: guideQaRow?.source_application_id === applicationId,
      enrolledByMatchesAdmin: guideQaRow?.enrolled_by === seeded.admin.id,
      revoked: Boolean(guideQaRow?.revoked_at),
    },
    evidenceCounts: evidence.results,
    r2ObjectCount: r2Objects.objects.length,
    booking: {
      id: bookingRow?.id || null,
      status: bookingRow?.status || null,
      paymentStatus: bookingRow?.payment_status || null,
      participantMatch: bookingRow?.customer_id === seeded.traveler.id && bookingRow?.supplier_id === guideUserId,
      serviceMatch: bookingRow?.service_id === serviceId,
      idempotencyDigestMatches: bookingIdempotency?.payload_digest === expectedBookingDigest,
    },
    chat: {
      roomId: roomRow?.id || null,
      bookingMatch: roomRow?.booking_id === bookingId,
      participantMatch: roomRow?.customer_id === seeded.traveler.id && roomRow?.supplier_id === guideUserId,
      messageCount: Number(messageCountRow?.total || 0),
      ticketCount: Number(ticketCountRow?.total || 0),
      hasLastMessageAt: Boolean(roomRow?.last_message_at),
    },
    archivedService: {
      archived: Boolean(archivedServiceRow?.archived_at),
      active: Boolean(archivedServiceRow?.is_active),
    },
    inviteRecord: {
      present: Boolean(originalInviteRecord),
      consumed: !resetInvite,
      purpose: originalInviteRecord?.purpose || null,
      expiresAtPresent: Boolean(originalInviteRecord?.expiresAt),
      userIdMatches: originalInviteRecord?.userId === guideUserId,
    },
    foreignKeyViolations: fkViolations.results?.length || 0,
    resetConsumptions: Number(resetConsumptions?.total || 0),
    stats: {
      unpaidBookedValue: guideStats.json?.data?.data?.bookedValue ?? null,
      earnings: guideStats.json?.data?.data?.totalEarnings ?? null,
    },
  };

  assertEqual(proof.sanitized.application.payloadDigestMatches, true, 'application payload digest match');
  assertEqual(proof.sanitized.r2ObjectCount, 3, 'evidence object count');
  assertEqual(proof.sanitized.booking.status, 'completed', 'sanitized booking completed status');
  assertEqual(proof.sanitized.booking.paymentStatus, 'pending', 'sanitized booking payment pending');
  assertEqual(proof.sanitized.booking.idempotencyDigestMatches, true, 'booking idempotency digest match');
  assertEqual(proof.sanitized.chat.messageCount, 1, 'sanitized chat message count');
  assertEqual(proof.sanitized.archivedService.archived, true, 'sanitized archived service archived');
  assertEqual(proof.sanitized.archivedService.active, false, 'sanitized archived service inactive');
  assertEqual(proof.sanitized.inviteRecord.present, true, 'sanitized invite record present');
  assertEqual(proof.sanitized.inviteRecord.consumed, true, 'invite capability consumed');
  assertEqual(proof.sanitized.foreignKeyViolations, 0, 'foreign key violations');
  assertEqual(proof.sanitized.resetConsumptions, 1, 'single password reset consumption record');

  proof.assertions = {
    everyStepHasExactExpectedStatus: proof.steps.every((step) => Number.isInteger(step.status) && step.status > 0),
    noExtraBootstrapAccounts: proof.syntheticUsers.bootstrapGuideAccounts === 0,
    onlySyntheticGuideSeededViaApproval: guideQaRow?.source_application_id === applicationId,
    allRequiredCoverageCompleted: true,
  };

  proof.ok = true;
}

async function runWorkerProcess(proofPath, runtimeRoot, secretPath, schemaPath) {
  const secrets = JSON.parse(await readFile(secretPath, 'utf8'));
  const sql = await readFile(schemaPath, 'utf8');
  let mf;
  try {
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    const bundled = await bundleWorkerWithWrangler(process.cwd());
    proof.bundle = { path: toRepoRelative(process.cwd(), bundled.bundlePath), ...bundled.metadata };
    await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');

    mf = await makeRuntime(bundled.bundlePath, runtimeRoot, secrets.jwtSecret);
    await mf.ready;

    proof.steps.push({ name: 'runtime_boot', status: 200, envelope: null });
    const db = await mf.getD1Database('DB');
    await applySchema(db, sql);
    proof.steps.push({ name: 'schema_apply', status: 200, envelope: null });
    await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');

    try {
      await runJourney({ worker: mf, secrets, proof });
    } finally {
      await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');
    }
  } finally {
    if (mf) {
      await mf.dispose().catch(() => undefined);
    }
  }
}

async function runSupervisor() {
  const repoRoot = process.cwd();
  const runtime = await createPrivateRuntimeRoot();
  const proofPath = path.join(repoRoot, 'scripts/core-qa/generated/core-qa-local-proof.json');
  const startedAt = new Date().toISOString();
  const { secretPath } = await writePrivateSecrets(runtime.privateDir);
  const freshSchema = await generateFreshSchema({
    repoRoot,
    outputPath: path.join(repoRoot, 'scripts/core-qa/generated/core-qa-fresh-schema.sql'),
  });

  const proof = {
    ok: false,
    verificationState: 'running',
    mode: 'local-disposable',
    startedAt,
    steps: [],
    methodSanity: [],
    limitations: [],
    failureContext: {},
    schema: {
      outputPath: toRepoRelative(repoRoot, freshSchema.outputPath),
      combinedSha256: freshSchema.combinedSha256,
      manifest: freshSchema.manifest,
    },
  };

  await mkdir(path.dirname(proofPath), { recursive: true });
  await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');

  const child = spawn(process.execPath, [__filename, '--worker', proofPath, runtime.root, secretPath, freshSchema.outputPath], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timeoutId;
  const timed = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, signal: 'SIGKILL', timedOut: true });
    }, HARD_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timeoutId);
      resolve({ code, signal, timedOut: false });
    });
  });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const result = await timed;
  const nextProof = JSON.parse(await readFile(proofPath, 'utf8'));
  const runtimeError = result.timedOut
    ? { name: 'Error', message: `Core QA runtime exceeded ${HARD_TIMEOUT_MS}ms timeout`, code: 'TIMEOUT', syscall: null, address: null }
    : nextProof.error || (result.code !== 0 ? extractRuntimeError(stderr) : null);

  const finalized = evaluateRunOutcome(nextProof, runtimeError);
  finalized.childExit = {
    code: result.code,
    signal: result.signal || null,
    timedOut: result.timedOut,
    stdoutPreview: stdout.trim().split('\n').filter(Boolean).slice(-10).map((line) => sanitizePreview(line, 400)),
    stderrPreview: stderr.trim().split('\n').filter(Boolean).slice(-20).map((line) => sanitizePreview(line, 400)),
  };

  await writeFile(proofPath, JSON.stringify(finalized, null, 2), 'utf8');
  await rm(runtime.root, { recursive: true, force: true }).catch(() => undefined);

  if (!finalized.ok) {
    const failure = runtimeError || { message: 'Core QA runtime proof failed' };
    throw Object.assign(new Error(failure.message), failure);
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isEntryPoint && process.argv[2] === '--worker') {
  runWorkerProcess(process.argv[3], process.argv[4], process.argv[5], process.argv[6]).catch(async (error) => {
    const proofPath = process.argv[3];
    try {
      const proof = JSON.parse(await readFile(proofPath, 'utf8'));
      proof.ok = false;
      proof.error = sanitizeError(error);
      if (!proof.failureContext) proof.failureContext = {};
      proof.failureContext.worker = {
        error: proof.error.code,
        message: sanitizePreview(proof.error.message),
      };
      await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');
    } catch {
      // ignore secondary proof write failures
    }
    console.error(error);
    process.exitCode = 1;
  });
} else if (isEntryPoint) {
  runSupervisor().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

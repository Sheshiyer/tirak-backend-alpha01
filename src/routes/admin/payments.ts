import { Hono } from 'hono';
import { jsonError, jsonSuccess } from '../../utils/response';
import {
  resolvePaymentRuntimePolicy,
  type PaymentRuntimePolicy,
} from '../../contracts/payment';
import {
  PAYMENT_PROVIDER_POLICY_KEY,
  createStoredPaymentProviderPolicy,
  providerReadiness,
  readStoredPaymentProviderPolicy,
  resolvePaymentProviderPolicy,
  type PaymentMethod,
  type PaymentProviderEnvironment,
  type PaymentProviderMode,
  type PaymentProviderPolicy,
  type PaymentProviderPolicyEnvironment,
  type PaymentProviderPolicyKV,
} from '../../payments/provider-policy';
import type { Env, Variables } from '../../index';

const payments = new Hono<{ Bindings: Env; Variables: Variables }>();

const ENVIRONMENTS = new Set<PaymentProviderEnvironment>([
  'test',
  'development',
  'staging',
  'production',
]);
const MODES = new Set<PaymentProviderMode>(['disabled', 'test', 'live']);
const METHODS = new Set<PaymentMethod>(['promptpay']);

interface UpdatePaymentProviderPolicyBody {
  provider: 'omise';
  environment: PaymentProviderEnvironment;
  mode: PaymentProviderMode;
  enabled: boolean;
  supportedMethods: PaymentMethod[];
  expectedRevision?: number;
}

function normalizedEnvironment(value: unknown): PaymentProviderEnvironment {
  return ENVIRONMENTS.has(value as PaymentProviderEnvironment)
    ? value as PaymentProviderEnvironment
    : 'development';
}

function parseUpdateBody(value: unknown): UpdatePaymentProviderPolicyBody | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    'provider',
    'environment',
    'mode',
    'enabled',
    'supportedMethods',
    'expectedRevision',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (body.provider !== 'omise') return null;
  if (!ENVIRONMENTS.has(body.environment as PaymentProviderEnvironment)) return null;
  if (!MODES.has(body.mode as PaymentProviderMode)) return null;
  if (typeof body.enabled !== 'boolean') return null;
  if (!Array.isArray(body.supportedMethods)) return null;
  if (body.supportedMethods.length > METHODS.size) return null;
  if (!body.supportedMethods.every((method) => METHODS.has(method as PaymentMethod))) return null;
  if (new Set(body.supportedMethods).size !== body.supportedMethods.length) return null;
  if (body.enabled && body.supportedMethods.length === 0) return null;
  if (body.enabled && body.mode === 'disabled') return null;
  if (body.enabled && body.environment === 'production' && body.mode !== 'live') return null;
  if (body.enabled && body.environment !== 'production' && body.mode !== 'test') return null;
  if (body.expectedRevision !== undefined
    && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) {
    return null;
  }
  return body as unknown as UpdatePaymentProviderPolicyBody;
}

function responseData(
  policy: PaymentProviderPolicy | null,
  env: PaymentProviderPolicyEnvironment,
  invalid: boolean,
  runtime: PaymentRuntimePolicy,
  actorAudit?: { actorId: string; occurredAt: string; before: PaymentProviderPolicy | null; after: PaymentProviderPolicy },
) {
  const viewPolicy: PaymentProviderPolicy = policy ?? {
    provider: 'omise',
    environment: normalizedEnvironment(env.ENVIRONMENT),
    mode: 'disabled',
    enabled: false,
    supportedMethods: ['promptpay'],
    revision: 0,
    updatedAt: '',
  };
  const resolved = invalid
    ? {
      enabled: false,
      reason: 'provider_policy_invalid' as const,
      adapter: null,
      readiness: providerReadiness(viewPolicy.provider, env),
    }
    : resolvePaymentProviderPolicy(policy, 'promptpay', env);
  const effective = policy === null
    ? { ...resolved, readiness: providerReadiness(viewPolicy.provider, env) }
    : resolved;
  const combinedEnabled = runtime.createEnabled && effective.enabled;
  return {
    configured: policy !== null,
    provider: viewPolicy.provider,
    environment: viewPolicy.environment,
    mode: viewPolicy.mode,
    enabled: viewPolicy.enabled,
    supportedMethods: viewPolicy.supportedMethods,
    readiness: effective.readiness,
    updatedAt: policy?.updatedAt ?? null,
    revision: policy?.revision ?? 0,
    effective: {
      enabled: combinedEnabled,
      reason: runtime.reason || effective.reason,
      adapter: combinedEnabled ? effective.adapter : null,
    },
    lastAudit: actorAudit ?? null,
  };
}

payments.get('/provider-policy', async (c) => {
  const { document, invalid } = await readStoredPaymentProviderPolicy(c.env.PAYMENT_CONFIG_KV);
  const runtime = await resolvePaymentRuntimePolicy(c.env);
  return jsonSuccess(c, responseData(
    document?.policy ?? null,
    c.env,
    invalid,
    runtime,
    document?.auditTrail.at(-1),
  ));
});

payments.patch('/provider-policy', async (c) => {
  const actorId = c.get('userId');
  const paymentAdmins = String(c.env.PAYMENT_ADMIN_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!actorId || !paymentAdmins.includes(actorId)) {
    return jsonError(c, 'Payment policy update forbidden', 'Payment administrator access is required', 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return jsonError(c, 'Invalid payment provider policy', 'A valid JSON policy is required', 400);
  }
  const body = parseUpdateBody(rawBody);
  if (!body) {
    return jsonError(c, 'Invalid payment provider policy', 'Only supported non-secret fields are accepted', 400);
  }
  if (
    body.enabled
    && body.environment === 'production'
    && body.mode === 'live'
    && c.env.PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED !== 'true'
  ) {
    return jsonError(
      c,
      'Production payment policy activation is locked',
      'A separate release-owner environment gate is required',
      403,
    );
  }
  const kv = c.env.PAYMENT_CONFIG_KV as PaymentProviderPolicyKV | undefined;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return jsonError(c, 'Payment provider configuration unavailable', 'Policy was not changed', 503);
  }
  const current = await readStoredPaymentProviderPolicy(kv);
  if (current.invalid) {
    return jsonError(c, 'Stored payment provider policy is invalid', 'Policy was not changed', 409);
  }
  if (body.expectedRevision !== undefined
    && body.expectedRevision !== (current.document?.policy.revision ?? 0)) {
    return jsonError(c, 'Payment provider policy revision conflict', 'Refresh before trying again', 409);
  }

  const occurredAt = new Date().toISOString();
  const next = createStoredPaymentProviderPolicy({
    before: current.document,
    policy: {
      provider: body.provider,
      environment: body.environment,
      mode: body.mode,
      enabled: body.enabled,
      supportedMethods: body.supportedMethods,
    },
    actorId,
    occurredAt,
  });

  try {
    // Policy and audit are one value so a successful write cannot separate them.
    await kv.put(PAYMENT_PROVIDER_POLICY_KEY, JSON.stringify(next));
  } catch {
    return jsonError(c, 'Payment provider policy could not be saved', 'Policy was not changed', 503);
  }

  const runtime = await resolvePaymentRuntimePolicy(c.env);
  return jsonSuccess(c, responseData(
    next.policy,
    c.env,
    false,
    runtime,
    next.auditTrail.at(-1),
  ), 'Payment provider policy updated');
});

export { payments as adminPaymentRoutes };

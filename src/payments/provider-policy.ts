export const PAYMENT_PROVIDER_POLICY_KEY = 'PAYMENT_PROVIDER_POLICY_V1';
export const PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION = 'tirak-payment-provider-policy-v1' as const;

export type PaymentProvider = 'omise';
export type PaymentProviderEnvironment = 'test' | 'development' | 'staging' | 'production';
export type PaymentProviderMode = 'disabled' | 'test' | 'live';
export type PaymentMethod = 'promptpay';

export interface PaymentProviderPolicy {
  provider: PaymentProvider;
  environment: PaymentProviderEnvironment;
  mode: PaymentProviderMode;
  enabled: boolean;
  supportedMethods: PaymentMethod[];
  revision: number;
  updatedAt: string;
}

export interface PaymentProviderPolicyAudit {
  actorId: string;
  occurredAt: string;
  before: PaymentProviderPolicy | null;
  after: PaymentProviderPolicy;
}

export interface StoredPaymentProviderPolicy {
  schemaVersion: typeof PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION;
  policy: PaymentProviderPolicy;
  auditTrail: PaymentProviderPolicyAudit[];
}

export interface PaymentProviderReadiness {
  credentialsBound: boolean;
  webhookSecretBound: boolean;
}

export type PaymentProviderPolicyFailureReason =
  | 'provider_policy_absent'
  | 'provider_policy_invalid'
  | 'provider_policy_disabled'
  | 'unknown_provider'
  | 'unsupported_payment_method'
  | 'missing_provider_credentials'
  | 'missing_webhook_secret'
  | 'provider_environment_mismatch'
  | 'provider_mode_environment_mismatch'
  | 'provider_secret_mode_mismatch';

export interface ResolvedPaymentProviderPolicy {
  enabled: boolean;
  reason: PaymentProviderPolicyFailureReason | null;
  adapter: 'omise-promptpay' | null;
  readiness: PaymentProviderReadiness;
}

export interface PaymentProviderPolicyEnvironment {
  ENVIRONMENT?: string;
  OMISE_SECRET_KEY?: string;
  OMISE_WEBHOOK_SECRET?: string;
}

export interface PaymentProviderPolicyKV {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
}

export const PAYMENT_PROVIDER_REGISTRY = {
  omise: {
    displayName: 'Omise',
    supportedMethods: ['promptpay'] as const,
    adapters: {
      promptpay: 'omise-promptpay' as const,
    },
  },
} as const;

const ENVIRONMENTS = new Set<PaymentProviderEnvironment>([
  'test',
  'development',
  'staging',
  'production',
]);
const MODES = new Set<PaymentProviderMode>(['disabled', 'test', 'live']);
const PROVIDERS = new Set<PaymentProvider>(['omise']);
const METHODS = new Set<PaymentMethod>(['promptpay']);
const MAX_AUDIT_ENTRIES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isPaymentProviderPolicy(value: unknown): value is PaymentProviderPolicy {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, [
    'provider',
    'environment',
    'mode',
    'enabled',
    'supportedMethods',
    'revision',
    'updatedAt',
  ])) return false;
  if (!PROVIDERS.has(value.provider as PaymentProvider)) return false;
  if (!ENVIRONMENTS.has(value.environment as PaymentProviderEnvironment)) return false;
  if (!MODES.has(value.mode as PaymentProviderMode)) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (!Array.isArray(value.supportedMethods)) return false;
  if (value.supportedMethods.length > METHODS.size) return false;
  if (!value.supportedMethods.every((method) => METHODS.has(method as PaymentMethod))) return false;
  if (new Set(value.supportedMethods).size !== value.supportedMethods.length) return false;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return false;
  return isIsoTimestamp(value.updatedAt);
}

function isPaymentProviderPolicyAudit(value: unknown): value is PaymentProviderPolicyAudit {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['actorId', 'occurredAt', 'before', 'after'])) return false;
  return typeof value.actorId === 'string'
    && value.actorId.length > 0
    && isIsoTimestamp(value.occurredAt)
    && (value.before === null || isPaymentProviderPolicy(value.before))
    && isPaymentProviderPolicy(value.after);
}

export function parseStoredPaymentProviderPolicy(raw: unknown): StoredPaymentProviderPolicy | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['schemaVersion', 'policy', 'auditTrail'])) return null;
  if (value.schemaVersion !== PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION) return null;
  if (!isPaymentProviderPolicy(value.policy)) return null;
  if (!Array.isArray(value.auditTrail) || !value.auditTrail.every(isPaymentProviderPolicyAudit)) {
    return null;
  }
  return value as unknown as StoredPaymentProviderPolicy;
}

export function providerReadiness(
  provider: unknown,
  env: PaymentProviderPolicyEnvironment,
): PaymentProviderReadiness {
  if (provider !== 'omise') {
    return { credentialsBound: false, webhookSecretBound: false };
  }
  return {
    credentialsBound: typeof env.OMISE_SECRET_KEY === 'string' && env.OMISE_SECRET_KEY.length > 0,
    webhookSecretBound: typeof env.OMISE_WEBHOOK_SECRET === 'string'
      && env.OMISE_WEBHOOK_SECRET.length > 0,
  };
}

function secretMode(secretKey: string | undefined): 'test' | 'live' | 'unknown' {
  if (!secretKey) return 'unknown';
  if (secretKey.startsWith('skey_test_')) return 'test';
  if (secretKey.startsWith('skey_live_')) return 'live';
  return 'unknown';
}

/**
 * Resolve one provider/method pair without making a provider request. Every
 * unknown, absent, disabled, unsupported, or incompletely bound state closes.
 */
export function resolvePaymentProviderPolicy(
  policy: unknown,
  method: unknown,
  env: PaymentProviderPolicyEnvironment,
): ResolvedPaymentProviderPolicy {
  const provider = isRecord(policy) ? policy.provider : undefined;
  const readiness = providerReadiness(provider, env);
  const fail = (reason: PaymentProviderPolicyFailureReason): ResolvedPaymentProviderPolicy => ({
    enabled: false,
    reason,
    adapter: null,
    readiness,
  });

  if (policy === null || policy === undefined) return fail('provider_policy_absent');
  if (provider !== undefined && !PROVIDERS.has(provider as PaymentProvider)) {
    return fail('unknown_provider');
  }
  if (!isPaymentProviderPolicy(policy)) return fail('provider_policy_invalid');
  if (!policy.enabled || policy.mode === 'disabled') return fail('provider_policy_disabled');
  if (!METHODS.has(method as PaymentMethod)
    || !PAYMENT_PROVIDER_REGISTRY[policy.provider].supportedMethods.includes(method as never)
    || !policy.supportedMethods.includes(method as PaymentMethod)) {
    return fail('unsupported_payment_method');
  }
  if (env.ENVIRONMENT !== policy.environment) return fail('provider_environment_mismatch');
  if (policy.environment === 'production' ? policy.mode !== 'live' : policy.mode !== 'test') {
    return fail('provider_mode_environment_mismatch');
  }
  if (!readiness.credentialsBound) return fail('missing_provider_credentials');
  if (secretMode(env.OMISE_SECRET_KEY) !== policy.mode) return fail('provider_secret_mode_mismatch');
  if (!readiness.webhookSecretBound) return fail('missing_webhook_secret');

  return {
    enabled: true,
    reason: null,
    adapter: PAYMENT_PROVIDER_REGISTRY.omise.adapters.promptpay,
    readiness,
  };
}

export async function readStoredPaymentProviderPolicy(
  kv: Pick<PaymentProviderPolicyKV, 'get'> | undefined,
): Promise<{ document: StoredPaymentProviderPolicy | null; invalid: boolean }> {
  if (!kv || typeof kv.get !== 'function') return { document: null, invalid: false };
  let raw: unknown;
  try {
    raw = await kv.get(PAYMENT_PROVIDER_POLICY_KEY);
  } catch {
    return { document: null, invalid: true };
  }
  if (raw === null || raw === undefined || raw === '') return { document: null, invalid: false };
  const document = parseStoredPaymentProviderPolicy(raw);
  return { document, invalid: document === null };
}

export function createStoredPaymentProviderPolicy(input: {
  before: StoredPaymentProviderPolicy | null;
  policy: Omit<PaymentProviderPolicy, 'revision' | 'updatedAt'>;
  actorId: string;
  occurredAt: string;
}): StoredPaymentProviderPolicy {
  const after: PaymentProviderPolicy = {
    ...input.policy,
    revision: (input.before?.policy.revision ?? 0) + 1,
    updatedAt: input.occurredAt,
  };
  const audit: PaymentProviderPolicyAudit = {
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    before: input.before?.policy ?? null,
    after,
  };
  return {
    schemaVersion: PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION,
    policy: after,
    auditTrail: [...(input.before?.auditTrail ?? []), audit].slice(-MAX_AUDIT_ENTRIES),
  };
}

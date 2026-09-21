import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { jsonSuccess } from '../utils/response';
import { TIRAK_PAYMENT_INTENTS_V2_CONTRACT_VERSION } from '../payments/v2';
import type { Env, Variables } from '../index';

/**
 * Source-only V2 readiness surface.
 *
 * This router is intentionally unmounted until a separately approved,
 * additive migration and provider-adapter review are complete. It has no
 * mutation handlers and does not inspect payment secrets, call a provider, or
 * interact with D1 beyond the ordinary authenticated-user lookup.
 */
const paymentIntentsV2 = new Hono<{ Bindings: Env; Variables: Variables }>();

paymentIntentsV2.use('*', authMiddleware);

paymentIntentsV2.get('/readiness', (c) => jsonSuccess(c, {
  contractVersion: TIRAK_PAYMENT_INTENTS_V2_CONTRACT_VERSION,
  status: 'disabled' as const,
  reason: 'source_only_v2_not_activated',
  capabilities: {
    intentCreation: false,
    providerEventIngestion: false,
    moneyMovement: false,
    ledgerWrites: false,
    paymentReadModel: false,
  },
}, 'Payment-intent V2 is source-only and disabled'));

export { paymentIntentsV2 };

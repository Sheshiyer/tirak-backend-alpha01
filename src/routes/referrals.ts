import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const referrals = new Hono<{ Bindings: Env; Variables: Variables }>();

referrals.use('*', authMiddleware);
referrals.use('*', createRateLimit('general'));

const REFERRAL_AWARD_COINS = 100;

const applyReferralSchema = z.object({
  code: z.string().min(4).max(32),
});

const normalizeReferralCode = (code: string) => code.trim().toUpperCase();

const generateReferralCode = (userId: string) =>
  `TIRAK${userId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

async function ensureReferralAccount(db: D1Database, userId: string) {
  const existing = await db.prepare(`
    SELECT user_id, referral_code, referred_by_user_id, coin_balance, total_earned, total_redeemed
    FROM referral_accounts
    WHERE user_id = ?
  `).bind(userId).first();

  if (existing) return existing;

  const code = generateReferralCode(userId);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO referral_accounts (
      user_id, referral_code, coin_balance, total_earned, total_redeemed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, code, 0, 0, 0, now, now).run();

  return {
    user_id: userId,
    referral_code: code,
    referred_by_user_id: null,
    coin_balance: 0,
    total_earned: 0,
    total_redeemed: 0,
  };
}

export async function awardReferralCoins(db: D1Database, referredUserId: string, rawCode?: string | null) {
  if (!rawCode) return null;

  const code = normalizeReferralCode(rawCode);
  const referredAccount = await ensureReferralAccount(db, referredUserId);
  if (String(referredAccount.referral_code).toUpperCase() === code) {
    return null;
  }

  const referrer = await db.prepare(`
    SELECT user_id, referral_code
    FROM referral_accounts
    WHERE referral_code = ?
  `).bind(code).first();

  if (!referrer?.user_id) return null;

  const existingEvent = await db.prepare(`
    SELECT id FROM referral_events WHERE referred_user_id = ?
  `).bind(referredUserId).first();

  if (existingEvent) return existingEvent;

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO referral_events (
        id, referrer_id, referred_user_id, referral_code, status, coins_awarded, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(eventId, referrer.user_id, referredUserId, code, 'awarded', REFERRAL_AWARD_COINS, now, now),
    db.prepare(`
      UPDATE referral_accounts
      SET coin_balance = coin_balance + ?, total_earned = total_earned + ?, updated_at = ?
      WHERE user_id = ?
    `).bind(REFERRAL_AWARD_COINS, REFERRAL_AWARD_COINS, now, referrer.user_id),
    db.prepare(`
      UPDATE referral_accounts
      SET referred_by_user_id = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(referrer.user_id, now, referredUserId),
    db.prepare(`
      INSERT INTO coin_transactions (
        id, user_id, amount, transaction_type, reason, related_user_id, referral_event_id, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      referrer.user_id,
      REFERRAL_AWARD_COINS,
      'referral_bonus',
      'Referral bonus',
      referredUserId,
      eventId,
      JSON.stringify({ referralCode: code }),
      now
    ),
  ]);

  return { id: eventId, referrerId: referrer.user_id, coinsAwarded: REFERRAL_AWARD_COINS };
}

referrals.get('/me', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const account = await ensureReferralAccount(c.env.DB, userId);
    const events = await c.env.DB.prepare(`
      SELECT id, referred_user_id, status, coins_awarded, created_at, completed_at
      FROM referral_events
      WHERE referrer_id = ?
      ORDER BY created_at DESC
      LIMIT 25
    `).bind(userId).all();

    return jsonSuccess(c, {
      referralCode: account.referral_code,
      coinBalance: account.coin_balance || 0,
      totalEarned: account.total_earned || 0,
      totalRedeemed: account.total_redeemed || 0,
      awardCoins: REFERRAL_AWARD_COINS,
      shareUrl: `https://tirak.app/ref/${account.referral_code}`,
      referrals: events.results || [],
    }, 'Referral account retrieved successfully');
  } catch (error) {
    console.error('Get referral account error:', error);
    return jsonError(c, 'Failed to retrieve referral account', 'An error occurred while fetching referral data', 500);
  }
});

referrals.post('/apply', zValidator('json', applyReferralSchema), async (c) => {
  const userId = c.get('userId') as string;
  const { code } = c.req.valid('json');

  try {
    const result = await awardReferralCoins(c.env.DB, userId, code);
    if (!result) {
      return jsonError(c, 'Invalid referral code', 'This referral code could not be applied', 400);
    }

    return jsonSuccess(c, result, 'Referral code applied successfully');
  } catch (error) {
    console.error('Apply referral code error:', error);
    return jsonError(c, 'Failed to apply referral code', 'An error occurred while applying the referral code', 500);
  }
});

export { referrals as referralRoutes };

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNotificationQueue, notificationDelaySeconds } from '@/background/notifications';

describe('Core scheduled reminder delay', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps future reminders scheduled without exceeding the real Queue delay limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T17:00:00Z'));
    const send = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn();
    const retry = vi.fn();
    const job = { id: 'qa-reminder', scheduledFor: '2026-10-10T09:00:00+07:00' };
    await handleNotificationQueue({messages:[{body:job,ack,retry}]} as any, {NOTIFICATION_QUEUE:{send}} as any);
    expect(send).toHaveBeenCalledWith(job,{delaySeconds:86400});
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(notificationDelaySeconds('2026-10-05T17:00:00.500Z')).toBe(1);
    expect(notificationDelaySeconds('2026-10-05T18:00:00Z')).toBe(3600);
  });
});

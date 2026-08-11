import { Context } from 'telegraf';
import { logger } from '../utils/logger';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const userBuckets = new Map<number, RateLimitEntry>();

let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < WINDOW_MS) return;
  lastCleanup = now;
  for (const [userId, entry] of userBuckets) {
    if (now >= entry.resetAt) {
      userBuckets.delete(userId);
    }
  }
}

export function rateLimit(ctx: Context): boolean {
  const userId = ctx.from?.id;
  if (!userId) return false;

  cleanup();

  const now = Date.now();
  const entry = userBuckets.get(userId);

  if (!entry || now >= entry.resetAt) {
    userBuckets.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_REQUESTS) {
    logger.warn({ userId }, 'Rate limit hit');
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    ctx.reply(
      `<b>⏳ Slow down!</b>\n\nYou've reached the limit of ${MAX_REQUESTS} requests per minute. Please wait ${retryAfter} seconds.`,
      { parse_mode: 'HTML' },
    ).catch(() => {});
    return false;
  }

  entry.count++;
  return true;
}

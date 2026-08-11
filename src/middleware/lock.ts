import { Context } from 'telegraf';

const userLocks = new Map<number, boolean>();

export function acquireLock(userId: number): boolean {
  if (userLocks.get(userId)) return false;
  userLocks.set(userId, true);
  return true;
}

export function releaseLock(userId: number): void {
  userLocks.delete(userId);
}

export async function withLock<T>(userId: number, fn: () => Promise<T>, ctx: Context): Promise<T | void> {
  if (!acquireLock(userId)) {
    await ctx.reply('<b>⏳ Please wait</b> — you have a request in progress.', { parse_mode: 'HTML' });
    return;
  }

  try {
    return await fn();
  } finally {
    releaseLock(userId);
  }
}

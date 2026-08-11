import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { BotContext } from '../types';

const ownerId = BigInt(env.OWNER_ID);

export async function authMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
  const user = ctx.from;
  if (!user) {
    await next();
    return;
  }

  try {
    const bigId = BigInt(user.id);

    const dbUser = await prisma.user.upsert({
      where: { telegramId: bigId },
      update: {
        username: user.username ?? '',
        firstName: user.first_name ?? '',
        lastName: user.last_name ?? '',
        updatedAt: new Date(),
      },
      create: {
        telegramId: bigId,
        username: user.username ?? '',
        firstName: user.first_name ?? '',
        lastName: user.last_name ?? '',
        isOwner: bigId === ownerId,
        isAdmin: bigId === ownerId,
      },
    });

    const botCtx = ctx as BotContext;
    botCtx.session = botCtx.session ?? { mode: 'chat' };
    botCtx.state = {
      dbUser: {
        id: dbUser.id,
        telegramId: dbUser.telegramId,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        username: dbUser.username,
        isPremium: dbUser.isPremium,
        isAdmin: dbUser.isAdmin,
        isOwner: dbUser.isOwner,
      },
      isOwner: dbUser.isOwner,
      isAdmin: dbUser.isAdmin,
    };

    if (dbUser.isAdmin || dbUser.isOwner) {
      logger.info({ userId: user.id, isAdmin: dbUser.isAdmin, isOwner: dbUser.isOwner }, 'Admin/Owner identified');
    }
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Auth middleware error');
  }

  await next();
}

import { Context } from 'telegraf';
import { logger } from '../utils/logger';

export const errorHandler = (err: unknown, ctx: Context): void => {
  logger.error(
    {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      updateType: ctx.updateType,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    },
    'Bot error occurred',
  );
};

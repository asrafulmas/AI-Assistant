import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { requireMembership } from '../services/channel';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';

export async function startHandler(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(premium('❌', 'Could Not Identify You'));
      return;
    }

    const member = await requireMembership(ctx, userId);
    if (!member) return;

    const botCtx = ctx as BotContext;
    botCtx.session.mode = 'chat';

    await prisma.analytics.create({
      data: {
        userId: BigInt(userId),
        event: 'start',
        metadata: {} as never,
      },
    });

    await ctx.reply(
      premium('🤖', 'Welcome to TeleForge AI',
        '\n> Your intelligent AI assistant by **@TeleforgeOfficial**.\n\nChoose an option below 👇'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              coloredBtn('💬 Chat', 'chat', 'primary'),
              coloredBtn('🖼 Image Generate', 'image_generate', 'success'),
            ],
            [
              coloredBtn('📄 File Summary', 'file_summary', 'primary'),
              coloredBtn('🌐 Translate', 'translate', 'primary'),
            ],
            [
              coloredBtn('🛠 Code Assistant', 'code', 'primary'),
              coloredBtn('💎 Premium', 'premium_home', 'success'),
            ],
            [
              coloredBtn('⚙️ Settings', 'settings', 'primary'),
            ],
          ],
        },
      },
    );
  } catch (error) {
    logger.error({ error, userId: ctx.from?.id }, 'Start handler error');
    await ctx.reply(premium('❌', 'Something Went Wrong', 'Please try `/start` again.'), { parse_mode: 'HTML' });
  }
}

import { Telegraf, session } from 'telegraf';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';
import { startHandler } from '../handlers/start';
import { messageHandler } from '../handlers/message';
import { callbackHandler } from '../handlers/callback';
import { helpHandler } from '../handlers/help';
import { setAdminHandler, addChannelHandler, removeChannelHandler } from '../handlers/admin';
import { errorHandler } from '../middleware/errorHandler';
import { validateAI } from '../services/ai';
import { prisma } from '../database/prisma';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';

export async function createBot(): Promise<Telegraf> {
  const bot = new Telegraf(env.BOT_TOKEN);

  bot.use(session({ defaultSession: () => ({ mode: 'chat' }) }));
  bot.use(authMiddleware);

  bot.start(startHandler);
  bot.help(helpHandler);

  bot.command('chat', async (ctx) => {
    const botCtx = ctx as unknown as BotContext;
    botCtx.session.mode = 'chat';
    await ctx.reply(premium('💬', 'Chat Mode', 'Send me a message and I\'ll respond naturally.'), { parse_mode: 'HTML' });
  });

  bot.command('createimage', async (ctx) => {
    const botCtx = ctx as unknown as BotContext;
    botCtx.session.mode = 'image_generate';
    botCtx.session.awaitingImagePrompt = true;
    await ctx.reply(premium('🖼', 'Image Generation', 'Describe the image you want me to create.\n\n━━━━━━━━━━━━━━\n\n**Example:**\n\n<i>A futuristic robot in a neon-lit city at night</i>'), { parse_mode: 'HTML' });
  });

  bot.command('code', async (ctx) => {
    const botCtx = ctx as unknown as BotContext;
    botCtx.session.mode = 'code';
    await ctx.reply(premium('💻', 'Code Assistant', 'Send me a coding problem and I\'ll help you solve it.'), { parse_mode: 'HTML' });
  });

  bot.command('translate', async (ctx) => {
    const botCtx = ctx as unknown as BotContext;
    botCtx.session.mode = 'translate';
    botCtx.session.awaitingTranslation = true;
    await ctx.reply(premium('🌐', 'Translate Mode', 'Send me text to translate.\n\n━━━━━━━━━━━━━━\n\n**Supported Languages**\n\n• Hindi\n• English\n• Urdu\n• Arabic\n• French'), { parse_mode: 'HTML' });
  });

  bot.command('settings', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const dbUser = (ctx as any).state?.dbUser;
    const isAdmin = dbUser?.isAdmin || dbUser?.isOwner;
    const langLabels: Record<string, string> = {
      hinglish: '🇮🇳 Hinglish', hindi: '🇮🇳 Hindi', english: '🇬🇧 English',
      arabic: '🇸🇦 Arabic', french: '🇫🇷 French', urdu: '🇵🇰 Urdu',
    };
    const botCtx = ctx as unknown as BotContext;
    const currentLang = botCtx.session.language ?? 'hinglish';

    const keyboard: any[][] = [];
    if (isAdmin) keyboard.push([coloredBtn('🛡️ Admin Panel', 'admin', 'danger')]);
    keyboard.push([coloredBtn('🌐 Change Language', 'language_menu', 'primary')]);
    keyboard.push([coloredBtn('🏡 Home', 'home', 'primary')]);

    await ctx.reply(
      premium('⚙️', 'Settings', `**Profile**\n\n• **ID:** \`${userId}\`\n• **Role:** ${dbUser?.isOwner ? '👑 Owner' : dbUser?.isAdmin ? '🛡️ Admin' : '👤 User'}\n• **Language:** ${langLabels[currentLang] ?? '🇮🇳 Hinglish'}`),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } },
    );
  });

  bot.command('setadmin', setAdminHandler);
  bot.command('addchannel', addChannelHandler);
  bot.command('removechannel', removeChannelHandler);

  bot.command('stats', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const dbUser = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
    if (!dbUser?.isAdmin && !dbUser?.isOwner) {
      await ctx.reply(premium('⛔', 'Admin Access Required'), { parse_mode: 'HTML' });
      return;
    }

    const [totalUsers, totalConversations, totalAnalytics] = await Promise.all([
      prisma.user.count(),
      prisma.conversation.count(),
      prisma.analytics.count(),
    ]);

    await ctx.reply(
      premium('📊', 'Bot Statistics', `**Usage Overview**\n\n• **Users:** ${totalUsers}\n• **Conversations:** ${totalConversations}\n• **Events:** ${totalAnalytics}`),
      { parse_mode: 'HTML' },
    );
  });

  bot.on(['text', 'photo', 'document', 'video', 'animation', 'audio', 'voice', 'sticker'], messageHandler);
  bot.on('callback_query', callbackHandler);
  bot.catch(errorHandler);

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start TeleForge AI and show menu' },
    { command: 'help', description: 'Show available commands' },
    { command: 'chat', description: 'Chat with AI assistant' },
    { command: 'createimage', description: 'Generate an AI image from text' },
    { command: 'code', description: 'Get coding help from AI' },
    { command: 'translate', description: 'Translate text between languages' },
    { command: 'settings', description: 'Open settings panel' },
  ]);

  const validation = await validateAI();
  if (!validation.key1Valid && !validation.key2Valid) {
    logger.error('No valid API keys found. Bot will start but AI features will fail.');
  } else {
    logger.info({ key1Valid: validation.key1Valid, key2Valid: validation.key2Valid, models: validation.validatedModels }, 'AI validation complete');
  }

  return bot;
}

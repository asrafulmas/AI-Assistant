import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { requireMembership } from '../services/channel';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';
import { handleBroadcastStart, handleBroadcastCancel, handleBroadcastSend } from './broadcast';
import { handlePremiumHome, handleAdminPremiumPanel, handleSetPrice, handleSetUpiId, handleViewRequests, handleBuyPremium, handlePaidConfirm, handleManagePremiumUsers, handleAddPremiumManual, handleApprovePayment, handleRejectPayment, handleRemovePremium } from './premium';
import { handleChannelManager, handleChannelAddStart, handleChannelRemoveList, handleChannelRemove, handleChannelRemoveConfirm, handleCheckMembership } from './channel';

const HOME_KEYBOARD = {
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
};

async function handleHome(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const member = await requireMembership(ctx, userId);
  if (!member) return;

  ctx.session.mode = 'chat';

  await ctx.editMessageText(
    premium('🤖', 'Welcome to TeleForge AI', 'Your intelligent AI assistant powered by **@TeleforgeOfficial**.\n\n━━━━━━━━━━━━━━\n\nChoose an option below.'),
    { parse_mode: 'HTML', reply_markup: HOME_KEYBOARD },
  ).catch(() => {});
}

async function handleFeature(ctx: BotContext, feature: string, label: string, prompt: string): Promise<void> {
  ctx.session.mode = feature;

  if (feature === 'translate') {
    ctx.session.awaitingTranslation = true;
  }

  await ctx.editMessageText(
    premium('🤖', `${label} Mode`, `${prompt}\n\n━━━━━━━━━━━━━━\n\nTap **Back** to return to the main menu.`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('⬅️ Back', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

const LANGUAGE_LABELS: Record<string, string> = {
  hinglish: '🇮🇳 Hinglish',
  hindi: '🇮🇳 Hindi',
  english: '🇬🇧 English',
  arabic: '🇸🇦 Arabic',
  french: '🇫🇷 French',
  urdu: '🇵🇰 Urdu',
};

async function handleSettings(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const dbUser = ctx.state.dbUser;
  const isAdmin = dbUser?.isAdmin || dbUser?.isOwner;
  const currentLang = ctx.session.language ?? 'hinglish';

  const keyboard: any[][] = [];

  if (isAdmin) {
    keyboard.push([coloredBtn('🛡️ Admin Panel', 'admin', 'danger')]);
  }

  keyboard.push([coloredBtn('🌐 Change Language', 'language_menu', 'primary')]);
  keyboard.push([coloredBtn('🏡 Home', 'home', 'primary')]);

  await ctx.editMessageText(
    premium('⚙️', 'Settings', `**Profile**\n\n• **ID:** \`${userId}\`\n• **Role:** ${dbUser?.isOwner ? '👑 Owner' : dbUser?.isAdmin ? '🛡️ Admin' : '👤 User'}\n• **Language:** ${LANGUAGE_LABELS[currentLang] ?? '🇮🇳 Hinglish'}`),
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    },
  ).catch(() => {});
}

async function handleLanguageMenu(ctx: BotContext): Promise<void> {
  const currentLang = ctx.session.language ?? 'hinglish';

  await ctx.editMessageText(
    premium('🌐', 'Select Language', `**Current Language**\n\n${LANGUAGE_LABELS[currentLang] ?? '🇮🇳 Hinglish'}\n\n━━━━━━━━━━━━━━\n\nChoose your preferred language for AI responses.`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn(`${currentLang === 'hinglish' ? '✅ ' : ''}🇮🇳 Hinglish`, 'lang_hinglish', 'primary')],
          [coloredBtn(`${currentLang === 'hindi' ? '✅ ' : ''}🇮🇳 Hindi`, 'lang_hindi', 'primary')],
          [coloredBtn(`${currentLang === 'english' ? '✅ ' : ''}🇬🇧 English`, 'lang_english', 'primary')],
          [coloredBtn(`${currentLang === 'arabic' ? '✅ ' : ''}🇸🇦 Arabic`, 'lang_arabic', 'primary')],
          [coloredBtn(`${currentLang === 'french' ? '✅ ' : ''}🇫🇷 French`, 'lang_french', 'primary')],
          [coloredBtn(`${currentLang === 'urdu' ? '✅ ' : ''}🇵🇰 Urdu`, 'lang_urdu', 'primary')],
          [coloredBtn('⬅️ Back to Settings', 'settings', 'primary')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

async function handleLanguageSet(ctx: BotContext, lang: string): Promise<void> {
  ctx.session.language = lang as any;
  const label = LANGUAGE_LABELS[lang] ?? lang;

  await ctx.answerCbQuery(`Language set to ${label}`);
  await handleLanguageMenu(ctx);
}

export async function handleAdmin(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const dbUser = ctx.state.dbUser;
  if (!dbUser?.isAdmin && !dbUser?.isOwner) {
    await ctx.answerCbQuery('⛔ Admin access required.');
    return;
  }

  const totalUsers = await prisma.user.count();
  const todayUsers = await prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000) } } });
  const totalAnalytics = await prisma.analytics.count();
  const todayAnalytics = await prisma.analytics.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000) } } });

  const roleLabel = dbUser?.isOwner ? '👑 Owner' : '🛡️ Admin';

  await ctx.editMessageText(
    premium('🛡️', 'Admin Panel', `Welcome back, **${dbUser?.firstName ?? 'Admin'}** (${roleLabel})\n\n━━━━━━━━━━━━━━\n\n**Quick Stats**\n\n• **Users:** ${totalUsers} (${todayUsers} today)\n• **Events:** ${totalAnalytics} (${todayAnalytics} today)\n\n━━━━━━━━━━━━━━\n\nSelect a section below.`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('📊 Analytics', 'admin_analytics', 'danger'),
           coloredBtn('🤖 AI Settings', 'admin_ai', 'danger')],
          [coloredBtn('📢 Channels', 'admin_channels', 'danger'),
           coloredBtn('💎 Premium', 'admin_premium', 'success')],
          [coloredBtn('📣 Broadcast', 'admin_broadcast', 'danger'),
           coloredBtn('👤 Identity', 'admin_identity', 'danger')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});

  await prisma.log.create({
    data: { level: 'info', message: `Admin panel accessed by ${dbUser?.firstName ?? 'Admin'}`, metadata: { userId } as never },
  });
}

async function handleAdminAnalytics(ctx: BotContext): Promise<void> {
  const startOfDay = new Date(Date.now() - 86400000);
  const startOfWeek = new Date(Date.now() - 604800000);

  const [totalUsers, dailyUsers, weeklyUsers, totalEvents, dayEvents, weekEvents] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.user.count({ where: { createdAt: { gte: startOfWeek } } }),
    prisma.analytics.count(),
    prisma.analytics.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.analytics.count({ where: { createdAt: { gte: startOfWeek } } }),
  ]);

  const topEvents = await prisma.analytics.groupBy({
    by: ['event'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  });

  const eventBreakdown = topEvents.map(e => `• \`${e.event}\`: ${e._count.id}`).join('\n');

  await ctx.editMessageText(
    premium('📊', 'Analytics Dashboard', `**Users**\n\n• **Total:** ${totalUsers}\n• **Today:** ${dailyUsers}\n• **Weekly:** ${weeklyUsers}\n\n━━━━━━━━━━━━━━\n\n**Events**\n\n• **Total:** ${totalEvents}\n• **Today:** ${dayEvents}\n• **This Week:** ${weekEvents}\n\n━━━━━━━━━━━━━━\n\n**Top Events**\n\n${eventBreakdown || '• No data yet'}`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔄 Refresh', 'admin_analytics', 'primary')],
          [coloredBtn('⬅️ Back', 'admin', 'primary')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

async function handleAdminAI(ctx: BotContext): Promise<void> {
  const { validateAI, getCurrentModelName, getCurrentApiKeyIndex, getAverageResponseTime, getLastError } = await import('../services/ai');

  const validation = await validateAI();
  const avgTime = getAverageResponseTime();
  const lastError = getLastError();

  const errorInfo = lastError
    ? `• ⚠️ ${lastError.message}\n• 🕐 ${lastError.time}`
    : '• ✅ No recent errors';

  await ctx.editMessageText(
    premium('🤖', 'AI Settings', `**Current Configuration**\n\n• **Model:** \`${getCurrentModelName()}\`\n• **Active Key:** Key ${getCurrentApiKeyIndex()}\n\n━━━━━━━━━━━━━━\n\n**Key Status**\n\n• **Key 1:** ${validation.key1Valid ? '✅ Valid' : '❌ Invalid'}\n• **Key 2:** ${validation.key2Valid === null ? '⬜ Not configured' : validation.key2Valid ? '✅ Valid' : '❌ Invalid'}\n\n━━━━━━━━━━━━━━\n\n**Performance**\n\n• **Avg Response:** ${avgTime}\n\n━━━━━━━━━━━━━━\n\n**Last Error**\n\n${errorInfo}\n\n━━━━━━━━━━━━━━\n\n**Validated Models**\n\n${validation.validatedModels.length > 0 ? validation.validatedModels.map(m => `• \`${m}\``).join('\n') : '• None'}`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔄 Refresh', 'admin_ai', 'primary')],
          [coloredBtn('🧪 Test Connection', 'admin_ai_test', 'danger')],
          [coloredBtn('⬅️ Back', 'admin', 'primary')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

async function handleAdminAITest(ctx: BotContext): Promise<void> {
  const { testConnection } = await import('../services/ai');

  await ctx.editMessageText(
    premium('🧪', 'Testing AI Connection', 'Please wait...'),
    { parse_mode: 'HTML' },
  ).catch(() => {});

  const result = await testConnection();

  const statusIcon = result.success ? '✅' : '❌';
  const statusText = result.success ? 'Connected' : 'Failed';

  await ctx.editMessageText(
    premium('🧪', 'Connection Test', `**Status:** ${statusIcon} ${statusText}\n• **Latency:** ${result.latency}\n${result.error ? `• **Error:** \`${result.error}\`` : ''}`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔄 Retry', 'admin_ai_test', 'primary')],
          [coloredBtn('⬅️ Back', 'admin_ai', 'primary')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

async function handleAdminIdentity(ctx: BotContext): Promise<void> {
  const dbUser = ctx.state.dbUser;
  const isOwner = dbUser?.isOwner ?? false;
  const isAdmin = dbUser?.isAdmin ?? false;

  const botNameSetting = await prisma.setting.findUnique({ where: { key: 'bot_name' } });
  const creatorSetting = await prisma.setting.findUnique({ where: { key: 'creator_username' } });
  const aboutSetting = await prisma.setting.findUnique({ where: { key: 'about_text' } });
  const personalitySetting = await prisma.setting.findUnique({ where: { key: 'ai_personality' } });

  const botName = botNameSetting?.value ?? 'TeleForge AI';
  const creator = creatorSetting?.value ?? '@TeleforgeOfficial';
  const about = aboutSetting?.value ?? 'Your intelligent AI assistant powered by Gemini.';
  const personality = personalitySetting?.value ?? 'Professional, confident, and courteous';

  const canEdit = isOwner || isAdmin;

  await ctx.editMessageText(
    premium('👤', 'Identity Settings', `**Permissions**\n\n• **Owner:** ${isOwner ? '✅ Yes' : '❌ No'}\n• **Admin:** ${isOwner ? '👑 Owner (locked)' : isAdmin ? '✅ Yes' : '❌ No'}\n\n━━━━━━━━━━━━━━\n\n**Current Values**\n\n• **Bot Name:** ${botName}\n• **Creator:** ${creator}\n• **About:** ${about.slice(0, 50)}${about.length > 50 ? '...' : ''}\n• **Personality:** ${personality.slice(0, 50)}${personality.length > 50 ? '...' : ''}\n\n━━━━━━━━━━━━━━\n\n${canEdit ? 'Tap an option below to edit.' : 'Identity settings are managed by the owner.'}`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: canEdit
          ? [
              [coloredBtn('✏️ Edit Bot Name', 'admin_identity_edit_name', 'danger')],
              [coloredBtn('✏️ Edit Creator', 'admin_identity_edit_creator', 'danger')],
              [coloredBtn('✏️ Edit About Text', 'admin_identity_edit_about', 'danger')],
              [coloredBtn('✏️ Edit Personality', 'admin_identity_edit_personality', 'danger')],
              [coloredBtn('🔄 Refresh', 'admin_identity', 'primary')],
              [coloredBtn('⬅️ Back', 'admin', 'primary')],
              [coloredBtn('🏡 Home', 'home', 'primary')],
            ]
          : [
              [coloredBtn('🔄 Refresh', 'admin_identity', 'primary')],
              [coloredBtn('⬅️ Back', 'admin', 'primary')],
              [coloredBtn('🏡 Home', 'home', 'primary')],
            ],
      },
    },
  ).catch(() => {});
}

async function handleAdminIdentityEdit(ctx: BotContext, field: string): Promise<void> {
  const labels: Record<string, string> = {
    name: 'Bot Name',
    creator: 'Creator Username',
    about: 'About Text',
    personality: 'AI Personality',
  };

  const currentValues: Record<string, Promise<string>> = {
    name: prisma.setting.findUnique({ where: { key: 'bot_name' } }).then(s => s?.value ?? 'TeleForge AI'),
    creator: prisma.setting.findUnique({ where: { key: 'creator_username' } }).then(s => s?.value ?? '@TeleforgeOfficial'),
    about: prisma.setting.findUnique({ where: { key: 'about_text' } }).then(s => s?.value ?? 'Your intelligent AI assistant powered by Gemini.'),
    personality: prisma.setting.findUnique({ where: { key: 'ai_personality' } }).then(s => s?.value ?? 'Professional, confident, and courteous'),
  };

  const currentValue = await currentValues[field] ?? '';
  const label = labels[field] ?? field;

  ctx.session.awaitingSettingKey = field;

  await ctx.editMessageText(
    premium('✏️', `Edit ${label}`, `**Current Value**\n\n> ${currentValue}\n\n━━━━━━━━━━━━━━\n\nSend the new value as a message.\n\nTap **Back** to cancel.`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('⬅️ Back', 'admin_identity', 'primary')],
          [coloredBtn('🏡 Home', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

async function handleImageGenerate(ctx: BotContext): Promise<void> {
  ctx.session.mode = 'image_generate';
  ctx.session.awaitingImagePrompt = true;

  await ctx.editMessageText(
    premium('🖼', 'Image Generation', 'Describe the image you want me to create.\n\n━━━━━━━━━━━━━━\n\nSend me a text description and I\'ll generate an AI image for you.\n\n**Example**\n\n> <i>A futuristic robot in a neon-lit city at night</i>'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('⬅️ Back', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function callbackHandler(ctx: Context): Promise<void> {
  try {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : null;
    if (!data) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery().catch(() => {});

    const botCtx = ctx as BotContext;

    switch (data) {
      case 'home':
        await handleHome(botCtx);
        break;
      case 'chat':
        await handleFeature(botCtx, 'chat', 'Chat', 'Send me a message and I\'ll respond naturally.');
        break;
      case 'code':
        await handleFeature(botCtx, 'code', 'Code Assistant', 'Send me a coding problem and I\'ll help you solve it.');
        break;
      case 'translate':
        await handleFeature(botCtx, 'translate', 'Translate', 'Send me text to translate. I support Hindi, English, Urdu, Arabic, French.');
        break;
      case 'image_analysis':
        await handleFeature(botCtx, 'image_analysis', 'Image Analysis', 'Send me a photo and I\'ll analyze it.');
        break;
      case 'image_generate':
        await handleImageGenerate(botCtx);
        break;
      case 'file_summary':
        await handleFeature(botCtx, 'file_summary', 'File Summary', 'Send me a PDF, DOCX, or TXT file and I\'ll summarize it.');
        break;
      case 'settings':
        await handleSettings(botCtx);
        break;
      case 'admin':
        await handleAdmin(botCtx);
        break;
      case 'admin_analytics':
        await handleAdminAnalytics(botCtx);
        break;
      case 'admin_ai':
        await handleAdminAI(botCtx);
        break;
      case 'admin_ai_test':
        await handleAdminAITest(botCtx);
        break;
      case 'admin_channels':
        await handleChannelManager(botCtx);
        break;
      case 'channel_add':
        await handleChannelAddStart(botCtx);
        break;
      case 'channel_remove_list':
        await handleChannelRemoveList(botCtx);
        break;
      case 'channel_remove_confirm':
        await handleChannelRemoveConfirm(botCtx);
        break;
      case 'check_membership':
        await handleCheckMembership(botCtx);
        break;
      case 'admin_premium':
        await handleAdminPremiumPanel(botCtx);
        break;
      case 'premium_home':
        await handlePremiumHome(botCtx);
        break;
      case 'premium_set_price':
        await handleSetPrice(botCtx);
        break;
      case 'admin_broadcast':
        await handleBroadcastStart(botCtx);
        break;
      case 'broadcast_send':
        await handleBroadcastSend(botCtx);
        break;
      case 'broadcast_cancel':
        await handleBroadcastCancel(botCtx);
        break;
      case 'premium_set_upi':
        await handleSetUpiId(botCtx);
        break;
      case 'premium_requests':
        await handleViewRequests(botCtx);
        break;
      case 'premium_manage':
        await handleManagePremiumUsers(botCtx);
        break;
      case 'premium_buy':
        await handleBuyPremium(botCtx);
        break;
      case 'premium_paid':
        await handlePaidConfirm(botCtx);
        break;
      case 'premium_add_manual':
        await handleAddPremiumManual(botCtx);
        break;
      case 'admin_identity':
        await handleAdminIdentity(botCtx);
        break;
      case 'admin_identity_edit_name':
        await handleAdminIdentityEdit(botCtx, 'name');
        break;
      case 'admin_identity_edit_creator':
        await handleAdminIdentityEdit(botCtx, 'creator');
        break;
      case 'admin_identity_edit_about':
        await handleAdminIdentityEdit(botCtx, 'about');
        break;
      case 'admin_identity_edit_personality':
        await handleAdminIdentityEdit(botCtx, 'personality');
        break;
      case 'language_menu':
        await handleLanguageMenu(botCtx);
        break;
      case 'lang_hinglish':
        await handleLanguageSet(botCtx, 'hinglish');
        break;
      case 'lang_hindi':
        await handleLanguageSet(botCtx, 'hindi');
        break;
      case 'lang_english':
        await handleLanguageSet(botCtx, 'english');
        break;
      case 'lang_arabic':
        await handleLanguageSet(botCtx, 'arabic');
        break;
      case 'lang_french':
        await handleLanguageSet(botCtx, 'french');
        break;
      case 'lang_urdu':
        await handleLanguageSet(botCtx, 'urdu');
        break;
      default:
        if (data.startsWith('premium_approve_')) {
          await handleApprovePayment(botCtx, data.replace('premium_approve_', ''));
        } else if (data.startsWith('premium_reject_')) {
          await handleRejectPayment(botCtx, data.replace('premium_reject_', ''));
        } else if (data.startsWith('premium_remove_')) {
          await handleRemovePremium(botCtx, data.replace('premium_remove_', ''));
        } else if (data.startsWith('channel_remove_')) {
          await handleChannelRemove(botCtx, data.replace('channel_remove_', ''));
        } else {
          await ctx.editMessageText(
            premium('🤖', 'TeleForge AI', 'Unknown command. Please try again.'),
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[coloredBtn('🏡 Home', 'home', 'primary')]] } },
          ).catch(() => {});
        }
    }
  } catch (error) {
    logger.error({ error, userId: ctx.from?.id, data: (ctx.callbackQuery as any)?.data }, 'Callback handler error');
    await ctx.reply(premium('❌', 'Something Went Wrong', 'Please try /start again.'), { parse_mode: 'HTML' }).catch(() => {});
  }
}

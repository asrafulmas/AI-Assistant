import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { generateResponse } from '../services/ai';
import { generateImage } from '../services/imageGen';
import { requireMembership } from '../services/channel';
import { rateLimit } from '../middleware/rateLimiter';
import { withLock } from '../middleware/lock';
import { BotContext, ChatMessage } from '../types';
import { splitMessage, deletePreviousBotMessages, trackBotMessage, premium, formatAIResponse, detectLanguage, checkImageDailyLimit } from '../utils/helpers';
import { CONFIG } from '../config';
import { captureMessageInfo, handleBroadcastConfirm } from './broadcast';
import { handlePaymentScreenshot, handleSaveUpiId, handleGrantPremiumManual } from './premium';
import { handleChannelAddInput } from './channel';

async function handleTranslation(ctx: BotContext, text: string, userId: number): Promise<void> {
  const typingInterval = setInterval(() => ctx.telegram.sendChatAction(ctx.chat!.id, 'typing').catch(() => {}), 4000);

  try {
    const messages: ChatMessage[] = [
      { role: 'user', content: `Translate the following text to the target language. Return the result with original, translation, and language details:\n\n${text}` },
    ];

    const response = await generateResponse(messages, 'translate', ctx.session.language);
    const parts = splitMessage(formatAIResponse(response.text), CONFIG.BOT.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      const msg = await ctx.reply(part, { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
    }

    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'translation', metadata: { textLength: text.length } as never },
    });
  } catch (error) {
    const msg = await ctx.reply(premium('❌', 'Translation Failed', error instanceof Error ? error.message : 'Please try again.'), { parse_mode: 'HTML' });
    trackBotMessage(ctx, msg.message_id);
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleImageUpload(ctx: BotContext, userId: number): Promise<void> {
  const typingInterval = setInterval(() => ctx.telegram.sendChatAction(ctx.chat!.id, 'typing').catch(() => {}), 4000);

  try {
    const photo = ctx.message && 'photo' in ctx.message ? ctx.message.photo : null;
    if (!photo || !Array.isArray(photo) || photo.length === 0) {
      const msg = await ctx.reply(premium('❌', 'No Image Found'), { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
      return;
    }

    const largestPhoto = photo[photo.length - 1];
    if (!largestPhoto || !('file_id' in largestPhoto)) {
      const msg = await ctx.reply(premium('❌', 'Could Not Process Image'), { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
      return;
    }

    const fileLink = await ctx.telegram.getFileLink(largestPhoto.file_id);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');

    const caption = 'caption' in (ctx.message ?? {}) && typeof (ctx.message as any).caption === 'string'
      ? (ctx.message as any).caption
      : 'Analyze this image in detail.';

    const messages: ChatMessage[] = [
      { role: 'user', content: `[Image: ${base64}]\nCaption: ${caption}` },
    ];

    const aiResponse = await generateResponse(messages, 'image_analysis', ctx.session.language);
    const parts = splitMessage(formatAIResponse(aiResponse.text), CONFIG.BOT.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      const msg = await ctx.reply(part, { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
    }

    await prisma.conversation.create({
      data: { userId: BigInt(userId), role: 'user', content: `[Image uploaded - ${caption}]` },
    });
    await prisma.conversation.create({
      data: { userId: BigInt(userId), role: 'assistant', content: aiResponse.text },
    });

    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'image_analysis', metadata: { caption } as never },
    });
    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'ai_response_usage', metadata: {} as never },
    });
  } catch (error) {
    const msg = await ctx.reply(premium('❌', 'Image Analysis Failed', error instanceof Error ? error.message : 'Please try again.'), { parse_mode: 'HTML' });
    trackBotMessage(ctx, msg.message_id);
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleFileUpload(ctx: BotContext, userId: number): Promise<void> {
  const typingInterval = setInterval(() => ctx.telegram.sendChatAction(ctx.chat!.id, 'typing').catch(() => {}), 4000);

  try {
    const document = ctx.message && 'document' in ctx.message ? ctx.message.document : null;
    if (!document) {
      const msg = await ctx.reply(premium('❌', 'No File Found'), { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
      return;
    }

    const fileLink = await ctx.telegram.getFileLink(document.file_id);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const fileName = document.file_name ?? 'unknown';
    const mimeType = document.mime_type ?? '';

    let fileContent: string;

    if (mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse') as unknown as (buf: Buffer) => Promise<{ text: string }>;
      const pdfData = await pdfParse(buffer);
      fileContent = pdfData.text.slice(0, 10000);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      fileContent = result.value.slice(0, 10000);
    } else if (mimeType.startsWith('text/')) {
      fileContent = buffer.toString('utf-8').slice(0, 10000);
    } else {
      const msg = await ctx.reply(premium('❌', 'Unsupported File Type', 'Supported: PDF, DOCX, TXT'), { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
      return;
    }

    const messages: ChatMessage[] = [
      { role: 'user', content: `Summarize this file "${fileName}":\n\n${fileContent}` },
    ];

    const aiResponse = await generateResponse(messages, 'file_summary', ctx.session.language);
    const parts = splitMessage(formatAIResponse(aiResponse.text), CONFIG.BOT.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      const msg = await ctx.reply(part, { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
    }

    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'file_summary', metadata: { fileName, mimeType, size: buffer.length } as never },
    });
    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'ai_response_usage', metadata: {} as never },
    });
  } catch (error) {
    const msg = await ctx.reply(premium('❌', 'File Summarization Failed', error instanceof Error ? error.message : 'Please try again.'), { parse_mode: 'HTML' });
    trackBotMessage(ctx, msg.message_id);
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleTextMessage(ctx: BotContext, text: string, userId: number, mode: string): Promise<void> {
  const typingInterval = setInterval(() => ctx.telegram.sendChatAction(ctx.chat!.id, 'typing').catch(() => {}), 4000);

  try {
    await deletePreviousBotMessages(ctx);

    const conversationsCount = await prisma.conversation.count({ where: { userId: BigInt(userId) } });
    if (conversationsCount >= CONFIG.BOT.MAX_CONVERSATION_LENGTH) {
      const oldestMessages = await prisma.conversation.findMany({
        where: { userId: BigInt(userId) },
        orderBy: { createdAt: 'asc' },
        take: conversationsCount - CONFIG.BOT.KEEP_LAST_MESSAGES,
        select: { id: true },
      });

      if (oldestMessages.length > 0) {
        await prisma.conversation.deleteMany({
          where: { id: { in: oldestMessages.map((m) => m.id) } },
        });
      }
    }

    await prisma.conversation.create({
      data: { userId: BigInt(userId), role: 'user', content: text },
    });

    const recentConversations = await prisma.conversation.findMany({
      where: { userId: BigInt(userId) },
      orderBy: { createdAt: 'asc' },
      take: CONFIG.BOT.KEEP_LAST_MESSAGES,
    });

    const messages: ChatMessage[] = recentConversations.map((c) => ({
      role: c.role as 'user' | 'assistant',
      content: c.content,
    }));

    const detectedLang = detectLanguage(text);
    const response = await generateResponse(messages, mode, detectedLang);
    const parts = splitMessage(formatAIResponse(response.text), CONFIG.BOT.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      const msg = await ctx.reply(part, { parse_mode: 'HTML' });
      trackBotMessage(ctx, msg.message_id);
    }

    await prisma.conversation.create({
      data: { userId: BigInt(userId), role: 'assistant', content: response.text },
    });

    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'ai_response_usage', metadata: { mode, textLength: text.length } as never },
    });
  } catch (error) {
    const msg = await ctx.reply(premium('❌', 'An Error Occurred', error instanceof Error ? error.message : 'Please try again.'), { parse_mode: 'HTML' });
    trackBotMessage(ctx, msg.message_id);
  } finally {
    clearInterval(typingInterval);
  }
}

export async function messageHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!rateLimit(ctx)) return;

  const member = await requireMembership(ctx, userId);
  if (!member) return;

  const botCtx = ctx as BotContext;
  const mode = botCtx.session.mode ?? 'chat';

  const result = await withLock(userId, async () => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : null;

    if (text && text.startsWith('/')) {
      return;
    }

    if (botCtx.session.awaitingBroadcastMessage) {
      const info = captureMessageInfo(ctx);
      if (info) {
        await handleBroadcastConfirm(ctx, info);
      }
      return;
    }

    if (botCtx.session.awaitingPaymentScreenshot) {
      await handlePaymentScreenshot(botCtx);
      return;
    }

    if (botCtx.session.awaitingUpiIdInput && text) {
      await handleSaveUpiId(botCtx, text);
      return;
    }

    if (botCtx.session.awaitingManualPremiumUserId && text) {
      await handleGrantPremiumManual(botCtx, text);
      return;
    }

    if (botCtx.session.awaitingChannelAddInput) {
      const msg = ctx.message as any;
      if (msg?.forward_from_chat) {
        await handleChannelAddInput(botCtx, '', msg.forward_from_chat);
        return;
      }
      if (msg?.forward_from) {
        await ctx.reply(premium('❌', 'Forward From User', 'Please forward a message from a **channel**, not a user.\n\nAlternatively, send the channel @username or link directly.'), { parse_mode: 'HTML' }).catch(() => {});
        return;
      }
      if (text) {
        await handleChannelAddInput(botCtx, text);
        return;
      }
    }

    if (botCtx.session.awaitingTranslation && text) {
      botCtx.session.awaitingTranslation = false;
      await handleTranslation(botCtx, text, userId);
      return;
    }

    if (botCtx.session.awaitingImagePrompt && text) {
      botCtx.session.awaitingImagePrompt = false;
      await handleImageGenPrompt(botCtx, text, userId);
      return;
    }

    if (botCtx.session.awaitingSettingKey && text) {
      const key = botCtx.session.awaitingSettingKey;
      botCtx.session.awaitingSettingKey = null;

      const settingKeys: Record<string, string> = {
        name: 'bot_name',
        creator: 'creator_username',
        about: 'about_text',
        personality: 'ai_personality',
      };

      const settingKey = settingKeys[key] || key;
      await prisma.setting.upsert({
        where: { key: settingKey },
        update: { value: text },
        create: { key: settingKey, value: text },
      });

      await ctx.reply(premium('✅', 'Setting Saved', `\`${settingKey}\` has been updated.`), { parse_mode: 'HTML' });
      return;
    }

    if (ctx.message && 'photo' in ctx.message) {
      await handleImageUpload(botCtx, userId);
      return;
    }

    const document = ctx.message && 'document' in ctx.message ? ctx.message.document : null;
    if (document) {
      await handleFileUpload(botCtx, userId);
      return;
    }

    if (text) {
      if (botCtx.session.awaitingChannelUsername) {
        await handleChannelUsername(botCtx, text, userId);
        return;
      }
      await handleTextMessage(botCtx, text, userId, mode);
    }
  }, ctx);

  if (result === undefined) return;
}

async function handleImageGenPrompt(ctx: BotContext, prompt: string, userId: number): Promise<void> {
  const typingInterval = setInterval(() => ctx.telegram.sendChatAction(ctx.chat!.id, 'upload_photo').catch(() => {}), 4000);

  try {
    const limit = await checkImageDailyLimit(prisma, userId);
    if (!limit.allowed) {
      const isPremium = (ctx.state.dbUser?.isPremium ?? false);
      const upsell = premium('❌', 'Daily Limit Reached',
        isPremium
          ? `You have used ${limit.used}/${limit.limit} image generations today.\n\nTry again tomorrow.`
          : `You have used ${limit.used}/${limit.limit} image generations today.\n\n💎 Upgrade to Premium for ${limit.limit === 5 ? CONFIG.IMAGE.DAILY_LIMIT_PREMIUM : 50} generations per day!`
      );
      const buttons = isPremium
        ? []
        : [[{ text: '💎 Premium', callback_data: 'premium_home' }]];
      const msg = await ctx.reply(upsell, {
        parse_mode: 'HTML',
        ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
      trackBotMessage(ctx, msg.message_id);
      return;
    }

    const msg = await ctx.reply(premium('🖼', 'TeleForge AI', 'Generating your image...'), { parse_mode: 'HTML' });

    const result = await generateImage(prompt);

    if (result.success && result.buffer) {
      await ctx.telegram.sendPhoto(ctx.chat!.id, { source: result.buffer }, {
        caption: premium('🖼', 'AI Generated', `**Prompt**\n\n> ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}\n\n━━━━━━━━━━━━━━\n\n<i>Powered by @TeleforgeOfficial</i>`),
        parse_mode: 'HTML',
      });
    } else {
      await ctx.reply(premium('❌', 'Image Generation Failed', result.error), { parse_mode: 'HTML' });
    }

    await ctx.telegram.deleteMessage(ctx.chat!.id, msg.message_id).catch(() => {});

    await prisma.analytics.create({
      data: { userId: BigInt(userId), event: 'image_generate', metadata: { promptLength: prompt.length, success: result.success } as never },
    });
  } catch (error) {
    await ctx.reply(premium('❌', 'Image Generation Failed'), { parse_mode: 'HTML' });
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleChannelUsername(ctx: BotContext, username: string, userId: number): Promise<void> {
  ctx.session.awaitingChannelUsername = false;

  try {
    const chat = await ctx.telegram.getChat(username);
    const administrators = await ctx.telegram.getChatAdministrators(username);
    const isBotAdmin = administrators.some((a) => a.user.id === ctx.botInfo.id);

    if (!isBotAdmin) {
      await ctx.reply(premium('❌', `Bot Is Not An Admin In ${username}`, 'Please add the bot as an administrator first, then try again.'), { parse_mode: 'HTML' });
      return;
    }

    const chatTitle = 'title' in chat ? chat.title : username;

    await prisma.channel.create({
      data: { chatId: chat.id.toString(), title: chatTitle, username },
    });

    await ctx.reply(premium('✅', 'Channel Added Successfully', `📢 ${chatTitle} (${username})\n\nMembers will now need to join this channel to use the bot.`), { parse_mode: 'HTML' });

    await prisma.log.create({
      data: { level: 'info', message: `Channel added: ${username}`, metadata: { userId, channel: username } as never },
    });
  } catch (error) {
    await ctx.reply(premium('❌', 'Could Not Add Channel', 'Make sure:\n1. The username/channel ID is correct\n2. The bot is an admin in the channel\n3. The channel is public'), { parse_mode: 'HTML' });
  }
}

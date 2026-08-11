import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';

export async function handleBroadcastStart(ctx: BotContext): Promise<void> {
  ctx.session.awaitingBroadcastMessage = true;
  ctx.session.broadcastMessageInfo = null;

  await ctx.editMessageText(
    premium('📣', 'Broadcast Message', 'Send any message you want to broadcast.\n\n━━━━━━━━━━━━━━\n\n**Supported Message Types**\n\n• Text\n• Photo\n• Video\n• Document\n• Animation\n• Sticker\n• Audio\n• Voice\n\n━━━━━━━━━━━━━━\n\nYou may also forward a message.\nThe message will be copied exactly and sent to all users.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('❌ Cancel', 'broadcast_cancel', 'danger')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleBroadcastCancel(ctx: BotContext): Promise<void> {
  ctx.session.awaitingBroadcastMessage = false;
  ctx.session.broadcastMessageInfo = null;

  const { handleAdmin } = await import('./callback');
  await handleAdmin(ctx);
}

export async function handleBroadcastConfirm(ctx: Context, messageInfo: any): Promise<void> {
  const botCtx = ctx as BotContext;
  botCtx.session.awaitingBroadcastMessage = false;
  botCtx.session.broadcastMessageInfo = messageInfo;

  const totalUsers = await prisma.user.count();

  await ctx.reply(
    premium('📣', 'Broadcast Preview Ready', `**Recipients**\n\n• **Total Users:** ${totalUsers}\n\n━━━━━━━━━━━━━━\n\nReady to send this broadcast?`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('✅ Send Broadcast', 'broadcast_send', 'success')],
          [coloredBtn('❌ Cancel', 'broadcast_cancel', 'danger')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleBroadcastSend(ctx: BotContext): Promise<void> {
  const messageInfo = ctx.session.broadcastMessageInfo;
  if (!messageInfo) {
    await ctx.editMessageText(premium('❌', 'No Message To Broadcast'), { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  await ctx.editMessageText(
    premium('📣', 'Broadcasting', 'Sending message to all users...'),
    { parse_mode: 'HTML' },
  ).catch(() => {});

  const allUsers = await prisma.user.findMany({ select: { telegramId: true } });
  let sent = 0;
  let failed = 0;
  const total = allUsers.length;

  for (const user of allUsers) {
    try {
      const chatId = Number(user.telegramId);
      await sendMessageByInfo(ctx, chatId, messageInfo);
      sent++;
    } catch (error) {
      failed++;
      logger.warn({ error: String(error), userId: Number(user.telegramId) }, 'Broadcast send failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Broadcast completed`,
      metadata: { total, sent, failed } as never,
    },
  });

  ctx.session.broadcastMessageInfo = null;

  await ctx.reply(
    premium('📣', 'Broadcast Complete', `**Results**\n\n• ✅ **Sent:** ${sent}\n• ❌ **Failed:** ${failed}\n• 👥 **Total:** ${total}`),
    { parse_mode: 'HTML' },
  ).catch(() => {});
}

async function sendMessageByInfo(ctx: Context, chatId: number, info: any): Promise<void> {
  const { fromChatId, messageId, type, text, fileId, caption } = info;

  if (fromChatId && messageId) {
    try {
      await ctx.telegram.copyMessage(chatId, fromChatId, messageId);
      return;
    } catch {
    }
  }

  switch (type) {
    case 'text':
      await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      break;
    case 'photo':
      await ctx.telegram.sendPhoto(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'video':
      await ctx.telegram.sendVideo(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'document':
      await ctx.telegram.sendDocument(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'animation':
      await ctx.telegram.sendAnimation(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'audio':
      await ctx.telegram.sendAudio(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'voice':
      await ctx.telegram.sendVoice(chatId, fileId, { caption, parse_mode: 'HTML' });
      break;
    case 'sticker':
      await ctx.telegram.sendSticker(chatId, fileId);
      break;
    default:
      if (text) await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      break;
  }
}

export function captureMessageInfo(ctx: Context): any | null {
  const msg = ctx.message as any;
  if (!msg) return null;

  const chatId = ctx.chat?.id;
  const messageId = msg.message_id;

  if (chatId && messageId) {
    return { type: 'forward', fromChatId: chatId, messageId };
  }

  const caption = msg.caption || undefined;
  const entities = msg.entities || msg.caption_entities || undefined;

  if (msg.text) {
    return { type: 'text', text: msg.text, entities };
  }
  if (msg.photo) {
    return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, caption, entities };
  }
  if (msg.video) {
    return { type: 'video', fileId: msg.video.file_id, caption, entities };
  }
  if (msg.document) {
    return { type: 'document', fileId: msg.document.file_id, caption, entities };
  }
  if (msg.animation) {
    return { type: 'animation', fileId: msg.animation.file_id, caption, entities };
  }
  if (msg.audio) {
    return { type: 'audio', fileId: msg.audio.file_id, caption, entities };
  }
  if (msg.voice) {
    return { type: 'voice', fileId: msg.voice.file_id, caption, entities };
  }
  if (msg.sticker) {
    return { type: 'sticker', fileId: msg.sticker.file_id };
  }

  return null;
}

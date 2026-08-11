import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { premium } from '../utils/helpers';
import { PROTECTED_CHANNEL } from '../config/protected';

export function getOfficialChannel() {
  return { ...PROTECTED_CHANNEL };
}

export async function getRequiredChannels() {
  return prisma.channel.findMany();
}

async function checkChannelMembership(ctx: Context, chatId: string, userId: number): Promise<boolean> {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return !['left', 'kicked', 'restricted'].includes(member.status);
  } catch {
    return false;
  }
}

export async function verifyMembership(ctx: Context, userId: number): Promise<boolean> {
  const channels = await prisma.channel.findMany();
  if (channels.length === 0) return true;

  for (const ch of channels) {
    const isChMember = await checkChannelMembership(ctx, ch.chatId, userId);
    if (!isChMember) return false;
  }
  return true;
}

export async function requireMembership(ctx: Context, userId: number): Promise<boolean> {
  const isMember = await verifyMembership(ctx, userId);
  if (isMember) return true;

  const official = getOfficialChannel();
  const channels = await prisma.channel.findMany();
  const buttons: any[][] = [];

  buttons.push([{ text: `📢 ${official.title}`, url: official.url }]);

  for (const ch of channels) {
    const link = ch.link ?? (ch.username ? `https://t.me/${ch.username.replace('@', '')}` : null);
    if (link) buttons.push([{ text: `📢 ${ch.title ?? ch.username}`, url: link }]);
  }

  buttons.push([{ text: '✅ Continue', callback_data: 'check_membership' }]);

  await ctx.reply(
    premium('📢', 'Join Required Channels', 'Please join all channels below and tap **Continue** to use this bot.'),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
  );

  return false;
}

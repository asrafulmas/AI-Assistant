import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { BotContext } from '../types';
import { premium } from '../utils/helpers';
import { PROTECTED_CHANNEL } from '../config/protected';

export async function setAdminHandler(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  const botCtx = ctx as BotContext;
  const fromUser = botCtx.state.dbUser;
  if (!fromUser?.isOwner) {
    await ctx.reply(premium('⛔', 'Only Owner Can Manage Admins'), { parse_mode: 'HTML' });
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : null;
  if (!text) {
    await ctx.reply(premium('❌', 'Usage', '`/setadmin <user_id>`'), { parse_mode: 'HTML' });
    return;
  }

  const targetId = text.split(' ')[1];
  if (!targetId) {
    await ctx.reply(premium('❌', 'Usage', '`/setadmin <user_id>`'), { parse_mode: 'HTML' });
    return;
  }

  const targetBigId = BigInt(targetId);

  const targetUser = await prisma.user.findUnique({ where: { telegramId: targetBigId } });
  if (!targetUser) {
    await ctx.reply(premium('❌', 'User Not Found', `\`${targetId}\``), { parse_mode: 'HTML' });
    return;
  }

  await prisma.user.update({
    where: { telegramId: targetBigId },
    data: { isAdmin: true },
  });

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Admin promotion: ${targetId} promoted by ${fromId}`,
      metadata: { targetId, promotedBy: fromId } as never,
    },
  });

  await ctx.reply(
    premium('✅', 'Admin Promoted', `User \`${targetId}\` is now an admin.`),
    { parse_mode: 'HTML' },
  );
}

export async function addChannelHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const botCtx = ctx as BotContext;
  const dbUser = botCtx.state.dbUser;
  if (!dbUser?.isAdmin && !dbUser?.isOwner) {
    await ctx.reply(premium('⛔', 'Admin Access Required'), { parse_mode: 'HTML' });
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : null;
  if (!text) {
    await ctx.reply(premium('❌', 'Usage', '`/addchannel <@username>`'), { parse_mode: 'HTML' });
    return;
  }

  const channelUsername = text.split(' ')[1];
  if (!channelUsername) {
    await ctx.reply(premium('❌', 'Usage', '`/addchannel <@username>`'), { parse_mode: 'HTML' });
    return;
  }

  try {
    const normalizedName = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
    if (normalizedName.toLowerCase() === PROTECTED_CHANNEL.username.toLowerCase()) {
      await ctx.reply(premium('⛔', 'Protected Channel', `${PROTECTED_CHANNEL.title} is protected and cannot be added manually.`), { parse_mode: 'HTML' });
      return;
    }

    const chat = await ctx.telegram.getChat(channelUsername);
    const administrators = await ctx.telegram.getChatAdministrators(channelUsername);
    const isBotAdmin = administrators.some((a) => a.user.id === ctx.botInfo.id);

    if (!isBotAdmin) {
      await ctx.reply(
        premium('❌', `Bot Not Admin In ${channelUsername}`, 'Please add the bot as an administrator first.'),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const chatTitle = 'title' in chat ? chat.title : channelUsername;

    const existing = await prisma.channel.findUnique({ where: { chatId: chat.id.toString() } });
    if (existing) {
      await ctx.reply(premium('⚠️', 'Channel Already Exists', `${chatTitle}`), { parse_mode: 'HTML' });
      return;
    }

    await prisma.channel.create({
      data: {
        chatId: chat.id.toString(),
        title: chatTitle,
        username: channelUsername,
      },
    });

    await ctx.reply(
      premium('✅', 'Channel Added', `📢 ${chatTitle} (${channelUsername})`),
      { parse_mode: 'HTML' },
    );

    await prisma.log.create({
      data: { level: 'info', message: `Channel added: ${channelUsername}`, metadata: { userId, channel: channelUsername } as never },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(
      premium('❌', 'Could Not Add Channel', `Make sure:\n1. The username/channel ID is correct\n2. The bot is an admin in the channel\n3. The channel is public\n\nError: \`${msg}\``),
      { parse_mode: 'HTML' },
    );
  }
}

export async function removeChannelHandler(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const botCtx = ctx as BotContext;
  const dbUser = botCtx.state.dbUser;
  if (!dbUser?.isAdmin && !dbUser?.isOwner) {
    await ctx.reply(premium('⛔', 'Admin Access Required'), { parse_mode: 'HTML' });
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : null;
  if (!text) {
    await ctx.reply(premium('❌', 'Usage', '`/removechannel <@username>`'), { parse_mode: 'HTML' });
    return;
  }

  const channelUsername = text.split(' ')[1];
  if (!channelUsername) {
    await ctx.reply(premium('❌', 'Usage', '`/removechannel <@username>`'), { parse_mode: 'HTML' });
    return;
  }

  const normalizedName = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
  if (normalizedName.toLowerCase() === PROTECTED_CHANNEL.username.toLowerCase()) {
    await ctx.reply(premium('⛔', 'Protected Channel', `${PROTECTED_CHANNEL.title} is protected and cannot be removed.`), { parse_mode: 'HTML' });
    return;
  }

  const channel = await prisma.channel.findFirst({ where: { username: channelUsername } });
  if (!channel) {
    await ctx.reply(premium('❌', 'Channel Not Found', channelUsername), { parse_mode: 'HTML' });
    return;
  }

  await prisma.channel.delete({ where: { id: channel.id } });

  await prisma.log.create({
    data: { level: 'info', message: `Channel removed: ${channelUsername}`, metadata: { userId, channel: channelUsername } as never },
  });

  await ctx.reply(
    premium('✅', 'Channel Removed', channelUsername),
    { parse_mode: 'HTML' },
  );
}

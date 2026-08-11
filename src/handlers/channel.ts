import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';
import { logger } from '../utils/logger';
import { PROTECTED_CHANNEL } from '../config/protected';

export async function handleChannelManager(ctx: BotContext): Promise<void> {
  await ctx.editMessageText(
    premium('📢', 'Channel Manager', 'Manage required membership channels.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('➕ Add Channel', 'channel_add', 'success')],
          [coloredBtn('➖ Remove Channel', 'channel_remove_list', 'danger')],
          [coloredBtn('🔙 Back', 'admin', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleChannelAddStart(ctx: BotContext): Promise<void> {
  ctx.session.awaitingChannelAddInput = true;

  await ctx.editMessageText(
    premium('➕', 'Add Channel', 'Forward any message from your channel\nOR send channel username/link.\n\n━━━━━━━━━━━━━━\n\n**Examples**\n\n• \`@mychannel\`\n• \`https://t.me/mychannel\`'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔙 Cancel', 'admin_channels', 'danger')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleChannelAddInput(ctx: BotContext, input: string, forwardChat?: any): Promise<void> {
  ctx.session.awaitingChannelAddInput = false;

  let chatId: string;
  let username: string | null;
  let title: string;
  let link: string | null;

  try {
    if (forwardChat) {
      chatId = forwardChat.id.toString();
      title = forwardChat.title ?? 'Unknown Channel';
      username = forwardChat.username ? `@${forwardChat.username}` : null;

      if (username?.toLowerCase() === PROTECTED_CHANNEL.username.toLowerCase()) {
        await ctx.reply(premium('⛔', 'Protected Channel', `The channel **${PROTECTED_CHANNEL.title}** is protected and cannot be added manually.`), { parse_mode: 'HTML' });
        return;
      }
      link = forwardChat.username
        ? `https://t.me/${forwardChat.username}`
        : null;

      const chat = await ctx.telegram.getChat(chatId);
      if (!chat) {
        await ctx.reply(premium('❌', 'Cannot Access Chat', `I cannot access **${title}**.\n\nMake sure I am a member of this chat first.`), { parse_mode: 'HTML' });
        return;
      }
      title = 'title' in chat ? chat.title : title;
      username = 'username' in chat && chat.username ? `@${chat.username}` : username;

      const member = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
      if (!['administrator', 'creator'].includes(member.status)) {
        await ctx.reply(
          premium('❌', 'Not An Admin', `I am not an admin in **${title}**.\n\nPlease add me as an administrator and try again.`),
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (!link) {
        try {
          const inviteLink = await ctx.telegram.exportChatInviteLink(chatId);
          link = inviteLink;
        } catch {
          // invite link not available
        }
      }
    } else {
      if (input.startsWith('https://t.me/')) {
        username = `@${input.replace('https://t.me/', '').split('/')[0]}`;
      } else if (input.startsWith('@')) {
        username = input;
      } else {
        username = `@${input}`;
      }

      const chat = await ctx.telegram.getChat(username);
      chatId = chat.id.toString();
      title = 'title' in chat ? chat.title : username;
      link = `https://t.me/${username.replace('@', '')}`;

      const member = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
      if (!['administrator', 'creator'].includes(member.status)) {
        await ctx.reply(
          premium('❌', 'Not An Admin', `I am not an admin in ${username}.\n\nPlease add me as an administrator and try again.`),
          { parse_mode: 'HTML' },
        );
        return;
      }
    }

    if (username?.toLowerCase() === PROTECTED_CHANNEL.username.toLowerCase()) {
    await ctx.reply(premium('⛔', 'Protected Channel', `The channel **${PROTECTED_CHANNEL.title}** is protected and cannot be added manually.`), { parse_mode: 'HTML' });
    return;
  }

  const existing = await prisma.channel.findUnique({ where: { chatId } });
    if (existing) {
      await ctx.reply(premium('⚠️', 'Channel Already Exists', `**${title}**`), { parse_mode: 'HTML' });
      return;
    }

    await prisma.channel.create({
      data: { chatId, username, title, link },
    });

    const displayLink = link ?? '🔒 Private channel (no invite link)';
    await ctx.reply(premium('✅', 'Channel Added Successfully', `📢 ${title}\n🔗 ${displayLink}`), { parse_mode: 'HTML' });

    await prisma.log.create({
      data: { level: 'info', message: `Channel added: ${username ?? chatId}`, metadata: { userId: ctx.from?.id } as never },
    });
  } catch (error: any) {
    logger.error({ error: error?.message ?? error, stack: error?.stack, description: error?.description, parameters: error?.parameters }, 'Channel add failed');
    await ctx.reply(
      premium('❌', 'Could Not Add Channel', 'Make sure:\n1. The username/channel ID is correct\n2. The bot is an admin in the channel'),
      { parse_mode: 'HTML' },
    );
  }
}

export async function handleChannelRemoveList(ctx: BotContext): Promise<void> {
  const channels = await prisma.channel.findMany();

  if (channels.length === 0) {
    await ctx.editMessageText(
      premium('📢', 'Remove Channel', `**🔒 ${PROTECTED_CHANNEL.title}** is protected and cannot be removed.\n\n━━━━━━━━━━━━━━\n\nNo additional channels configured.`),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [coloredBtn('🔙 Back', 'admin_channels', 'primary')],
          ],
        },
      },
    ).catch(() => {});
    return;
  }

  const officialText = `• 🔒 **${PROTECTED_CHANNEL.title}** (protected, cannot be removed)`;
  const channelList = channels.map((c) => `• **${c.title ?? c.username ?? 'Private Channel'}**`).join('\n');
  const text = `${officialText}\n${channelList}`;

  const buttons: any[][] = [];
  for (const ch of channels) {
    buttons.push([coloredBtn(`❌ ${ch.title ?? ch.username ?? 'Private Channel'}`, `channel_remove_${ch.id}`, 'danger')]);
  }
  buttons.push([coloredBtn('🔙 Back', 'admin_channels', 'primary')]);

  await ctx.editMessageText(
    premium('📢', 'Remove Channel', `${text}\n\n━━━━━━━━━━━━━━\n\nTap a channel to remove it.`),
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    },
  ).catch(() => {});
}

export async function handleChannelRemove(ctx: BotContext, channelIdStr: string): Promise<void> {
  const channelId = BigInt(channelIdStr);
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    await ctx.answerCbQuery('Channel not found.');
    return;
  }

  ctx.session.awaitingChannelRemoveId = channelIdStr;

  await ctx.editMessageText(
    premium('❌', `Remove ${channel.title ?? channel.username ?? 'Private Channel'}?`, '> This action cannot be undone.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('✅ Remove', 'channel_remove_confirm', 'danger')],
          [coloredBtn('❌ Cancel', 'admin_channels', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleChannelRemoveConfirm(ctx: BotContext): Promise<void> {
  const idStr = ctx.session.awaitingChannelRemoveId;
  ctx.session.awaitingChannelRemoveId = undefined;

  if (!idStr) {
    await ctx.editMessageText(premium('❌', 'No Channel Selected'), { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  await prisma.channel.delete({ where: { id: BigInt(idStr) } });

  await ctx.editMessageText(premium('✅', 'Channel Removed'), { parse_mode: 'HTML' }).catch(() => {});

  await prisma.log.create({
    data: { level: 'info', message: `Channel removed: ${idStr}`, metadata: { userId: ctx.from?.id } as never },
  });
}

export async function handleCheckMembership(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const msg = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : null;

  const channels = await prisma.channel.findMany();
  const isMember = await (async () => {
    if (channels.length === 0) return true;

    for (const ch of channels) {
      try {
        const member = await ctx.telegram.getChatMember(ch.chatId, userId);
        if (['left', 'kicked', 'restricted'].includes(member.status)) return false;
      } catch { return false; }
    }
    return true;
  })();

  if (isMember) {
    await ctx.answerCbQuery('✅ All channels joined!');
    if (msg) await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    const { startHandler } = await import('./start');
    await startHandler(ctx);
  } else {
    await ctx.answerCbQuery('❌ Please join all channels first.');
    if (msg) await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

    const official = { title: PROTECTED_CHANNEL.title, url: PROTECTED_CHANNEL.url };
    const buttons: any[][] = [[{ text: `📢 ${official.title}`, url: official.url }]];

    for (const ch of channels) {
      const link = ch.link ?? (ch.username ? `https://t.me/${ch.username.replace('@', '')}` : null);
      if (link) buttons.push([{ text: `📢 ${ch.title ?? ch.username}`, url: link }]);
    }
    buttons.push([{ text: '✅ Continue', callback_data: 'check_membership' }]);

    await ctx.reply(
      premium('📢', 'Join Required Channels', 'Please join all channels and tap **Continue** again.'),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    ).catch(() => {});
  }
}

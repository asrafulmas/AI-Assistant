import { prisma } from '../database/prisma';
import { BotContext } from '../types';
import { premium, coloredBtn } from '../utils/helpers';

export async function handlePremiumHome(ctx: BotContext): Promise<void> {
  const priceSetting = await prisma.setting.findUnique({ where: { key: 'premium_price' } });
  const price = priceSetting?.value ?? '99';

  await ctx.editMessageText(
    premium('💎', 'Premium Membership', `**Price**\n\n> ₹${price}\n\n━━━━━━━━━━━━━━\n\n**Benefits**\n\n• 🎯 Priority support\n• 🚀 Faster responses\n• 🎨 Exclusive features\n• 🔓 No limits`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('💳 Buy Premium', 'premium_buy', 'success')],
          [coloredBtn('🔙 Back', 'home', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleAdminPremiumPanel(ctx: BotContext): Promise<void> {
  const dbUser = ctx.state.dbUser;
  const isAdmin = dbUser?.isAdmin || dbUser?.isOwner;
  if (!isAdmin) return;

  await ctx.editMessageText(
    premium('💎', 'Premium Manager', 'Manage premium features and user subscriptions.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('💰 Set Price', 'premium_set_price', 'danger')],
          [coloredBtn('💳 Set UPI ID', 'premium_set_upi', 'danger')],
          [coloredBtn('👤 Add Premium User', 'premium_add_manual', 'success')],
          [coloredBtn('📋 Pending Requests', 'premium_requests', 'danger')],
          [coloredBtn('🔙 Back', 'admin', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleSetPrice(ctx: BotContext): Promise<void> {
  ctx.session.awaitingSettingKey = 'premium_price';

  await ctx.editMessageText(
    premium('💰', 'Set Premium Price', 'Send the price in Indian Rupees (INR).\n\n━━━━━━━━━━━━━━\n\n**Examples**\n\n• \`99\`\n• \`199\`\n• \`299\`'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔙 Back', 'admin_premium', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleSetUpiId(ctx: BotContext): Promise<void> {
  ctx.session.awaitingUpiIdInput = true;

  await ctx.editMessageText(
    premium('💳', 'Set UPI ID', 'Send your UPI ID for payment collection.\n\n━━━━━━━━━━━━━━\n\n**Examples**\n\n• \`name@paytm\`\n• \`name@upi\`'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔙 Back', 'admin_premium', 'primary')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleSaveUpiId(ctx: BotContext, upiId: string): Promise<void> {
  ctx.session.awaitingUpiIdInput = false;

  await prisma.setting.upsert({
    where: { key: 'upi_id' },
    update: { value: upiId },
    create: { key: 'upi_id', value: upiId },
  });

  await ctx.reply(premium('✅', 'UPI ID Saved', `\`${upiId}\``), { parse_mode: 'HTML' });

  await handleAdminPremiumPanel(ctx);
}

export async function handleViewRequests(ctx: BotContext): Promise<void> {
  const pending = await prisma.paymentRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });

  if (pending.length === 0) {
    await ctx.editMessageText(
      premium('📋', 'Payment Requests', 'No pending requests.'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [coloredBtn('🔄 Refresh', 'premium_requests', 'primary')],
            [coloredBtn('🔙 Back', 'admin_premium', 'primary')],
          ],
        },
      },
    ).catch(() => {});
    return;
  }

  await ctx.editMessageText(
    premium('📋', 'Payment Requests', `**${pending.length}** pending request(s) found.`),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔄 Refresh', 'premium_requests', 'primary')],
          [coloredBtn('🔙 Back', 'admin_premium', 'primary')],
        ],
      },
    },
  ).catch(() => {});

  for (const req of pending) {
    const userTag = req.username ? `@${req.username}` : `User ${req.telegramId}`;
    const text = premium('💎', 'Premium Purchase Request',
      `**User Details**\n\n• **User:** ${userTag}\n• **ID:** \`${req.telegramId}\`\n• **Name:** ${req.firstName ?? 'N/A'}\n• **Time:** ${req.createdAt.toLocaleString()}`
    );

    try {
      await ctx.telegram.sendPhoto(ctx.chat!.id, req.screenshotFileId, {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              coloredBtn('✅ Approve', `premium_approve_${req.id}`, 'success'),
              coloredBtn('❌ Reject', `premium_reject_${req.id}`, 'danger'),
            ],
          ],
        },
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              coloredBtn('✅ Approve', `premium_approve_${req.id}`, 'success'),
              coloredBtn('❌ Reject', `premium_reject_${req.id}`, 'danger'),
            ],
          ],
        },
      }).catch(() => {});
    }
  }
}

export async function handleBuyPremium(ctx: BotContext): Promise<void> {
  const upiSetting = await prisma.setting.findUnique({ where: { key: 'upi_id' } });
  const upiId = upiSetting?.value;

  if (!upiId) {
    await ctx.editMessageText(
      premium('❌', 'UPI Not Configured', 'Premium purchase is not available yet. Please contact the administrator.'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [coloredBtn('🔙 Back', 'home', 'primary')],
          ],
        },
      },
    ).catch(() => {});
    return;
  }

  const upiLink = `upi://pay?pa=${upiId}&pn=TeleForge&cu=INR`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiLink)}`;

  const text = premium('💎', 'Premium Purchase', `Complete payment using the UPI ID below.\n\n━━━━━━━━━━━━━━\n\n**UPI ID**\n\n\`${upiId}\`\n\n━━━━━━━━━━━━━━\n\nAfter payment, tap **✅ Paid** to confirm.`);

  try {
    await ctx.telegram.sendPhoto(ctx.chat!.id, qrUrl, {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('✅ Paid', 'premium_paid', 'success')],
          [coloredBtn('🔙 Back', 'home', 'primary')],
        ],
      },
    });
  } catch {
    await ctx.editMessageText(text + '\n\n[QR Code could not be generated]', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('✅ Paid', 'premium_paid', 'success')],
          [coloredBtn('🔙 Back', 'home', 'primary')],
        ],
      },
    }).catch(() => {});
  }
}

export async function handlePaidConfirm(ctx: BotContext): Promise<void> {
  ctx.session.awaitingPaymentScreenshot = true;

  if (ctx.callbackQuery && 'message' in ctx.callbackQuery) {
    await ctx.deleteMessage().catch(() => {});
  }

  await ctx.reply(
    premium('📸', 'Send Screenshot', 'Please send your payment screenshot.\n\nOnly image allowed.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔙 Cancel', 'home', 'danger')],
        ],
      },
    },
  );
}

export async function handlePaymentScreenshot(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  ctx.session.awaitingPaymentScreenshot = false;

  const msg = ctx.message as any;
  let fileId: string | null = null;

  if (msg.photo) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  }

  if (!fileId) {
    await ctx.reply(
      premium('❌', 'Please Send An Image', 'Only image screenshots are accepted for payment verification.'),
      { parse_mode: 'HTML' },
    );
    ctx.session.awaitingPaymentScreenshot = true;
    return;
  }

  const dbUser = ctx.state.dbUser;
  const request = await prisma.paymentRequest.create({
    data: {
      userId: BigInt(userId),
      telegramId: BigInt(userId),
      username: dbUser?.username ?? null,
      firstName: dbUser?.firstName ?? null,
      screenshotFileId: fileId,
      status: 'PENDING',
    },
  });

  await ctx.reply(
    premium('✅', 'Payment Submitted', 'Your payment screenshot has been received.\n\nAn admin will review and approve it shortly.'),
    { parse_mode: 'HTML' },
  );

  const admins = await prisma.user.findMany({
    where: { OR: [{ isAdmin: true }, { isOwner: true }] },
  });

  const userTag = dbUser?.username ? `@${dbUser.username}` : `User ${userId}`;
  const text = premium('💎', 'Premium Purchase Request',
    `**User Details**\n\n• **User:** ${userTag}\n• **ID:** \`${userId}\`\n• **Name:** ${dbUser?.firstName ?? 'N/A'}\n• **Time:** ${request.createdAt.toLocaleString()}`
  );

  for (const admin of admins) {
    try {
      await ctx.telegram.sendPhoto(Number(admin.telegramId), fileId, {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              coloredBtn('✅ Approve', `premium_approve_${request.id}`, 'success'),
              coloredBtn('❌ Reject', `premium_reject_${request.id}`, 'danger'),
            ],
          ],
        },
      });
    } catch {
      // skip if admin blocked bot
    }
  }

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Premium payment request created by user ${userId}`,
      metadata: { requestId: Number(request.id) } as never,
    },
  });
}

export async function handleApprovePayment(ctx: BotContext, requestIdStr: string): Promise<void> {
  const adminId = ctx.from?.id;
  if (!adminId) return;

  const requestId = BigInt(requestIdStr);
  const req = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
  if (!req || req.status !== 'PENDING') {
    await ctx.answerCbQuery('Request not found or already processed.');
    return;
  }

  await prisma.paymentRequest.update({
    where: { id: requestId },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: BigInt(adminId) },
  });

  await prisma.user.update({
    where: { telegramId: req.telegramId },
    data: { isPremium: true, premiumUntil: new Date(Date.now() + 365 * 86400000) },
  });

  try {
    await ctx.telegram.sendMessage(
      Number(req.telegramId),
      premium('✅', 'Premium Activated', 'Your payment has been approved.\n\nEnjoy Premium access.'),
      { parse_mode: 'HTML' },
    );
  } catch {
    // user may have blocked bot
  }

  await ctx.answerCbQuery('Payment approved. User notified.');

  const msg = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
  if (msg) await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Premium approved for user ${req.telegramId} by admin ${adminId}`,
      metadata: { requestId: requestIdStr, adminId } as never,
    },
  });
}

export async function handleRejectPayment(ctx: BotContext, requestIdStr: string): Promise<void> {
  const adminId = ctx.from?.id;
  if (!adminId) return;

  const requestId = BigInt(requestIdStr);
  const req = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
  if (!req || req.status !== 'PENDING') {
    await ctx.answerCbQuery('Request not found or already processed.');
    return;
  }

  await prisma.paymentRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', approvedAt: new Date(), approvedBy: BigInt(adminId) },
  });

  try {
    await ctx.telegram.sendMessage(
      Number(req.telegramId),
      premium('❌', 'Payment Not Approved', 'Your payment could not be verified.\n\nPlease contact the administrator.'),
      { parse_mode: 'HTML' },
    );
  } catch {
    // user may have blocked bot
  }

  await ctx.answerCbQuery('Payment rejected. User notified.');

  const msg2 = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message : undefined;
  if (msg2) await ctx.telegram.deleteMessage(msg2.chat.id, msg2.message_id).catch(() => {});

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Premium rejected for user ${req.telegramId} by admin ${adminId}`,
      metadata: { requestId: requestIdStr, adminId } as never,
    },
  });
}

export async function handleManagePremiumUsers(ctx: BotContext): Promise<void> {
  const premiumUsers = await prisma.user.findMany({
    where: { isPremium: true },
    orderBy: { premiumUntil: 'desc' },
  });

  if (premiumUsers.length === 0) {
    await ctx.editMessageText(
      premium('👤', 'Premium Users', 'No premium users yet.'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [coloredBtn('➕ Add Premium Manually', 'premium_add_manual', 'success')],
            [coloredBtn('🔙 Back', 'admin_premium', 'primary')],
          ],
        },
      },
    ).catch(() => {});
    return;
  }

  let list = '';
  for (const u of premiumUsers) {
    const tag = u.username ? `@${u.username}` : 'N/A';
    const expiry = u.premiumUntil ? u.premiumUntil.toLocaleDateString() : 'N/A';
    list += `• 👤 ${tag} — \`${u.telegramId}\` — 📅 ${expiry}\n`;
  }

  const buttons: any[][] = [];
  for (const u of premiumUsers) {
    buttons.push([coloredBtn(`❌ Remove ${u.username ?? u.telegramId}`, `premium_remove_${u.telegramId}`, 'danger')]);
  }
  buttons.push([coloredBtn('➕ Add Premium Manually', 'premium_add_manual', 'success')]);
  buttons.push([coloredBtn('🔙 Back', 'admin_premium', 'primary')]);

  await ctx.editMessageText(
    premium('👤', 'Premium Users', `${list}`),
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    },
  ).catch(() => {});
}

export async function handleAddPremiumManual(ctx: BotContext): Promise<void> {
  ctx.session.awaitingManualPremiumUserId = true;

  await ctx.editMessageText(
    premium('➕', 'Add Premium Manually', 'Send the Telegram ID or @username of the user to grant premium.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [coloredBtn('🔙 Cancel', 'premium_manage', 'danger')],
        ],
      },
    },
  ).catch(() => {});
}

export async function handleGrantPremiumManual(ctx: BotContext, input: string): Promise<void> {
  ctx.session.awaitingManualPremiumUserId = false;

  let targetId: bigint;

  if (input.startsWith('@')) {
    const username = input.slice(1);
    const user = await prisma.user.findFirst({ where: { username } });
    if (!user) {
      await ctx.reply(premium('❌', 'User Not Found', `No user with username ${input}`), { parse_mode: 'HTML' });
      return;
    }
    targetId = user.telegramId;
  } else {
    try {
      targetId = BigInt(input);
    } catch {
      await ctx.reply(premium('❌', 'Invalid Input', 'Please send a valid Telegram ID or @username.'), { parse_mode: 'HTML' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { telegramId: targetId } });
    if (!user) {
      await ctx.reply(premium('❌', 'User Not Found', `No user with ID ${input}`), { parse_mode: 'HTML' });
      return;
    }
  }

  await prisma.user.update({
    where: { telegramId: targetId },
    data: { isPremium: true, premiumUntil: new Date(Date.now() + 365 * 86400000) },
  });

  await ctx.reply(
    premium('✅', 'Premium Granted', `User \`${targetId}\` has been granted premium access for 1 year.`),
    { parse_mode: 'HTML' },
  );

  try {
    await ctx.telegram.sendMessage(
      Number(targetId),
      premium('✅', 'Premium Activated', 'You have been granted Premium access by the administrator.'),
      { parse_mode: 'HTML' },
    );
  } catch {
    // user may have blocked bot
  }

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Premium manually granted to ${targetId}`,
      metadata: { targetId: targetId.toString(), grantedBy: ctx.from?.id } as never,
    },
  });
}

export async function handleRemovePremium(ctx: BotContext, userIdStr: string): Promise<void> {
  const targetId = BigInt(userIdStr);

  await prisma.user.update({
    where: { telegramId: targetId },
    data: { isPremium: false, premiumUntil: null },
  });

  await ctx.answerCbQuery(`Premium removed from user ${userIdStr}`);

  try {
    await ctx.telegram.sendMessage(
      Number(targetId),
      premium('ℹ️', 'Premium Removed', 'Your premium access has been removed by the administrator.'),
      { parse_mode: 'HTML' },
    );
  } catch {
    // user may have blocked bot
  }

  await prisma.log.create({
    data: {
      level: 'info',
      message: `Premium removed from ${userIdStr}`,
      metadata: { targetId: userIdStr, removedBy: ctx.from?.id } as never,
    },
  });

  await handleManagePremiumUsers(ctx);
}

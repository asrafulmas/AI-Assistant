import { Context } from 'telegraf';
import { premium } from '../utils/helpers';

const COMMANDS = [
  { cmd: '/start', desc: 'Start TeleForge AI and show menu' },
  { cmd: '/help', desc: 'Show this help message' },
  { cmd: '/chat', desc: 'Chat with AI assistant' },
  { cmd: '/createimage', desc: 'Generate an AI image from text' },
  { cmd: '/code', desc: 'Get coding help from AI' },
  { cmd: '/translate', desc: 'Translate text between languages' },
  { cmd: '/settings', desc: 'Open settings panel' },
];

const ADMIN_COMMANDS = [
  { cmd: '/stats', desc: 'Show bot statistics' },
  { cmd: '/broadcast', desc: 'Send message to all users' },
  { cmd: '/addchannel', desc: 'Add required membership channel' },
  { cmd: '/removechannel', desc: 'Remove required membership channel' },
];

export async function helpHandler(ctx: Context): Promise<void> {
  const userCommands = COMMANDS.map(c => `• \`${c.cmd}\` — ${c.desc}`).join('\n');
  const adminCommands = ADMIN_COMMANDS.map(c => `• \`${c.cmd}\` — ${c.desc}`).join('\n');
  const dbUser = (ctx as any).state?.dbUser;
  const isAdmin = dbUser?.isAdmin || dbUser?.isOwner;

  let body = `**Available Commands**\n\n${userCommands}`;
  if (isAdmin) {
    body += `\n\n━━━━━━━━━━━━━━\n\n**Admin Commands**\n\n${adminCommands}`;
  }

  await ctx.reply(premium('📚', 'Help — TeleForge AI', body), { parse_mode: 'HTML' });
}

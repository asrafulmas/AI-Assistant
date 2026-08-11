import { PrismaClient } from '@prisma/client';
import { CONFIG } from '../config';

export function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage ?? 'Operation timed out'));
    }, ms);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitMessage(text: string, maxLength: number = 4000): string[] {
  const parts: string[] = [];

  if (text.length <= maxLength) {
    parts.push(text);
    return parts;
  }

  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt === -1 || splitAt > maxLength) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt > maxLength) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt === -1 || splitAt > maxLength) splitAt = maxLength;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) parts.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  return parts;
}

export async function deletePreviousBotMessages(ctx: any): Promise<void> {
  try {
    const messages: Array<{ message_id: number }> = ctx.session?.botMessageIds ?? [];
    for (const msg of messages.slice(0, -20)) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat?.id, msg.message_id);
      } catch {
      }
    }

    const keepMessages = messages.slice(-20);
    if (ctx.session) {
      ctx.session.botMessageIds = keepMessages;
    }
  } catch {
  }
}

export function coloredBtn(text: string, callback_data: string, style: 'primary' | 'success' | 'danger' = 'primary'): any {
  return { text, callback_data, style };
}

export function formatMessage(text: string): string {
  let html = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript\s*:/gi, '');
  html = html.replace(/^>\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  html = html.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

export function formatAIResponse(text: string): string {
  return formatMessage(text);
}

function mdToHtml(text: string): string {
  return formatMessage(text);
}

export function premium(emoji: string, title: string, body?: string): string {
  const header = `<b>${emoji} ${title}</b>`;
  if (!body) return header;
  return `${header}\n\n━━━━━━━━━━━━━━\n\n${mdToHtml(body)}\n\n━━━━━━━━━━━━━━`;
}

export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) return 'english';

  const devanagari = /[\u0900-\u097F]/;
  const arabicScript = /[\u0600-\u06FF\u0750-\u077F]/;
  const latinOnly = /^[a-zA-Z0-9\s.,!?;:'"\-_@#$%^&*()+=/\\[\]{}|~`<>]+$/;

  if (devanagari.test(text)) return 'hindi';
  if (arabicScript.test(text)) return 'urdu';

  if (latinOnly.test(text)) {
    const lower = text.toLowerCase();

    const hinglishWords = [
      'kya', 'hai', 'ho', 'hoon', 'hu', 'kar', 'karta', 'karte', 'karo', 'karti',
      'mera', 'meri', 'mere', 'tera', 'teri', 'tere', 'tum', 'aap', 'tumhara',
      'main', 'mein', 'nahi', 'nhi', 'haan', 'hmm', 'theek', 'thik', 'accha',
      'acha', 'achha', 'bhai', 'kaise', 'kahan', 'kyun', 'kyu', 'kyunke', 'sab',
      'bahut', 'thoda', 'thoda', 'sahi', 'galat', 'baat', 'kaam', 'samajh',
      'samajh', 'aata', 'aati', 'aate', 'sakte', 'sakta', 'sakti', 'chahiye',
      'chahiye', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'gaye', 'liye', 'wala',
      'wali', 'wale', 'log', 'saath', 'pehle', 'baad', 'aaj', 'kal', 'abhi',
      'phir', 'fir', 'uske', 'iske', 'inke', 'unke', 'jaega', 'jayega', 'aaega',
      'aayega', 'aata', 'bolo', 'batao', 'bata', 'dekho', 'dekh', 'sun', 'suno',
      'karo', 'karna', 'karke', 'ho', 'hain', 'tha', 'the', 'thi', 'thin',
      'raha', 'rahe', 'rahi', 'sakta', 'sakti', 'sakte', 'yahan', 'wahan',
      'idhar', 'udhar', 'kuch', 'kucch', 'kyon', 'namaste', 'namste', 'shukriya',
    ];

    const words = lower.split(/\s+/);
    let hinglishScore = 0;
    for (const word of words) {
      if (hinglishWords.includes(word)) {
        hinglishScore++;
      }
    }

    if (hinglishScore >= 2 || (hinglishScore >= 1 && words.length <= 3)) {
      return 'hinglish';
    }

    const frenchWords = ['bonjour', 'salut', 'merci', 'svp', 'stp', 'comment', 'pourquoi', 'bon', 'tres', 'oui', 'non', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'est', 'sont', 'dans', 'avec', 'sur', 'pour', 'pas', 'plus', 'trop', 'bien', 'mal', 'fait', 'faire', 'aller', 'venir', 'savoir', 'pouvoir', 'vouloir', 'devoir', 'croire', 'voir', 'dire', 'donner', 'temps', 'chose', 'homme', 'femme', 'monde', 'vie', 'jour', 'an', 'ans', 'tres', 'beaucoup', 'toujours', 'jamais', 'souvent', 'parfois', 'maintenant'];
    const frenchScore = words.filter(w => frenchWords.includes(w)).length;
    if (frenchScore >= 2) return 'french';

    const arabicWords = ['مرحبا', 'شكرا', 'كيف', 'ما', 'هل', 'لا', 'نعم', 'أنت', 'هو', 'هي', 'نحن', 'هم', 'في', 'من', 'إلى', 'على', 'عن', 'مع', 'كان', 'قال', 'هذا', 'ذلك', 'ماذا', 'لماذا', 'أين', 'متى', 'بكم', 'الحمد'];
    if (arabicWords.some(w => text.includes(w))) return 'arabic';
  }

  return 'english';
}

export function trackBotMessage(ctx: any, messageId: number): void {
  if (!ctx.session) return;
  if (!Array.isArray(ctx.session.botMessageIds)) {
    ctx.session.botMessageIds = [];
  }
  ctx.session.botMessageIds.push(messageId);
}

export async function checkImageDailyLimit(prisma: PrismaClient, userId: number): Promise<{ allowed: boolean; used: number; limit: number; remaining: number }> {
  const dbUser = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
  const limit = dbUser?.isPremium ? CONFIG.IMAGE.DAILY_LIMIT_PREMIUM : CONFIG.IMAGE.DAILY_LIMIT_FREE;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const used = await prisma.analytics.count({
    where: {
      userId: BigInt(userId),
      event: 'image_generate',
      createdAt: { gte: todayStart },
    },
  });

  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

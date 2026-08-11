import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { CONFIG } from '../config';
import { CHAT_PROMPT } from '../prompts/chat.prompt';
import { CODE_PROMPT } from '../prompts/code.prompt';
import { TRANSLATE_PROMPT } from '../prompts/translate.prompt';
import { IMAGE_ANALYSIS_PROMPT } from '../prompts/image.prompt';
import { FILE_SUMMARY_PROMPT } from '../prompts/summary.prompt';
import { ChatMessage, AIResponse, ValidationResult, ErrorCategory } from '../types';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { withTimeout, formatDuration, sleep } from '../utils/helpers';

const clients: Map<string, GoogleGenerativeAI> = new Map();
let currentModelName: string = CONFIG.AI.DEFAULT_MODEL;
let currentApiKeyIndex: 1 | 2 = 1;
let validationResult: ValidationResult | null = null;

const MODEL_FALLBACK_CHAIN = [
  CONFIG.AI.MODELS.FLASH,
  CONFIG.AI.MODELS.FLASH_LITE,
  CONFIG.AI.MODELS.PRO,
];

const MAX_RETRY_COUNT = 3;
const BACKOFF_DELAYS = [1000, 2000, 4000];

const PROMPT_MAP: Record<string, string> = {
  chat: CHAT_PROMPT,
  code: CODE_PROMPT,
  translate: TRANSLATE_PROMPT,
  image_analysis: IMAGE_ANALYSIS_PROMPT,
  file_summary: FILE_SUMMARY_PROMPT,
};

function getApiKey(index: 1 | 2): string | null {
  if (index === 1) return env.GOOGLE_API_KEY_1;
  if (index === 2) return env.GOOGLE_API_KEY_2 || null;
  return null;
}

function getClient(apiKey: string): GoogleGenerativeAI {
  const existing = clients.get(apiKey);
  if (existing) return existing;
  const client = new GoogleGenerativeAI(apiKey);
  clients.set(apiKey, client);
  return client;
}

export function categorizeError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes('401') || message.includes('unauthorized') || message.includes('permission')) return 'auth';
  if (message.includes('403') || message.includes('forbidden')) return 'auth';
  if (message.includes('404') || message.includes('not found') || message.includes('model not found')) return 'invalid_request';
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
  if (message.includes('quota') || message.includes('resource exhausted') || message.includes('insufficient')) return 'quota';
  if (message.includes('503') || message.includes('service unavailable') || message.includes('unavailable') || message.includes('overloaded')) return 'service_unavailable';
  if (message.includes('timeout') || message.includes('timed out') || message.includes('deadline')) return 'timeout';
  return 'unknown';
}

function shouldFallbackModel(category: ErrorCategory): boolean {
  return ['rate_limit', 'quota', 'service_unavailable', 'timeout'].includes(category);
}

export function getUserFacingError(category: ErrorCategory): string {
  switch (category) {
    case 'auth':
      return '⚠️ *AI service is temporarily unavailable.*\n\nThe administrator has been notified. Please try again later.';
    case 'rate_limit':
      return '⏳ *Too many requests.*\n\nPlease wait a moment and try again.';
    case 'quota':
      return '⚠️ *API quota exceeded.*\n\nThe administrator has been notified. Please try again later.';
    case 'service_unavailable':
      return '🔧 *AI service is temporarily unavailable.*\n\nPlease try again in a few moments.';
    case 'timeout':
      return '⏱️ *Request took too long.*\n\nPlease try again with a simpler query.';
    case 'invalid_request':
      return '⚠️ *Invalid request.*\n\nPlease check your query and try again.';
    default:
      return '❌ *An unexpected error occurred.*\n\nPlease try again later.';
  }
}

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  hinglish: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **Hinglish** (Roman Hindi)\n- Reply in Hinglish — mix Hindi words with English\n- Use Roman script only, NOT Devanagari\n- Examples: "tum kon ho" → Hinglish reply, "kya kar sakte ho" → Hinglish reply\n- Keep it natural and conversational`,
  hindi: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **Hindi** (Devanagari script)\n- Reply in **Hindi** only\n- Use Devanagari script`,
  english: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **English**\n- Reply in **English** only\n- Do NOT mix in Hindi or Hinglish`,
  arabic: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **Arabic**\n- Reply in **Arabic** only`,
  french: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **French**\n- Reply in **French** only`,
  urdu: `\n\n## Language Instruction (IMPORTANT)\n- The user is writing in **Urdu**\n- Reply in **Urdu** only`,
};

async function loadPromptIdentity(): Promise<{ name: string; creator: string }> {
  try {
    const [nameSetting, creatorSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'bot_name' } }),
      prisma.setting.findUnique({ where: { key: 'creator_username' } }),
    ]);
    return {
      name: nameSetting?.value ?? 'TeleForge AI',
      creator: creatorSetting?.value ?? '@TeleforgeOfficial',
    };
  } catch {
    return { name: 'TeleForge AI', creator: '@TeleforgeOfficial' };
  }
}

export async function getPromptForMode(mode: string, language?: string): Promise<string> {
  const base = PROMPT_MAP[mode] ?? CHAT_PROMPT;
  const identity = await loadPromptIdentity();
  const withIdentity = base.replace(/\{CREATOR\}/g, identity.creator).replace(/\{BOT_NAME\}/g, identity.name);
  const lang = language ?? 'english';
  const instruction = LANGUAGE_INSTRUCTION[lang] ?? LANGUAGE_INSTRUCTION.english;
  return withIdentity + instruction;
}

async function tryGenerate(
  keyIndex: 1 | 2,
  modelName: string,
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<{ result: AIResponse; model: string; key: string } | { error: ErrorCategory; model: string; key: string }> {
  const apiKey = getApiKey(keyIndex);
  if (!apiKey) {
    return { error: 'auth', model: modelName, key: `key${keyIndex}` };
  }

  try {
    const client = getClient(apiKey);
    const model = client.getGenerativeModel({ model: modelName });
    const startTime = Date.now();

    const historyParts = messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : msg.role as 'user' | 'model',
      parts: msg.content.startsWith('[Image:')
        ? [{ text: msg.content }]
        : [{ text: msg.content }],
    }));

    const lastMessage = messages[messages.length - 1];
    const lastContent = lastMessage?.content ?? '';

    const chat = model.startChat({
      systemInstruction: {
        role: 'user',
        parts: [{ text: systemPrompt }],
      },
      generationConfig: {
        maxOutputTokens: CONFIG.AI.MAX_TOKENS,
        temperature: CONFIG.AI.TEMPERATURE,
        topP: CONFIG.AI.TOP_P,
        topK: CONFIG.AI.TOP_K,
      },
      history: historyParts,
    });

    const imageMatch = lastContent.startsWith('[Image:')
      ? lastContent.match(/\[Image: ([^\]]+)\]\nCaption: (.+)/s)
      : null;

    const result = await withTimeout(
      imageMatch && imageMatch[1]
        ? chat.sendMessageStream([
            { inlineData: { mimeType: 'image/jpeg', data: imageMatch[1] } },
            { text: imageMatch[2] ?? '' },
          ])
        : chat.sendMessageStream(lastContent),
      CONFIG.AI.TIMEOUT_MS,
      'AI generation timed out',
    );

    let text = '';
    for await (const chunk of result.stream) {
      text += chunk.text();
    }

    const response = await result.response;
    const duration = Date.now() - startTime;
    trackResponseTime(duration);

    logger.info(
      { model: modelName, keyIndex, duration: formatDuration(duration), finishReason: response.candidates?.[0]?.finishReason },
      'AI generation succeeded',
    );

    return {
      result: { text, finishReason: response.candidates?.[0]?.finishReason?.toString(), model: modelName },
      model: modelName,
      key: `key${keyIndex}`,
    };
  } catch (error) {
    const category = categorizeError(error);
    logger.warn({ error, category, model: modelName, keyIndex }, 'AI generation attempt failed');

    await prisma.log.create({
      data: {
        level: 'warn',
        message: `AI failure on ${modelName} key${keyIndex}: ${category}`,
        metadata: { error: String(error), category, model: modelName, keyIndex } as never,
      },
    });

    return { error: category, model: modelName, key: `key${keyIndex}` };
  }
}

export async function generateResponse(
  messages: ChatMessage[],
  mode: string = 'chat',
  language?: string,
): Promise<AIResponse> {
  const systemPrompt = await getPromptForMode(mode, language);
  const startTime = Date.now();

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  logger.info({
    mode,
    language: language ?? 'auto',
    historyCount: messages.length,
    promptSize: systemPrompt.length,
    lastUserMsg: lastUserMsg?.content?.slice(0, 100) ?? '(none)',
  }, 'generateResponse started');

  const startModelIndex = MODEL_FALLBACK_CHAIN.indexOf(currentModelName as typeof MODEL_FALLBACK_CHAIN[number]);
  const modelChain = startModelIndex >= 0
    ? [...MODEL_FALLBACK_CHAIN.slice(startModelIndex), ...MODEL_FALLBACK_CHAIN.slice(0, startModelIndex)]
    : MODEL_FALLBACK_CHAIN;

  const uniqueModels = [...new Set(modelChain)];
  let retryCount = 0;

  for (const modelName of uniqueModels) {
    if (retryCount >= MAX_RETRY_COUNT) {
      trackError('Max retry count exceeded');
      throw new Error('⏱️ *Service busy.*\n\nPlease try again in a few moments.');
    }

    const attempt = await tryGenerate(currentApiKeyIndex, modelName, messages, systemPrompt);

    if ('result' in attempt) {
      currentModelName = modelName;
      logger.info({
        model: modelName,
        keyIndex: currentApiKeyIndex,
        duration: formatDuration(Date.now() - startTime),
        responseLength: attempt.result.text.length,
      }, 'generateResponse completed');
      return attempt.result;
    }

    if (attempt.error === 'auth') {
      const nextKey: 1 | 2 = currentApiKeyIndex === 1 ? 2 : 1;
      const nextApiKey = getApiKey(nextKey);
      if (nextApiKey) {
        logger.info({ fromKey: currentApiKeyIndex, toKey: nextKey }, 'Failing over to next API key');
        currentApiKeyIndex = nextKey;
        retryCount++;

        if (retryCount < MAX_RETRY_COUNT) {
          const delay = BACKOFF_DELAYS[Math.min(retryCount - 1, BACKOFF_DELAYS.length - 1)] ?? 4000;
          await sleep(delay);
        }

        const retryAttempt = await tryGenerate(nextKey, modelName, messages, systemPrompt);
        if ('result' in retryAttempt) {
          currentModelName = modelName;
          logger.info({ key: nextKey, model: modelName }, 'Failover succeeded');
          await prisma.log.create({
            data: { level: 'info', message: `API key failover to key${currentApiKeyIndex}`, metadata: { model: modelName } as never },
          });
          return retryAttempt.result;
        }
      }
    }

    if (!shouldFallbackModel(attempt.error)) {
      trackError(getUserFacingError(attempt.error));
      throw new Error(getUserFacingError(attempt.error));
    }

    const currentModelIdx = MODEL_FALLBACK_CHAIN.indexOf(modelName as typeof MODEL_FALLBACK_CHAIN[number]);
    if (currentModelIdx < MODEL_FALLBACK_CHAIN.length - 1) {
      const nextModel = MODEL_FALLBACK_CHAIN[currentModelIdx + 1];
      if (nextModel) {
        retryCount++;
        if (retryCount >= MAX_RETRY_COUNT) {
          trackError('Max retry count exceeded during fallback');
          throw new Error('⏱️ *Service busy.*\n\nPlease try again in a few moments.');
        }

        const delay = BACKOFF_DELAYS[Math.min(retryCount - 1, BACKOFF_DELAYS.length - 1)] ?? 4000;
        await sleep(delay);

        logger.info({ from: modelName, to: nextModel, delay }, 'Falling back to next model with backoff');
        await prisma.log.create({
          data: { level: 'info', message: `Model fallback: ${modelName} → ${nextModel}`, metadata: { error: attempt.error, delay } as never },
        });
        continue;
      }
    }

    trackError(getUserFacingError(attempt.error));
    throw new Error(getUserFacingError(attempt.error));
  }

  trackError('All models failed');
  throw new Error(`All models failed after ${formatDuration(Date.now() - startTime)}`);
}

export async function validateAI(): Promise<ValidationResult> {
  const result: ValidationResult = {
    key1Valid: false,
    key2Valid: null,
    currentModel: currentModelName,
    validatedModels: [],
  };

  try {
    const client1 = new GoogleGenerativeAI(env.GOOGLE_API_KEY_1);
    const model1 = client1.getGenerativeModel({ model: CONFIG.AI.MODELS.FLASH });
    await model1.generateContent('test');
    result.key1Valid = true;
    result.validatedModels.push(CONFIG.AI.MODELS.FLASH);
    logger.info('API Key 1 validated successfully');
  } catch (error) {
    logger.error({ error }, 'API Key 1 validation failed');
  }

  if (env.GOOGLE_API_KEY_2) {
    try {
      const client2 = new GoogleGenerativeAI(env.GOOGLE_API_KEY_2);
      const model2 = client2.getGenerativeModel({ model: CONFIG.AI.MODELS.FLASH });
      await model2.generateContent('test');
      result.key2Valid = true;
      logger.info('API Key 2 validated successfully');
    } catch (error) {
      result.key2Valid = false;
      logger.error({ error }, 'API Key 2 validation failed');
    }
  }

  for (const modelName of MODEL_FALLBACK_CHAIN) {
    try {
      const client = new GoogleGenerativeAI(env.GOOGLE_API_KEY_1);
      const model = client.getGenerativeModel({ model: modelName });
      await model.generateContent('test');
      result.validatedModels.push(modelName);
      logger.info({ model: modelName }, 'Model validated');
    } catch {
      logger.warn({ model: modelName }, 'Model validation skipped');
    }
  }

  validationResult = result;

  if (result.key1Valid) {
    currentApiKeyIndex = 1;
  } else if (result.key2Valid) {
    currentApiKeyIndex = 2;
  }

  return result;
}

const responseTimes: number[] = [];
let lastErrorTimestamp: number | null = null;
let lastErrorMessage: string | null = null;

export function trackResponseTime(ms: number): void {
  responseTimes.push(ms);
  if (responseTimes.length > 100) responseTimes.shift();
}

export function getAverageResponseTime(): string {
  if (responseTimes.length === 0) return 'N/A';
  const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  return `${avg.toFixed(0)}ms`;
}

export function trackError(error: string): void {
  lastErrorTimestamp = Date.now();
  lastErrorMessage = error;
}

export function getLastError(): { time: string; message: string } | null {
  if (!lastErrorTimestamp || !lastErrorMessage) return null;
  const seconds = Math.floor((Date.now() - lastErrorTimestamp) / 1000);
  return { time: `${seconds}s ago`, message: lastErrorMessage };
}

export async function testConnection(): Promise<{ success: boolean; latency: string; error?: string }> {
  const apiKey = getApiKey(currentApiKeyIndex);
  if (!apiKey) return { success: false, latency: '0ms', error: 'No API key available' };

  const start = Date.now();
  try {
    const client = getClient(apiKey);
    const model = client.getGenerativeModel({ model: currentModelName });
    const result = await withTimeout(
      model.generateContent('Reply with just: ok'),
      10000,
      'Connection test timed out',
    );
    const latency = Date.now() - start;
    await result.response;
    return { success: true, latency: `${latency}ms` };
  } catch (error) {
    const latency = Date.now() - start;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, latency: `${latency}ms`, error: msg };
  }
}

export function getValidationResult(): ValidationResult | null {
  return validationResult;
}

export function getCurrentModelName(): string {
  return currentModelName;
}

export function getCurrentApiKeyIndex(): number {
  return currentApiKeyIndex;
}

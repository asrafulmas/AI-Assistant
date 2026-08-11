{`import { GoogleGenerativeAI } from '@google/generative-ai';
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

type Provider = 'gemini1' | 'gemini2' | 'bazaarlink';

const clients = new Map<string, GoogleGenerativeAI>();

let currentModelName: string = CONFIG.AI.DEFAULT_MODEL;
let currentProvider: Provider = 'gemini1';
let validationResult: ValidationResult | null = null;

const MODEL_FALLBACK_CHAIN = [
  CONFIG.AI.MODELS.FLASH,
  CONFIG.AI.MODELS.FLASH_LITE,
  CONFIG.AI.MODELS.PRO,
];

const PROVIDER_CHAIN: Provider[] = [
  'gemini1',
  'gemini2',
  'bazaarlink',
];

const MAX_RETRY_COUNT = 3;
const BACKOFF_DELAYS = [1000, 2000, 4000];

const BAZAARLINK_BASE_URL = 'https://bazaarlink.ai/api/v1';
const BAZAARLINK_MODEL = process.env.BAZAARLINK_MODEL || 'auto:free';

const PROMPT_MAP: Record<string, string> = {
  chat: CHAT_PROMPT,
  code: CODE_PROMPT,
  translate: TRANSLATE_PROMPT,
  image_analysis: IMAGE_ANALYSIS_PROMPT,
  file_summary: FILE_SUMMARY_PROMPT,
};

function getGeminiApiKey(provider: Provider): string | null {
  if (provider === 'gemini1') return env.GOOGLE_API_KEY_1 || null;
  if (provider === 'gemini2') return env.GOOGLE_API_KEY_2 || null;
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
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  if (
    message.includes('401') ||
    message.includes('unauthorized') ||
    message.includes('permission')
  ) {
    return 'auth';
  }

  if (message.includes('403') || message.includes('forbidden')) {
    return 'auth';
  }

  if (
    message.includes('404') ||
    message.includes('not found') ||
    message.includes('model not found')
  ) {
    return 'invalid_request';
  }

  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return 'rate_limit';
  }

  if (
    message.includes('quota') ||
    message.includes('resource exhausted') ||
    message.includes('insufficient')
  ) {
    return 'quota';
  }

  if (
    message.includes('503') ||
    message.includes('service unavailable') ||
    message.includes('unavailable') ||
    message.includes('overloaded')
  ) {
    return 'service_unavailable';
  }

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('deadline')
  ) {
    return 'timeout';
  }

  return 'unknown';
}

function shouldFallbackProvider(category: ErrorCategory): boolean {
  return [
    'auth',
    'rate_limit',
    'quota',
    'service_unavailable',
    'timeout',
  ].includes(category);
}

export function getUserFacingError(category: ErrorCategory): string {
  switch (category) {
    case 'auth':
      return '⚠️ *AI service is temporarily unavailable.*\\n\\nPlease try again later.';
    case 'rate_limit':
      return '⏳ *Too many requests.*\\n\\nPlease wait a moment and try again.';
    case 'quota':
      return '⚠️ *API quota exceeded.*\\n\\nPlease try again later.';
    case 'service_unavailable':
      return '🔧 *AI service is temporarily unavailable.*\\n\\nPlease try again in a few moments.';
    case 'timeout':
      return '⏱️ *Request took too long.*\\n\\nPlease try again.';
    case 'invalid_request':
      return '⚠️ *Invalid request.*\\n\\nPlease check your query.';
    default:
      return '❌ *An unexpected error occurred.*\\n\\nPlease try again later.';
  }
}

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  hinglish: '\\n\\nReply in Hinglish using Roman script only.',
  hindi: '\\n\\nReply in Hindi only.',
  english: '\\n\\nReply in English only.',
  arabic: '\\n\\nReply in Arabic only.',
  french: '\\n\\nReply in French only.',
  urdu: '\\n\\nReply in Urdu only.',
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
    return {
      name: 'TeleForge AI',
      creator: '@TeleforgeOfficial',
    };
  }
}

export async function getPromptForMode(
  mode: string,
  language?: string,
): Promise<string> {
  const base = PROMPT_MAP[mode] ?? CHAT_PROMPT;
  const identity = await loadPromptIdentity();

  const withIdentity = base
    .replace(/\\{CREATOR\\}/g, identity.creator)
    .replace(/\\{BOT_NAME\\}/g, identity.name);

  return (
    withIdentity +
    (LANGUAGE_INSTRUCTION[language ?? 'english'] ??
      LANGUAGE_INSTRUCTION.english)
  );
}

async function tryGemini(
  provider: 'gemini1' | 'gemini2',
  modelName: string,
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey = getGeminiApiKey(provider);

  if (!apiKey) {
    return { error: 'auth' };
  }

  try {
    const client = getClient(apiKey);
    const model = client.getGenerativeModel({ model: modelName });

    const history = messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
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
      history,
    });

    const result = await withTimeout(
      chat.sendMessageStream(lastContent),
      CONFIG.AI.TIMEOUT_MS,
      'Gemini timed out',
    );

    let text = '';

    for await (const chunk of result.stream) {
      text += chunk.text();
    }

    return {
      result: {
        text,
        model: modelName,
      },
    };
  } catch (error) {
    return {
      error: categorizeError(error),
    };
  }
}

async function tryBazaarLink(
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey = env.BAZARLINK_API_KEY;

  if (!apiKey) {
    return { error: 'auth' };
  }

  try {
    const body = {
      model: BAZAARLINK_MODEL,
      stream: false,
      temperature: CONFIG.AI.TEMPERATURE,
      max_tokens: CONFIG.AI.MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...messages.map((msg) => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        })),
      ],
    };

    const response = await withTimeout(
      fetch(\`\${BAZAARLINK_BASE_URL}/chat/completions\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: \`Bearer \${apiKey}\`,
        },
        body: JSON.stringify(body),
      }),
      CONFIG.AI.TIMEOUT_MS,
      'BazaarLink timed out',
    );

    if (!response.ok) {
      throw new Error(
        \`BazaarLink HTTP \${response.status}: \${await response.text()}\`,
      );
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const text =
      data.choices?.[0]?.message?.content ?? '';

    return {
      result: {
        text,
        model: BAZAARLINK_MODEL,
      },
    };
  } catch (error) {
    return {
      error: categorizeError(error),
    };
  }
}

export async function generateResponse(
  messages: ChatMessage[],
  mode = 'chat',
  language?: string,
): Promise<AIResponse> {
  const systemPrompt = await getPromptForMode(mode, language);

  for (const provider of PROVIDER_CHAIN) {
    logger.info({ provider }, 'Trying AI provider');

    if (provider === 'bazaarlink') {
      const attempt = await tryBazaarLink(messages, systemPrompt);

      if ('result' in attempt) {
        currentProvider = provider;
        return attempt.result;
      }

      if (!shouldFallbackProvider(attempt.error)) {
        throw new Error(getUserFacingError(attempt.error));
      }

      continue;
    }

    for (const modelName of MODEL_FALLBACK_CHAIN) {
      const attempt = await tryGemini(
        provider,
        modelName,
        messages,
        systemPrompt,
      );

      if ('result' in attempt) {
        currentProvider = provider;
        currentModelName = modelName;

        return attempt.result;
      }

      if (!shouldFallbackProvider(attempt.error)) {
        throw new Error(getUserFacingError(attempt.error));
      }

      await sleep(
        BACKOFF_DELAYS[
          Math.min(
            MODEL_FALLBACK_CHAIN.indexOf(modelName),
            BACKOFF_DELAYS.length - 1,
          )
        ] ?? 4000,
      );
    }
  }

  throw new Error(
    '⚠️ *All AI providers are temporarily unavailable.*\\n\\nPlease try again later.',
  );
}

export async function validateAI(): Promise<ValidationResult> {
  const result: ValidationResult = {
    key1Valid: false,
    key2Valid: null,
    currentModel: currentModelName,
    validatedModels: [],
  };

  try {
    const client = new GoogleGenerativeAI(env.GOOGLE_API_KEY_1);
    await client
      .getGenerativeModel({
        model: CONFIG.AI.MODELS.FLASH,
      })
      .generateContent('test');

    result.key1Valid = true;
  } catch {}

  if (env.GOOGLE_API_KEY_2) {
    try {
      const client = new GoogleGenerativeAI(env.GOOGLE_API_KEY_2);
      await client
        .getGenerativeModel({
          model: CONFIG.AI.MODELS.FLASH,
        })
        .generateContent('test');

      result.key2Valid = true;
    } catch {
      result.key2Valid = false;
    }
  }

  validationResult = result;

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
  const avg =
    responseTimes.reduce((a, b) => a + b, 0) /
    responseTimes.length;
  return \`\${avg.toFixed(0)}ms\`;
}

export function trackError(error: string): void {
  lastErrorTimestamp = Date.now();
  lastErrorMessage = error;
}

export function getLastError(): { time: string; message: string } | null {
  if (!lastErrorTimestamp || !lastErrorMessage) return null;
  const seconds = Math.floor((Date.now() - lastErrorTimestamp) / 1000);
  return { time: \`\${seconds}s ago\`, message: lastErrorMessage };
}

export async function testConnection(): Promise<{ success: boolean; latency: string; error?: string }> {
  const start = Date.now();

  try {
    const response = await generateResponse(
      [{ role: 'user', content: 'Reply with just: ok' }],
      'chat',
      'english',
    );

    return {
      success: true,
      latency: \`\${Date.now() - start}ms\`,
    };
  } catch (error) {
    return {
      success: false,
      latency: \`\${Date.now() - start}ms\`,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error',
    };
  }
}

export function getValidationResult(): ValidationResult | null {
  return validationResult;
}

export function getCurrentModelName(): string {
  return currentModelName;
}

export function getCurrentApiKeyIndex(): number {
  if (currentProvider === 'gemini1') return 1;
  if (currentProvider === 'gemini2') return 2;
  return 3;
}`} 

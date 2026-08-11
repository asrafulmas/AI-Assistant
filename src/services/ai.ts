import { GoogleGenerativeAI } from '@google/generative-ai';

import { env } from '../config/env';
import { CONFIG } from '../config';

import { CHAT_PROMPT } from '../prompts/chat.prompt';
import { CODE_PROMPT } from '../prompts/code.prompt';
import { TRANSLATE_PROMPT } from '../prompts/translate.prompt';
import { IMAGE_ANALYSIS_PROMPT } from '../prompts/image.prompt';
import { FILE_SUMMARY_PROMPT } from '../prompts/summary.prompt';

import {
  ChatMessage,
  AIResponse,
  ValidationResult,
  ErrorCategory,
} from '../types';

import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { withTimeout, sleep } from '../utils/helpers';

type Provider = 'bazaarlink' | 'gemini1' | 'gemini2';

const clients = new Map<string, GoogleGenerativeAI>();

let currentModelName = 'google/gemini-2.5-flash';
let currentProvider: Provider = 'bazaarlink';
let validationResult: ValidationResult | null = null;

const BAZAARLINK_BASE_URL = 'https://bazaarlink.ai/api/v1';

/*
 * BazaarLink model.
 *
 * Full provider/model format is required for reliable routing.
 *
 * You can override this on Render with:
 *
 * BAZARLINK_MODEL=google/gemini-2.5-flash
 *
 * If BAZARLINK_MODEL is not set, this model is used.
 */
const BAZAARLINK_MODEL =
  process.env.BAZARLINK_MODEL?.trim() || 'google/gemini-2.5-flash';

/*
 * Optional BazaarLink model fallbacks.
 *
 * BazaarLink itself supports a "models" array and will try the
 * models in order when the primary model fails.
 *
 * Keep the primary model first.
 */
const BAZAARLINK_FALLBACK_MODELS = [
  BAZAARLINK_MODEL,
  'google/gemini-2.5-flash-lite',
].filter(
  (model, index, array) => model && array.indexOf(model) === index,
);

const MODEL_FALLBACK_CHAIN = [
  CONFIG.AI.MODELS.FLASH,
  CONFIG.AI.MODELS.FLASH_LITE,
  CONFIG.AI.MODELS.PRO,
];

const MAX_RETRY_COUNT = CONFIG.MAX_RETRY_COUNT ?? 3;

const BACKOFF_DELAYS =
  CONFIG.BACKOFF_DELAYS?.length > 0
    ? CONFIG.BACKOFF_DELAYS
    : [1000, 2000, 4000];

const PROMPT_MAP: Record<string, string> = {
  chat: CHAT_PROMPT,
  code: CODE_PROMPT,
  translate: TRANSLATE_PROMPT,
  image_analysis: IMAGE_ANALYSIS_PROMPT,
  file_summary: FILE_SUMMARY_PROMPT,
};

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  hinglish: '\n\nReply in Hinglish using Roman script only.',
  hindi: '\n\nReply in Hindi only.',
  english: '\n\nReply in English only.',
  arabic: '\n\nReply in Arabic only.',
  french: '\n\nReply in French only.',
  urdu: '\n\nReply in Urdu only.',
};

function getGeminiApiKey(
  provider: 'gemini1' | 'gemini2',
): string | null {
  if (provider === 'gemini1') {
    return env.GOOGLE_API_KEY_1 || null;
  }

  return env.GOOGLE_API_KEY_2 || null;
}

function getClient(apiKey: string): GoogleGenerativeAI {
  const existing = clients.get(apiKey);

  if (existing) {
    return existing;
  }

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
    message.includes('invalid api key') ||
    message.includes('invalid_api_key')
  ) {
    return 'auth';
  }

  if (
    message.includes('403') ||
    message.includes('forbidden') ||
    message.includes('permission denied')
  ) {
    return 'auth';
  }

  if (
    message.includes('404') ||
    message.includes('not found') ||
    message.includes('model not found') ||
    message.includes('model_not_available') ||
    message.includes('model_retired')
  ) {
    return 'invalid_request';
  }

  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many requests')
  ) {
    return 'rate_limit';
  }

  if (
    message.includes('quota') ||
    message.includes('resource exhausted') ||
    message.includes('insufficient') ||
    message.includes('credits')
  ) {
    return 'quota';
  }

  if (
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable') ||
    message.includes('overloaded') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout')
  ) {
    return 'service_unavailable';
  }

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('deadline exceeded') ||
    message.includes('aborted')
  ) {
    return 'timeout';
  }

  return 'unknown';
}

function shouldFallbackProvider(
  category: ErrorCategory,
): boolean {
  return [
    'auth',
    'rate_limit',
    'quota',
    'service_unavailable',
    'timeout',
    'invalid_request',
    'unknown',
  ].includes(category);
}

export function getUserFacingError(
  category: ErrorCategory,
): string {
  switch (category) {
    case 'auth':
      return (
        '⚠️ *AI service authentication failed.*\n\n' +
        'Please try again later.'
      );

    case 'rate_limit':
      return (
        '⏳ *Too many requests.*\n\n' +
        'Please wait a moment and try again.'
      );

    case 'quota':
      return (
        '⚠️ *AI service quota is temporarily unavailable.*\n\n' +
        'Please try again later.'
      );

    case 'service_unavailable':
      return (
        '🔧 *AI service is temporarily unavailable.*\n\n' +
        'Please try again in a few moments.'
      );

    case 'timeout':
      return (
        '⏱️ *AI request took too long.*\n\n' +
        'Please try again.'
      );

    case 'invalid_request':
      return (
        '⚠️ *The requested AI model is unavailable.*\n\n' +
        'Please try again later.'
      );

    default:
      return (
        '❌ *An unexpected AI error occurred.*\n\n' +
        'Please try again later.'
      );
  }
}

async function loadPromptIdentity(): Promise<{
  name: string;
  creator: string;
}> {
  try {
    const [nameSetting, creatorSetting] =
      await Promise.all([
        prisma.setting.findUnique({
          where: { key: 'bot_name' },
        }),
        prisma.setting.findUnique({
          where: { key: 'creator_username' },
        }),
      ]);

    return {
      name: nameSetting?.value ?? 'TeleForge AI',
      creator:
        creatorSetting?.value ?? '@TeleforgeOfficial',
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
    .replace(/\{CREATOR\}/g, identity.creator)
    .replace(/\{BOT_NAME\}/g, identity.name);

  return (
    withIdentity +
    (
      LANGUAGE_INSTRUCTION[
        language ?? 'english'
      ] ?? LANGUAGE_INSTRUCTION.english
    )
  );
}

/* -------------------------------------------------------------------------- */
/* BazaarLink                                                                 */
/* -------------------------------------------------------------------------- */

async function tryBazaarLink(
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey = env.BAZARLINK_API_KEY?.trim();

  if (!apiKey) {
    logger.warn(
      'BAZARLINK_API_KEY is not configured',
    );

    return { error: 'auth' };
  }

  try {
    logger.info(
      {
        provider: 'bazaarlink',
        model: BAZAARLINK_MODEL,
      },
      'Trying BazaarLink primary provider',
    );

    const body = {
      model: BAZAARLINK_MODEL,

      /*
       * BazaarLink can perform model-level fallback itself.
       * This prevents unnecessary round trips from this service.
       */
      models:
        BAZAARLINK_FALLBACK_MODELS.length > 1
          ? BAZAARLINK_FALLBACK_MODELS
          : undefined,

      stream: false,

      temperature: CONFIG.AI.TEMPERATURE,
      top_p: CONFIG.AI.TOP_P,
      max_tokens: CONFIG.AI.MAX_TOKENS,

      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },

        ...messages.map((message) => ({
          role:
            message.role === 'assistant'
              ? 'assistant'
              : message.role === 'system'
                ? 'system'
                : 'user',
          content: message.content,
        })),
      ],
    };

    const response = await withTimeout(
      fetch(
        `${BAZAARLINK_BASE_URL}/chat/completions`,
        {
          method: 'POST',

          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },

          body: JSON.stringify(body),
        },
      ),
      CONFIG.AI.TIMEOUT_MS,
      'BazaarLink timed out',
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `BazaarLink HTTP ${response.status}: ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      id?: string;

      model?: string;

      choices?: Array<{
        index?: number;

        message?: {
          role?: string;
          content?: string | null;
        };

        finish_reason?: string | null;
      }>;

      error?: {
        message?: string;
        code?: string;
        type?: string;
      };
    };

    if (data.error) {
      throw new Error(
        `BazaarLink API error: ${
          data.error.message ??
          data.error.code ??
          data.error.type ??
          'Unknown error'
        }`,
      );
    }

    const text =
      data.choices?.[0]?.message?.content ?? '';

    if (!text.trim()) {
      throw new Error(
        'BazaarLink returned an empty response',
      );
    }

    const resolvedModel =
      data.model || BAZAARLINK_MODEL;

    logger.info(
      {
        provider: 'bazaarlink',
        model: resolvedModel,
      },
      'BazaarLink response successful',
    );

    return {
      result: {
        text,
        model: resolvedModel,
      },
    };
  } catch (error) {
    const category = categorizeError(error);

    logger.warn(
      {
        provider: 'bazaarlink',
        category,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      'BazaarLink request failed',
    );

    return {
      error: category,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Google Gemini                                                              */
/* -------------------------------------------------------------------------- */

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
    logger.info(
      {
        provider,
        model: modelName,
      },
      'Trying Google Gemini fallback',
    );

    const client = getClient(apiKey);

    /*
     * Google SDK expects the model name without the
     * "models/" prefix in normal getGenerativeModel usage.
     *
     * Keep compatibility with the existing CONFIG values.
     */
    const normalizedModel = modelName.startsWith(
      'models/',
    )
      ? modelName.substring(7)
      : modelName;

    const model = client.getGenerativeModel({
      model: normalizedModel,
    });

    const history = messages
      .slice(0, -1)
      .filter(
        (message) =>
          message.role !== 'system',
      )
      .map((message) => ({
        role:
          message.role === 'assistant'
            ? 'model'
            : 'user',

        parts: [
          {
            text: message.content,
          },
        ],
      }));

    const lastMessage =
      messages[messages.length - 1];

    const lastContent =
      lastMessage?.content ?? '';

    const chat = model.startChat({
      systemInstruction: {
        role: 'user',
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },

      generationConfig: {
        maxOutputTokens:
          CONFIG.AI.MAX_TOKENS,

        temperature:
          CONFIG.AI.TEMPERATURE,

        topP:
          CONFIG.AI.TOP_P,

        topK:
          CONFIG.AI.TOP_K,
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

    if (!text.trim()) {
      throw new Error(
        'Google Gemini returned an empty response',
      );
    }

    logger.info(
      {
        provider,
        model: normalizedModel,
      },
      'Google Gemini fallback successful',
    );

    return {
      result: {
        text,
        model: normalizedModel,
      },
    };
  } catch (error) {
    const category = categorizeError(error);

    logger.warn(
      {
        provider,
        model: modelName,
        category,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      'Google Gemini request failed',
    );

    return {
      error: category,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Main generation                                                           */
/* -------------------------------------------------------------------------- */

export async function generateResponse(
  messages: ChatMessage[],
  mode = 'chat',
  language?: string,
): Promise<AIResponse> {
  const systemPrompt =
    await getPromptForMode(
      mode,
      language,
    );

  /*
   * PRIMARY:
   *   BazaarLink
   *
   * FALLBACK:
   *   Google API Key 1
   *   Google API Key 2
   */

  /* ========================= */
  /* 1. BAZAARLINK PRIMARY     */
  /* ========================= */

  for (
    let attemptNumber = 0;
    attemptNumber < MAX_RETRY_COUNT;
    attemptNumber++
  ) {
    const attempt =
      await tryBazaarLink(
        messages,
        systemPrompt,
      );

    if ('result' in attempt) {
      currentProvider = 'bazaarlink';
      currentModelName =
        attempt.result.model ??
        BAZAARLINK_MODEL;

      return attempt.result;
    }

    if (
      !shouldFallbackProvider(
        attempt.error,
      )
    ) {
      break;
    }

    if (
      attemptNumber <
      MAX_RETRY_COUNT - 1
    ) {
      const delay =
        BACKOFF_DELAYS[
          Math.min(
            attemptNumber,
            BACKOFF_DELAYS.length - 1,
          )
        ] ?? 4000;

      logger.warn(
        {
          provider: 'bazaarlink',
          attempt:
            attemptNumber + 1,
          delay,
          error: attempt.error,
        },
        'Retrying BazaarLink',
      );

      await sleep(delay);
    }
  }

  /* ========================= */
  /* 2. GOOGLE KEY 1           */
  /* ========================= */

  if (env.GOOGLE_API_KEY_1) {
    for (const modelName of MODEL_FALLBACK_CHAIN) {
      const attempt =
        await tryGemini(
          'gemini1',
          modelName,
          messages,
          systemPrompt,
        );

      if ('result' in attempt) {
        currentProvider =
          'gemini1';

        currentModelName =
          attempt.result.model ??
          modelName;

        return attempt.result;
      }

      if (
        !shouldFallbackProvider(
          attempt.error,
        )
      ) {
        break;
      }
    }
  }

  /* ========================= */
  /* 3. GOOGLE KEY 2           */
  /* ========================= */

  if (env.GOOGLE_API_KEY_2) {
    for (const modelName of MODEL_FALLBACK_CHAIN) {
      const attempt =
        await tryGemini(
          'gemini2',
          modelName,
          messages,
          systemPrompt,
        );

      if ('result' in attempt) {
        currentProvider =
          'gemini2';

        currentModelName =
          attempt.result.model ??
          modelName;

        return attempt.result;
      }

      if (
        !shouldFallbackProvider(
          attempt.error,
        )
      ) {
        break;
      }
    }
  }

  throw new Error(
    '⚠️ *All AI providers are temporarily unavailable.*\n\n' +
      'Please try again later.',
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export async function validateAI(): Promise<ValidationResult> {
  /*
   * IMPORTANT:
   *
   * Validation must NOT make Google keys a requirement.
   *
   * BazaarLink is the primary provider.
   *
   * Therefore a failed Google validation does not disable
   * the application.
   */

  const result: ValidationResult = {
    key1Valid: false,
    key2Valid: null,
    currentModel: currentModelName,
    validatedModels: [],
  };

  /* ========================= */
  /* BazaarLink validation      */
  /* ========================= */

  if (env.BAZARLINK_API_KEY) {
    try {
      const response =
        await withTimeout(
          fetch(
            `${BAZAARLINK_BASE_URL}/chat/completions`,
            {
              method: 'POST',

              headers: {
                Authorization: `Bearer ${env.BAZARLINK_API_KEY}`,
                'Content-Type':
                  'application/json',
              },

              body: JSON.stringify({
                model: BAZAARLINK_MODEL,
                messages: [
                  {
                    role: 'user',
                    content:
                      'Reply with exactly: ok',
                  },
                ],
                max_tokens: 10,
                temperature: 0,
              }),
            },
          ),
          CONFIG.AI.TIMEOUT_MS,
          'BazaarLink validation timed out',
        );

      if (response.ok) {
        const data =
          (await response.json()) as {
            model?: string;
            choices?: Array<{
              message?: {
                content?: string;
              };
            }>;
          };

        const model =
          data.model ??
          BAZAARLINK_MODEL;

        result.validatedModels.push(
          model,
        );

        currentProvider =
          'bazaarlink';

        currentModelName =
          model;

        logger.info(
          {
            provider: 'bazaarlink',
            model,
          },
          'BazaarLink validation successful',
        );
      } else {
        const text =
          await response.text();

        logger.warn(
          {
            status:
              response.status,
            error: text,
          },
          'BazaarLink validation failed',
        );
      }
    } catch (error) {
      logger.warn(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        'BazaarLink validation failed',
      );
    }
  } else {
    logger.warn(
      'BAZARLINK_API_KEY is not configured',
    );
  }

  /* ========================= */
  /* Google Key 1 validation    */
  /* ========================= */

  if (env.GOOGLE_API_KEY_1) {
    try {
      const client =
        new GoogleGenerativeAI(
          env.GOOGLE_API_KEY_1,
        );

      const modelName =
        CONFIG.AI.MODELS.FLASH.startsWith(
          'models/',
        )
          ? CONFIG.AI.MODELS.FLASH.substring(
              7,
            )
          : CONFIG.AI.MODELS.FLASH;

      await client
        .getGenerativeModel({
          model: modelName,
        })
        .generateContent('test');

      result.key1Valid = true;

      result.validatedModels.push(
        modelName,
      );

      logger.info(
        {
          provider: 'gemini1',
          model: modelName,
        },
        'Google API Key 1 validation successful',
      );
    } catch (error) {
      result.key1Valid = false;

      logger.warn(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        'Google API Key 1 validation failed',
      );
    }
  }

  /* ========================= */
  /* Google Key 2 validation    */
  /* ========================= */

  if (env.GOOGLE_API_KEY_2) {
    try {
      const client =
        new GoogleGenerativeAI(
          env.GOOGLE_API_KEY_2,
        );

      const modelName =
        CONFIG.AI.MODELS.FLASH.startsWith(
          'models/',
        )
          ? CONFIG.AI.MODELS.FLASH.substring(
              7,
            )
          : CONFIG.AI.MODELS.FLASH;

      await client
        .getGenerativeModel({
          model: modelName,
        })
        .generateContent('test');

      result.key2Valid = true;

      result.validatedModels.push(
        modelName,
      );

      logger.info(
        {
          provider: 'gemini2',
          model: modelName,
        },
        'Google API Key 2 validation successful',
      );
    } catch (error) {
      result.key2Valid = false;

      logger.warn(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        'Google API Key 2 validation failed',
      );
    }
  }

  validationResult = result;

  /*
   * BazaarLink is considered the primary provider.
   * Do not report "no valid API keys" here.
   *
   * The actual generateResponse() function performs
   * the definitive provider test when a user sends a
   * message.
   */

  return result;
}

/* -------------------------------------------------------------------------- */
/* Performance / error tracking                                               */
/* -------------------------------------------------------------------------- */

const responseTimes: number[] = [];

let lastErrorTimestamp:
  | number
  | null = null;

let lastErrorMessage:
  | string
  | null = null;

export function trackResponseTime(
  ms: number,
): void {
  responseTimes.push(ms);

  if (responseTimes.length > 100) {
    responseTimes.shift();
  }
}

export function getAverageResponseTime(): string {
  if (responseTimes.length === 0) {
    return 'N/A';
  }

  const avg =
    responseTimes.reduce(
      (a, b) => a + b,
      0,
    ) / responseTimes.length;

  return `${avg.toFixed(0)}ms`;
}

export function trackError(
  error: string,
): void {
  lastErrorTimestamp =
    Date.now();

  lastErrorMessage = error;
}

export function getLastError(): {
  time: string;
  message: string;
} | null {
  if (
    !lastErrorTimestamp ||
    !lastErrorMessage
  ) {
    return null;
  }

  const seconds = Math.floor(
    (Date.now() -
      lastErrorTimestamp) /
      1000,
  );

  return {
    time: `${seconds}s ago`,
    message: lastErrorMessage,
  };
}

/* -------------------------------------------------------------------------- */
/* Connection test                                                            */
/* -------------------------------------------------------------------------- */

export async function testConnection(): Promise<{
  success: boolean;
  latency: string;
  error?: string;
}> {
  const start = Date.now();

  try {
    await generateResponse(
      [
        {
          role: 'user',
          content:
            'Reply with just: ok',
        },
      ],
      'chat',
      'english',
    );

    return {
      success: true,
      latency: `${Date.now() - start}ms`,
    };
  } catch (error) {
    return {
      success: false,
      latency: `${Date.now() - start}ms`,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error',
    };
  }
}

export function getValidationResult():
  | ValidationResult
  | null {
  return validationResult;
}

export function getCurrentModelName(): string {
  return currentModelName;
}

export function getCurrentApiKeyIndex(): number {
  /*
   * Existing project code appears to use this as a
   * provider indicator.
   *
   * 1 = Google Key 1
   * 2 = Google Key 2
   * 3 = BazaarLink
   */

  if (currentProvider === 'gemini1') {
    return 1;
  }

  if (currentProvider === 'gemini2') {
    return 2;
  }

  return 3;
}

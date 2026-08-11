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
import {
  withTimeout,
  sleep,
} from '../utils/helpers';

type Provider =
  | 'gemini1'
  | 'gemini2'
  | 'bazaarlink';

const clients = new Map<string, GoogleGenerativeAI>();

let currentModelName: string =
  CONFIG.AI.DEFAULT_MODEL;

let currentProvider: Provider = 'gemini1';

let validationResult:
  | ValidationResult
  | null = null;

/*
 * Keep this explicitly typed as string[].
 *
 * This prevents TypeScript from treating
 * MODEL_FALLBACK_CHAIN[index] as possibly undefined.
 */
const MODEL_FALLBACK_CHAIN: string[] = [
  CONFIG.AI.MODELS.FLASH,
  CONFIG.AI.MODELS.FLASH_LITE,
  CONFIG.AI.MODELS.PRO,
];

const PROVIDER_CHAIN: Provider[] = [
  'gemini1',
  'gemini2',
  'bazaarlink',
];

const BACKOFF_DELAYS: number[] = [
  1000,
  2000,
  4000,
];

const BAZAARLINK_BASE_URL =
  'https://bazaarlink.ai/api/v1';

/*
 * BazaarLink model.
 *
 * Render environment variable:
 *
 * BAZARLINK_MODEL=google/gemini-2.5-flash
 *
 * If BAZARLINK_MODEL is not configured,
 * this default will be used.
 */
const BAZAARLINK_MODEL: string =
  process.env.BAZARLINK_MODEL ||
  'google/gemini-2.5-flash';

const PROMPT_MAP: Record<string, string> = {
  chat: CHAT_PROMPT,
  code: CODE_PROMPT,
  translate: TRANSLATE_PROMPT,
  image_analysis: IMAGE_ANALYSIS_PROMPT,
  file_summary: FILE_SUMMARY_PROMPT,
};

const LANGUAGE_INSTRUCTION: Record<
  string,
  string
> = {
  hinglish:
    '\n\nReply in Hinglish using Roman script only.',

  hindi:
    '\n\nReply in Hindi only.',

  english:
    '\n\nReply in English only.',

  arabic:
    '\n\nReply in Arabic only.',

  french:
    '\n\nReply in French only.',

  urdu:
    '\n\nReply in Urdu only.',
};


/* =========================================================
   Utility helpers
   ========================================================= */

function errorToString(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}


function getGeminiApiKey(
  provider: 'gemini1' | 'gemini2',
): string | null {
  if (provider === 'gemini1') {
    return env.GOOGLE_API_KEY_1 || null;
  }

  return env.GOOGLE_API_KEY_2 || null;
}


function getClient(
  apiKey: string,
): GoogleGenerativeAI {
  const existing = clients.get(apiKey);

  if (existing) {
    return existing;
  }

  const client =
    new GoogleGenerativeAI(apiKey);

  clients.set(apiKey, client);

  return client;
}


/* =========================================================
   Error handling
   ========================================================= */

export function categorizeError(
  error: unknown,
): ErrorCategory {
  const message =
    errorToString(error).toLowerCase();

  if (
    message.includes('401') ||
    message.includes('unauthorized') ||
    message.includes('permission')
  ) {
    return 'auth';
  }

  if (
    message.includes('403') ||
    message.includes('forbidden')
  ) {
    return 'auth';
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
    message.includes('404') ||
    message.includes('not found') ||
    message.includes('model not found')
  ) {
    return 'invalid_request';
  }

  if (
    message.includes('400') ||
    message.includes('bad request') ||
    message.includes('invalid request')
  ) {
    return 'invalid_request';
  }

  if (
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
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
  ].includes(category);
}


export function getUserFacingError(
  category: ErrorCategory,
): string {
  switch (category) {
    case 'auth':
      return (
        '⚠️ *AI service is temporarily unavailable.*\n\n' +
        'Please try again later.'
      );

    case 'rate_limit':
      return (
        '⏳ *Too many requests.*\n\n' +
        'Please wait a moment and try again.'
      );

    case 'quota':
      return (
        '⚠️ *API quota exceeded.*\n\n' +
        'Please try again later.'
      );

    case 'service_unavailable':
      return (
        '🔧 *AI service is temporarily unavailable.*\n\n' +
        'Please try again in a few moments.'
      );

    case 'timeout':
      return (
        '⏱️ *Request took too long.*\n\n' +
        'Please try again.'
      );

    case 'invalid_request':
      return (
        '⚠️ *Invalid AI request.*\n\n' +
        'Please try again.'
      );

    default:
      return (
        '❌ *An unexpected AI error occurred.*\n\n' +
        'Please try again later.'
      );
  }
}


/* =========================================================
   Prompt handling
   ========================================================= */

async function loadPromptIdentity(): Promise<{
  name: string;
  creator: string;
}> {
  try {
    const [
      nameSetting,
      creatorSetting,
    ] = await Promise.all([
      prisma.setting.findUnique({
        where: {
          key: 'bot_name',
        },
      }),

      prisma.setting.findUnique({
        where: {
          key: 'creator_username',
        },
      }),
    ]);

    return {
      name:
        nameSetting?.value ??
        'AI Assistant',

      creator:
        creatorSetting?.value ??
        '@MaxToolsbd_bot',
    };
  } catch {
    return {
      name: 'AI Assistant',
      creator: '@MaxToolsbd_bot',
    };
  }
}


export async function getPromptForMode(
  mode: string,
  language?: string,
): Promise<string> {
  const base =
    PROMPT_MAP[mode] ??
    CHAT_PROMPT;

  const identity =
    await loadPromptIdentity();

  const withIdentity =
    base
      .replace(
        /\{CREATOR\}/g,
        identity.creator,
      )
      .replace(
        /\{BOT_NAME\}/g,
        identity.name,
      );

  const instruction =
    LANGUAGE_INSTRUCTION[
      language ?? 'english'
    ] ??
    LANGUAGE_INSTRUCTION.english;

  return (
    withIdentity +
    instruction
  );
}


/* =========================================================
   Gemini
   ========================================================= */

async function tryGemini(
  provider: 'gemini1' | 'gemini2',
  modelName: string,
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey =
    getGeminiApiKey(provider);

  if (!apiKey) {
    logger.warn(
      { provider },
      'Gemini provider has no API key',
    );

    return {
      error: 'auth',
    };
  }

  try {
    const client =
      getClient(apiKey);

    const model =
      client.getGenerativeModel({
        model: modelName,
      });

    const history =
      messages
        .slice(0, -1)
        .filter(
          (msg) =>
            msg.role === 'user' ||
            msg.role === 'assistant',
        )
        .map((msg) => ({
          role:
            msg.role === 'assistant'
              ? ('model' as const)
              : ('user' as const),

          parts: [
            {
              text: msg.content,
            },
          ],
        }));

    const lastMessage =
      messages[
        messages.length - 1
      ];

    const lastContent =
      lastMessage?.content ?? '';

    const chat =
      model.startChat({
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

    const result =
      await withTimeout(
        chat.sendMessageStream(
          lastContent,
        ),
        CONFIG.AI.TIMEOUT_MS,
        'Gemini timed out',
      );

    let text = '';

    for await (
      const chunk of result.stream
    ) {
      text += chunk.text();
    }

    if (!text.trim()) {
      throw new Error(
        'Gemini returned an empty response',
      );
    }

    return {
      result: {
        text,
        model: modelName,
      },
    };
  } catch (error) {
    const category =
      categorizeError(error);

    logger.error(
      {
        provider,
        model: modelName,
        category,
        error:
          errorToString(error),
      },
      'Gemini request failed',
    );

    return {
      error: category,
    };
  }
}


/* =========================================================
   BazaarLink
   ========================================================= */

async function tryBazaarLink(
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey =
    env.BAZARLINK_API_KEY;

  if (!apiKey) {
    logger.warn(
      'BAZARLINK_API_KEY is not configured',
    );

    return {
      error: 'auth',
    };
  }

  try {
    const requestMessages = [
      {
        role: 'system',
        content: systemPrompt,
      },

      ...messages
        .filter(
          (msg) =>
            msg.role === 'user' ||
            msg.role === 'assistant',
        )
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
    ];

    const body = {
      model: BAZAARLINK_MODEL,
      messages: requestMessages,
      stream: false,
      temperature:
        CONFIG.AI.TEMPERATURE,
      max_tokens:
        CONFIG.AI.MAX_TOKENS,
      top_p:
        CONFIG.AI.TOP_P,
    };

    logger.info(
      {
        provider: 'bazaarlink',
        model: BAZAARLINK_MODEL,
      },
      'Calling BazaarLink fallback',
    );

    const response =
      await withTimeout(
        fetch(
          `${BAZAARLINK_BASE_URL}/chat/completions`,
          {
            method: 'POST',

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify(body),
          },
        ),

        CONFIG.AI.TIMEOUT_MS,

        'BazaarLink timed out',
      );

    const responseText =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `BazaarLink HTTP ${response.status}: ${responseText}`,
      );
    }

    let data: {
      choices?: Array<{
        message?: {
          content?:
            | string
            | null;
        };
      }>;

      error?: {
        message?: string;
      };
    };

    try {
      data =
        JSON.parse(
          responseText,
        );
    } catch {
      throw new Error(
        'BazaarLink returned invalid JSON',
      );
    }

    if (data.error?.message) {
      throw new Error(
        `BazaarLink API error: ${data.error.message}`,
      );
    }

    const text =
      data.choices?.[0]?.message
        ?.content ?? '';

    if (!text.trim()) {
      throw new Error(
        'BazaarLink returned an empty response',
      );
    }

    return {
      result: {
        text,
        model:
          BAZAARLINK_MODEL,
      },
    };
  } catch (error) {
    const category =
      categorizeError(error);

    logger.error(
      {
        provider: 'bazaarlink',
        model: BAZAARLINK_MODEL,
        category,
        error:
          errorToString(error),
      },
      'BazaarLink request failed',
    );

    return {
      error: category,
    };
  }
}


/* =========================================================
   Main AI generation
   ========================================================= */

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

  let lastError:
    ErrorCategory = 'unknown';

  for (
    const provider of PROVIDER_CHAIN
  ) {
    logger.info(
      { provider },
      'Trying AI provider',
    );

    /*
     * BazaarLink is the final fallback.
     */
    if (
      provider === 'bazaarlink'
    ) {
      const attempt =
        await tryBazaarLink(
          messages,
          systemPrompt,
        );

      if (
        'result' in attempt
      ) {
        currentProvider =
          'bazaarlink';

        currentModelName =
          attempt.result.model ??
          BAZAARLINK_MODEL;

        logger.info(
          {
            provider:
              'bazaarlink',

            model:
              currentModelName,
          },

          'BazaarLink request succeeded',
        );

        return attempt.result;
      }

      lastError =
        attempt.error;

      logger.warn(
        {
          provider:
            'bazaarlink',

          errorCategory:
            attempt.error,
        },

        'BazaarLink fallback failed',
      );

      continue;
    }

    /*
     * Gemini model fallback chain.
     *
     * Using for...of instead of array[index]
     * prevents string | undefined TypeScript errors.
     */
    for (
      const modelName
      of MODEL_FALLBACK_CHAIN
    ) {
      const attempt =
        await tryGemini(
          provider,
          modelName,
          messages,
          systemPrompt,
        );

      if (
        'result' in attempt
      ) {
        currentProvider =
          provider;

        currentModelName =
          modelName;

        logger.info(
          {
            provider,
            model: modelName,
          },

          'Gemini request succeeded',
        );

        return attempt.result;
      }

      lastError =
        attempt.error;

      if (
        !shouldFallbackProvider(
          attempt.error,
        )
      ) {
        break;
      }

      const modelIndex =
        MODEL_FALLBACK_CHAIN.indexOf(
          modelName,
        );

      if (
        modelIndex >= 0 &&
        modelIndex <
          MODEL_FALLBACK_CHAIN.length - 1
      ) {
        const delay =
          BACKOFF_DELAYS[
            Math.min(
              modelIndex,
              BACKOFF_DELAYS.length - 1,
            )
          ] ?? 4000;

        await sleep(delay);
      }
    }
  }

  throw new Error(
    getUserFacingError(
      lastError,
    ),
  );
}


/* =========================================================
   AI validation
   ========================================================= */

export async function validateAI(): Promise<ValidationResult> {
  const flashModel: string =
    CONFIG.AI.MODELS.FLASH;

  const result: ValidationResult = {
    key1Valid: false,
    key2Valid: null,
    currentModel:
      currentModelName,
    validatedModels: [],
  };

  /*
   * Google API Key 1
   */
  if (env.GOOGLE_API_KEY_1) {
    try {
      const client =
        new GoogleGenerativeAI(
          env.GOOGLE_API_KEY_1,
        );

      await client
        .getGenerativeModel({
          model: flashModel,
        })
        .generateContent(
          'test',
        );

      result.key1Valid =
        true;

      result.validatedModels.push(
        flashModel,
      );

      logger.info(
        'Google API Key 1 validation successful',
      );
    } catch (error) {
      result.key1Valid =
        false;

      logger.error(
        {
          error:
            errorToString(error),
        },

        'API Key 1 validation failed',
      );
    }
  }


  /*
   * Google API Key 2
   */
  if (env.GOOGLE_API_KEY_2) {
    try {
      const client =
        new GoogleGenerativeAI(
          env.GOOGLE_API_KEY_2,
        );

      await client
        .getGenerativeModel({
          model: flashModel,
        })
        .generateContent(
          'test',
        );

      result.key2Valid =
        true;

      result.validatedModels.push(
        flashModel,
      );

      logger.info(
        'Google API Key 2 validation successful',
      );
    } catch (error) {
      result.key2Valid =
        false;

      logger.error(
        {
          error:
            errorToString(error),
        },

        'API Key 2 validation failed',
      );
    }
  }


  /*
   * BazaarLink
   *
   * We only verify that the key exists here.
   * The actual BazaarLink API is tested when
   * generateResponse() reaches the fallback.
   */
  if (
    env.BAZARLINK_API_KEY
  ) {
    logger.info(
      {
        model:
          BAZAARLINK_MODEL,
      },

      'BazaarLink fallback configured',
    );
  } else {
    logger.warn(
      'BazaarLink fallback is not configured',
    );
  }


  /*
   * Validate available Gemini models.
   *
   * Only attempt model validation when
   * at least one Gemini key exists.
   */
  const validationKey =
    env.GOOGLE_API_KEY_1 ||
    env.GOOGLE_API_KEY_2;

  if (validationKey) {
    const client =
      new GoogleGenerativeAI(
        validationKey,
      );

    for (
      const modelName
      of MODEL_FALLBACK_CHAIN
    ) {
      try {
        await client
          .getGenerativeModel({
            model: modelName,
          })
          .generateContent(
            'test',
          );

        if (
          !result.validatedModels.includes(
            modelName,
          )
        ) {
          result.validatedModels.push(
            modelName,
          );
        }

        logger.info(
          {
            model: modelName,
          },

          'Model validation successful',
        );
      } catch (error) {
        logger.warn(
          {
            model: modelName,
            error:
              errorToString(error),
          },

          'Model validation skipped',
        );
      }
    }
  }


  /*
   * Always use a guaranteed string here.
   */
  result.currentModel =
    currentModelName ||
    CONFIG.AI.DEFAULT_MODEL;

  validationResult =
    result;

  return result;
}


/* =========================================================
   Statistics
   ========================================================= */

const responseTimes: number[] = [];

let lastErrorTimestamp:
  number | null = null;

let lastErrorMessage:
  string | null = null;


export function trackResponseTime(
  ms: number,
): void {
  responseTimes.push(ms);

  if (
    responseTimes.length > 100
  ) {
    responseTimes.shift();
  }
}


export function getAverageResponseTime(): string {
  if (
    responseTimes.length === 0
  ) {
    return 'N/A';
  }

  const avg =
    responseTimes.reduce(
      (
        total,
        value,
      ) => total + value,
      0,
    ) /
    responseTimes.length;

  return `${avg.toFixed(0)}ms`;
}


export function trackError(
  error: string,
): void {
  lastErrorTimestamp =
    Date.now();

  lastErrorMessage =
    error;
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

  const seconds =
    Math.floor(
      (
        Date.now() -
        lastErrorTimestamp
      ) / 1000,
    );

  return {
    time: `${seconds}s ago`,
    message:
      lastErrorMessage,
  };
}


/* =========================================================
   Connection test
   ========================================================= */

export async function testConnection(): Promise<{
  success: boolean;
  latency: string;
  error?: string;
}> {
  const start =
    Date.now();

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
      latency:
        `${Date.now() - start}ms`,
    };
  } catch (error) {
    return {
      success: false,

      latency:
        `${Date.now() - start}ms`,

      error:
        errorToString(error),
    };
  }
}


/* =========================================================
   Public status functions
   ========================================================= */

export function getValidationResult():
  ValidationResult | null {
  return validationResult;
}


export function getCurrentModelName(): string {
  return (
    currentModelName ||
    CONFIG.AI.DEFAULT_MODEL
  );
}


export function getCurrentApiKeyIndex(): number {
  if (
    currentProvider === 'gemini1'
  ) {
    return 1;
  }

  if (
    currentProvider === 'gemini2'
  ) {
    return 2;
  }

  return 3;
}

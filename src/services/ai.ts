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

const BAZAARLINK_BASE_URL = 'https://bazaarlink.ai/api/v1';

/*
 * BazaarLink
 *
 * IMPORTANT:
 * Always use the full provider/model format.
 *
 * Example:
 *   google/gemini-2.5-flash
 *
 * You can override this on Render:
 *
 *   BAZARLINK_MODEL=google/gemini-2.5-flash
 *
 * "auto:free" is intentionally NOT used as the default because
 * an explicit model gives much more predictable routing.
 */
const BAZAARLINK_MODEL =
  process.env.BAZARLINK_MODEL?.trim() ||
  'google/gemini-2.5-flash';

/*
 * Optional BazaarLink fallback models.
 *
 * BazaarLink itself supports provider/model routing. We keep this
 * conservative so the primary request remains predictable.
 */
const BAZAARLINK_FALLBACK_MODELS = [
  BAZAARLINK_MODEL,
  'google/gemini-2.5-flash-lite',
].filter(
  (model, index, array) =>
    Boolean(model) && array.indexOf(model) === index,
);

/*
 * Google fallback models.
 *
 * DO NOT use the old Gemini 2.5 IDs here.
 *
 * Google retired/deprecated the old 2.5 production models.
 *
 * Current production-oriented fallback:
 *
 *   1. gemini-3.5-flash
 *   2. gemini-3.1-flash-lite
 *
 * These are only used when BazaarLink fails.
 */
const GOOGLE_MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const MAX_RETRY_COUNT =
  CONFIG.MAX_RETRY_COUNT ?? 3;

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

let currentModelName = BAZAARLINK_MODEL;
let currentProvider: Provider = 'bazaarlink';

let validationResult: ValidationResult | null = null;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function getGeminiApiKey(
  provider: 'gemini1' | 'gemini2',
): string | null {
  if (provider === 'gemini1') {
    return env.GOOGLE_API_KEY_1?.trim() || null;
  }

  return env.GOOGLE_API_KEY_2?.trim() || null;
}

function getClient(
  apiKey: string,
): GoogleGenerativeAI {
  const existing = clients.get(apiKey);

  if (existing) {
    return existing;
  }

  const client = new GoogleGenerativeAI(apiKey);

  clients.set(apiKey, client);

  return client;
}

function normalizeGoogleModel(
  modelName: string,
): string {
  return modelName.startsWith('models/')
    ? modelName.substring(7)
    : modelName;
}

function extractBazaarLinkText(
  data: unknown,
): string {
  if (!data || typeof data !== 'object') {
    return '';
  }

  const payload = data as Record<string, unknown>;

  /*
   * Standard OpenAI-compatible response.
   */
  const choices = payload.choices;

  if (Array.isArray(choices)) {
    const firstChoice = choices[0];

    if (
      firstChoice &&
      typeof firstChoice === 'object'
    ) {
      const choice =
        firstChoice as Record<string, unknown>;

      const message = choice.message;

      if (
        message &&
        typeof message === 'object'
      ) {
        const messageObject =
          message as Record<string, unknown>;

        const content =
          messageObject.content;

        if (typeof content === 'string') {
          return content;
        }

        /*
         * Some OpenAI-compatible APIs may return
         * content as an array of text blocks.
         */
        if (Array.isArray(content)) {
          const parts = content
            .map((part) => {
              if (
                typeof part === 'string'
              ) {
                return part;
              }

              if (
                part &&
                typeof part === 'object'
              ) {
                const block =
                  part as Record<
                    string,
                    unknown
                  >;

                if (
                  typeof block.text ===
                  'string'
                ) {
                  return block.text;
                }
              }

              return '';
            })
            .filter(Boolean);

          return parts.join('');
        }
      }

      /*
       * Streaming-style response fallback.
       */
      const delta = choice.delta;

      if (
        delta &&
        typeof delta === 'object'
      ) {
        const deltaObject =
          delta as Record<string, unknown>;

        if (
          typeof deltaObject.content ===
          'string'
        ) {
          return deltaObject.content;
        }
      }
    }
  }

  /*
   * Generic fallback fields.
   *
   * These are intentionally conservative and are
   * only used when BazaarLink returns a slightly
   * different normalized response.
   */
  const output = payload.output;

  if (typeof output === 'string') {
    return output;
  }

  const text = payload.text;

  if (typeof text === 'string') {
    return text;
  }

  return '';
}

function extractBazaarLinkModel(
  data: unknown,
): string {
  if (
    data &&
    typeof data === 'object'
  ) {
    const model =
      (data as Record<string, unknown>)
        .model;

    if (typeof model === 'string') {
      return model;
    }
  }

  return BAZAARLINK_MODEL;
}

function extractApiError(
  data: unknown,
): string | null {
  if (
    !data ||
    typeof data !== 'object'
  ) {
    return null;
  }

  const payload =
    data as Record<string, unknown>;

  const error = payload.error;

  if (typeof error === 'string') {
    return error;
  }

  if (
    error &&
    typeof error === 'object'
  ) {
    const errorObject =
      error as Record<string, unknown>;

    const message =
      errorObject.message;

    if (typeof message === 'string') {
      return message;
    }

    const code = errorObject.code;

    if (typeof code === 'string') {
      return code;
    }

    const type = errorObject.type;

    if (typeof type === 'string') {
      return type;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Error handling                                                             */
/* -------------------------------------------------------------------------- */

export function categorizeError(
  error: unknown,
): ErrorCategory {
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
    message.includes('400') ||
    message.includes('bad request') ||
    message.includes('invalid request') ||
    message.includes('invalid_request')
  ) {
    return 'invalid_request';
  }

  if (
    message.includes('402') ||
    message.includes('credits') ||
    message.includes('insufficient credits') ||
    message.includes('payment required')
  ) {
    return 'quota';
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
    message.includes('insufficient')
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

/* -------------------------------------------------------------------------- */
/* Prompt handling                                                            */
/* -------------------------------------------------------------------------- */

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
        where: { key: 'bot_name' },
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
        'TeleForge AI',
      creator:
        creatorSetting?.value ??
        '@TeleforgeOfficial',
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
  const base =
    PROMPT_MAP[mode] ?? CHAT_PROMPT;

  const identity =
    await loadPromptIdentity();

  const withIdentity = base
    .replace(
      /\{CREATOR\}/g,
      identity.creator,
    )
    .replace(
      /\{BOT_NAME\}/g,
      identity.name,
    );

  return (
    withIdentity +
    (
      LANGUAGE_INSTRUCTION[
        language ?? 'english'
      ] ??
      LANGUAGE_INSTRUCTION.english
    )
  );
}

/* -------------------------------------------------------------------------- */
/* BazaarLink primary                                                         */
/* -------------------------------------------------------------------------- */

async function tryBazaarLink(
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<
  | { result: AIResponse }
  | { error: ErrorCategory }
> {
  const apiKey =
    env.BAZARLINK_API_KEY?.trim();

  if (!apiKey) {
    logger.warn(
      'BAZARLINK_API_KEY is not configured',
    );

    return {
      error: 'auth',
    };
  }

  try {
    logger.info(
      {
        provider: 'bazaarlink',
        model: BAZAARLINK_MODEL,
      },
      'Trying BazaarLink primary provider',
    );

    const body: Record<
      string,
      unknown
    > = {
      model: BAZAARLINK_MODEL,

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

      stream: false,

      temperature:
        CONFIG.AI.TEMPERATURE,

      top_p: CONFIG.AI.TOP_P,

      max_tokens:
        CONFIG.AI.MAX_TOKENS,
    };

    /*
     * Only send BazaarLink's model fallback
     * field when there is actually more than
     * one model configured.
     */
    if (
      BAZAARLINK_FALLBACK_MODELS.length >
      1
    ) {
      body.models =
        BAZAARLINK_FALLBACK_MODELS;
    }

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

            body: JSON.stringify(body),
          },
        ),

        CONFIG.AI.TIMEOUT_MS,

        'BazaarLink timed out',
      );

    const rawText =
      await response.text();

    let data: unknown = null;

    if (rawText.trim()) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const apiError =
        extractApiError(data);

      throw new Error(
        `BazaarLink HTTP ${response.status}: ${
          apiError ??
          rawText.slice(0, 500) ??
          'Unknown response'
        }`,
      );
    }

    const text =
      extractBazaarLinkText(data);

    if (!text.trim()) {
      /*
       * This is the exact problem shown in the
       * previous deployment logs.
       *
       * Instead of silently returning "no content",
       * include enough diagnostic information
       * to identify the actual response shape.
       */
      const responseKeys =
        data &&
        typeof data === 'object'
          ? Object.keys(
              data as Record<
                string,
                unknown
              >,
            ).join(', ')
          : 'non-object';

      throw new Error(
        `BazaarLink returned no AI content. ` +
          `Response keys: ${responseKeys}`,
      );
    }

    const resolvedModel =
      extractBazaarLinkModel(data);

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
    const category =
      categorizeError(error);

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
/* Google fallback                                                            */
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
  const apiKey =
    getGeminiApiKey(provider);

  if (!apiKey) {
    return {
      error: 'auth',
    };
  }

  const normalizedModel =
    normalizeGoogleModel(modelName);

  try {
    logger.info(
      {
        provider,
        model: normalizedModel,
      },
      'Trying Google Gemini fallback',
    );

    const client =
      getClient(apiKey);

    const model =
      client.getGenerativeModel({
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

    if (!lastContent.trim()) {
      throw new Error(
        'No user message was provided',
      );
    }

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
      try {
        text += chunk.text();
      } catch {
        /*
         * Ignore non-text chunks.
         */
      }
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
    const category =
      categorizeError(error);

    logger.warn(
      {
        provider,
        model: normalizedModel,
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
/* Main generation                                                            */
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
   * ============================================================
   * PROVIDER ORDER
   *
   * 1. BazaarLink
   * 2. Google API Key 1
   * 3. Google API Key 2
   *
   * BazaarLink is ALWAYS attempted first.
   * ============================================================
   */

  /* ---------------------------------------------------------------------- */
  /* 1. BazaarLink primary                                                  */
  /* ---------------------------------------------------------------------- */

  let lastError:
    | ErrorCategory
    | null = null;

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
      currentProvider =
        'bazaarlink';

      currentModelName =
        attempt.result.model ??
        BAZAARLINK_MODEL;

      return attempt.result;
    }

    lastError = attempt.error;

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

  /* ---------------------------------------------------------------------- */
  /* 2. Google API key 1                                                    */
  /* ---------------------------------------------------------------------- */

  if (
    env.GOOGLE_API_KEY_1?.trim()
  ) {
    for (
      const modelName of
        GOOGLE_MODEL_FALLBACK_CHAIN
    ) {
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

      lastError = attempt.error;

      if (
        !shouldFallbackProvider(
          attempt.error,
        )
      ) {
        break;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Google API key 2                                                    */
  /* ---------------------------------------------------------------------- */

  if (
    env.GOOGLE_API_KEY_2?.trim()
  ) {
    for (
      const modelName of
        GOOGLE_MODEL_FALLBACK_CHAIN
    ) {
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

      lastError = attempt.error;

      if (
        !shouldFallbackProvider(
          attempt.error,
        )
      ) {
        break;
      }
    }
  }

  logger.error(
    {
      lastError,
      bazaarLink:
        Boolean(
          env.BAZARLINK_API_KEY,
        ),
      googleKey1:
        Boolean(
          env.GOOGLE_API_KEY_1,
        ),
      googleKey2:
        Boolean(
          env.GOOGLE_API_KEY_2,
        ),
    },
    'All AI providers failed',
  );

  throw new Error(
    '⚠️ *All AI providers are temporarily unavailable.*\n\n' +
      'Please try again later.',
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export async function validateAI(): Promise<ValidationResult> {
  const result: ValidationResult = {
    key1Valid: false,
    key2Valid: null,
    currentModel:
      currentModelName,
    validatedModels: [],
  };

  /* ---------------------------------------------------------------------- */
  /* BazaarLink validation                                                  */
  /* ---------------------------------------------------------------------- */

  if (
    env.BAZARLINK_API_KEY?.trim()
  ) {
    try {
      logger.info(
        {
          provider: 'bazaarlink',
          model: BAZAARLINK_MODEL,
        },
        'Validating BazaarLink primary provider',
      );

      const response =
        await withTimeout(
          fetch(
            `${BAZAARLINK_BASE_URL}/chat/completions`,
            {
              method: 'POST',

              headers: {
                Authorization:
                  `Bearer ${env.BAZARLINK_API_KEY.trim()}`,

                'Content-Type':
                  'application/json',
              },

              body: JSON.stringify({
                model: BAZAARLINK_MODEL,

                messages: [
                  {
                    role: 'user',
                    content:
                      'Reply with exactly: OK',
                  },
                ],

                stream: false,

                temperature: 0,

                max_tokens: 10,
              }),
            },
          ),

          CONFIG.AI.TIMEOUT_MS,

          'BazaarLink validation timed out',
        );

      const rawText =
        await response.text();

      let data: unknown = null;

      if (rawText.trim()) {
        try {
          data = JSON.parse(
            rawText,
          );
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        const apiError =
          extractApiError(data);

        throw new Error(
          `BazaarLink validation HTTP ${response.status}: ${
            apiError ??
            rawText.slice(0, 500)
          }`,
        );
      }

      const text =
        extractBazaarLinkText(data);

      if (!text.trim()) {
        const responseKeys =
          data &&
          typeof data === 'object'
            ? Object.keys(
                data as Record<
                  string,
                  unknown
                >,
              ).join(', ')
            : 'non-object';

        throw new Error(
          `BazaarLink validation returned no AI content. ` +
            `Response keys: ${responseKeys}`,
        );
      }

      const model =
        extractBazaarLinkModel(data);

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
          responsePreview:
            text.slice(0, 50),
        },
        'BazaarLink validation successful',
      );
    } catch (error) {
      logger.warn(
        {
          provider: 'bazaarlink',
          model: BAZAARLINK_MODEL,
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

  /* ---------------------------------------------------------------------- */
  /* Google API key 1 validation                                             */
  /* ---------------------------------------------------------------------- */

  if (
    env.GOOGLE_API_KEY_1?.trim()
  ) {
    for (
      const modelName of
        GOOGLE_MODEL_FALLBACK_CHAIN
    ) {
      try {
        const client =
          getClient(
            env.GOOGLE_API_KEY_1.trim(),
          );

        const model =
          client.getGenerativeModel({
            model: modelName,
          });

        const response =
          await withTimeout(
            model.generateContent(
              'Reply with exactly: OK',
            ),
            CONFIG.AI.TIMEOUT_MS,
            `Google ${modelName} validation timed out`,
          );

        const text =
          response.response
            .text();

        if (!text.trim()) {
          throw new Error(
            'Google returned empty validation response',
          );
        }

        result.key1Valid =
          true;

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

        break;
      } catch (error) {
        result.key1Valid =
          false;

        logger.warn(
          {
            provider: 'gemini1',
            model: modelName,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          'Google API Key 1 validation failed',
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Google API key 2 validation                                             */
  /* ---------------------------------------------------------------------- */

  if (
    env.GOOGLE_API_KEY_2?.trim()
  ) {
    result.key2Valid = false;

    for (
      const modelName of
        GOOGLE_MODEL_FALLBACK_CHAIN
    ) {
      try {
        const client =
          getClient(
            env.GOOGLE_API_KEY_2.trim(),
          );

        const model =
          client.getGenerativeModel({
            model: modelName,
          });

        const response =
          await withTimeout(
            model.generateContent(
              'Reply with exactly: OK',
            ),
            CONFIG.AI.TIMEOUT_MS,
            `Google ${modelName} validation timed out`,
          );

        const text =
          response.response
            .text();

        if (!text.trim()) {
          throw new Error(
            'Google returned empty validation response',
          );
        }

        result.key2Valid =
          true;

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

        break;
      } catch (error) {
        logger.warn(
          {
            provider: 'gemini2',
            model: modelName,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          'Google API Key 2 validation failed',
        );
      }
    }
  }

  validationResult =
    result;

  /*
   * Do NOT fail validation simply because
   * Google keys are invalid.
   *
   * BazaarLink is the primary provider.
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
      (Date.now() -
        lastErrorTimestamp) /
        1000,
    );

  return {
    time: `${seconds}s ago`,
    message:
      lastErrorMessage,
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
  const start =
    Date.now();

  try {
    await generateResponse(
      [
        {
          role: 'user',
          content:
            'Reply with just: OK',
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
        error instanceof Error
          ? error.message
          : 'Unknown error',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Status helpers                                                             */
/* -------------------------------------------------------------------------- */

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
   * Existing project convention:
   *
   * 1 = Google Key 1
   * 2 = Google Key 2
   * 3 = BazaarLink
   */
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

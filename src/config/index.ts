export const CONFIG = {
  AI: {
    MAX_TOKENS: 8192,
    TEMPERATURE: 0.7,
    TOP_P: 0.95,
    TOP_K: 40,
    TIMEOUT_MS: 15000,
    DEFAULT_MODEL: 'models/gemini-2.5-flash',
    MODELS: {
      FLASH: 'models/gemini-2.5-flash',
      FLASH_LITE: 'models/gemini-2.5-flash-lite',
      PRO: 'models/gemini-2.5-pro',
    },
  },
  BOT: {
    MAX_CONVERSATION_LENGTH: 40,
    MAX_MESSAGE_LENGTH: 4000,
    KEEP_LAST_MESSAGES: 20,
  },
  IMAGE: {
    DAILY_LIMIT_FREE: 5,
    DAILY_LIMIT_PREMIUM: 50,
  },
  RATE_LIMIT: {
    WINDOW_MS: 60_000,
    MAX_REQUESTS: 10,
  },
  MAX_RETRY_COUNT: 3,
  BACKOFF_DELAYS: [1000, 2000, 4000],
} as const;

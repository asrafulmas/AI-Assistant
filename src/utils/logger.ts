import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  redact: {
    paths: ['BOT_TOKEN', 'GOOGLE_API_KEY_1', 'GOOGLE_API_KEY_2', 'DATABASE_URL'],
    censor: '[REDACTED]',
  },
});

import express from 'express';
import { createBot } from './bot';
import { env } from './config/env';
import { logger } from './utils/logger';
import { getValidationResult } from './services/ai';
import { prisma } from './database/prisma';
import { verifyProtectedChannel } from './config/protected';

async function main(): Promise<void> {
  logger.info('Starting TeleForge AI...');

  const protectedCheck = verifyProtectedChannel();
  if (!protectedCheck.valid) {
    for (const err of protectedCheck.errors) {
      logger.error({ error: err }, 'Protected channel verification failed');
    }
    throw new Error(`Protected channel configuration is invalid: ${protectedCheck.errors.join('; ')}`);
  }
  logger.info({ channel: '@TeleforgeOfficial' }, 'Protected channel verified');

  const bot = await createBot();

  if (env.NODE_ENV === 'development') {
    const app = express();

    app.get('/', (_req, res) => {
      res.send('bot is running');
    });

    app.get('/health', (_req, res) => {
      const validation = getValidationResult();
      res.json({
        status: 'healthy',
        ai: {
          key1Valid: validation?.key1Valid ?? false,
          key2Valid: validation?.key2Valid ?? null,
          currentModel: validation?.currentModel ?? 'unknown',
          validatedModels: validation?.validatedModels ?? [],
        },
        uptime: process.uptime(),
      });
    });

    app.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Dev server listening');
    });

    await bot.launch();
    logger.info('Bot started in polling mode');
  } else {
    const app = express();

    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString();
      },
    }));

    app.get('/', (_req, res) => {
      res.send('bot is running');
    });

    app.get('/health', (_req, res) => {
      const validation = getValidationResult();
      res.json({
        status: 'healthy',
        ai: {
          key1Valid: validation?.key1Valid ?? false,
          key2Valid: validation?.key2Valid ?? null,
          currentModel: validation?.currentModel ?? 'unknown',
          validatedModels: validation?.validatedModels ?? [],
        },
        uptime: process.uptime(),
      });
    });

    if (env.WEBHOOK_SECRET) {
      app.use((req, res, next) => {
        if (req.path === `/${env.BOT_TOKEN}`) {
          const secret = req.headers['x-telegram-bot-api-secret-token'];
          if (secret !== env.WEBHOOK_SECRET) {
            logger.warn({ ip: req.ip }, 'Invalid webhook secret');
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
        }
        next();
      });
    } else {
      logger.warn('WEBHOOK_SECRET is not set — webhook endpoint is unsecured');
    }

    app.use(bot.webhookCallback(`/${env.BOT_TOKEN}`));

    app.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await bot.stop();
      await prisma.$disconnect();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({ error }, 'Fatal startup error');
  process.exit(1);
});

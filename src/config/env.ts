import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  OWNER_ID: z.string().min(1, 'OWNER_ID is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_API_KEY_1: z.string().min(1, 'GOOGLE_API_KEY_1 is required'),
  GOOGLE_API_KEY_2: z.string().optional().default(''),
  CLOUDFLARE_AI_URL: z.string().optional().default(''),
  CLOUDFLARE_AI_KEY: z.string().optional().default(''),
  WEBHOOK_SECRET: z.string().optional().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  RESPONSE_TIMEOUT: z.coerce.number().int().positive().default(15000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

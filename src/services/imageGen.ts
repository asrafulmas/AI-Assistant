import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ImageGenResult {
  success: boolean;
  buffer?: Buffer;
  error?: string;
}

export async function generateImage(prompt: string): Promise<ImageGenResult> {
  const workerUrl = env.CLOUDFLARE_AI_URL;
  const apiKey = env.CLOUDFLARE_AI_KEY;

  if (!workerUrl || !apiKey) {
    logger.warn('Cloudflare AI not configured — missing URL or API key');
    return { success: false, error: 'Image generation is not configured.' };
  }

  try {
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      logger.error({ status: response.status, text }, 'Cloudflare AI request failed');
      return { success: false, error: `Image generation failed (${response.status}).` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    logger.info({ promptLength: prompt.length, size: buffer.length }, 'Image generated successfully');
    return { success: true, buffer };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: msg }, 'Cloudflare AI request error');
    return { success: false, error: 'Image generation service is unavailable.' };
  }
}

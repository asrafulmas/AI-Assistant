/**
 * TeleForge AI — Cloudflare Workers AI (Stable Diffusion XL)
 *
 * Deploy this file as a Cloudflare Worker.
 * It proxies image generation requests from the Telegram bot to Cloudflare's Workers AI.
 *
 * Setup:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Paste this entire file as the worker code
 * 3. Go to Settings → Variables and add:
 *    - AI_KEY: a secret key (must match CLOUDFLARE_AI_KEY in your bot .env)
 * 4. Deploy
 * 5. Copy the worker URL (e.g. https://teleforge-image-gen.teleforgeofficial.workers.dev)
 * 6. Set CLOUDFLARE_AI_URL in your bot .env to this URL
 */

export default {
  async fetch(request, env) {
    // CORS headers for browser access (optional)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Verify API key
    const authHeader = request.headers.get('Authorization');
    const expectedKey = env.AI_KEY;

    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    try {
      const { prompt } = await request.json();

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        return new Response(JSON.stringify({ error: 'Prompt is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Call Cloudflare Workers AI — Stable Diffusion XL
      const inputs = {
        prompt: prompt,
        num_steps: 20,
        guidance_scale: 7.5,
      };

      const response = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', inputs);

      // Convert the image to a binary response
      return new Response(response, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
          ...corsHeaders,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

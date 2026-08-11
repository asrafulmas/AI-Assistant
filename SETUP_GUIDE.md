# 🔧 TeleForge AI — Full Setup Guide

## 📋 Quick Links

| Service | Link | Purpose |
|---------|------|---------|
| **GitHub Repo** | https://github.com/teleforgeofficiall/TELEFORGE-AI-BOT | Source code |
| **Render Dashboard** | https://dashboard.render.com | Deploy bot (Web Service) |
| **Neon Console** | https://console.neon.tech | PostgreSQL database |
| **Google AI Studio** | https://aistudio.google.com/apikey | Gemini API keys (free) |
| **Cloudflare Dashboard** | https://dash.cloudflare.com | Workers AI (image gen) |
| **Telegram BotFather** | https://t.me/BotFather | Create bot, get token |
| **Telegram Bot** | `@TeleforgeOfficial_Bot` | Your live bot (update after deploy) |

---

## 🔢 Step 1 — Telegram Bot (BotFather)

1. Open https://t.me/BotFather
2. Send `/newbot` and follow prompts
3. Save the **BOT_TOKEN** (looks like `862813...:AAHc...`)
4. Send `/setprivacy` → choose **Disable** (so bot can read all messages)
5. Send `/setcommands` and paste:
```
start - Start TeleForge AI and show menu
help - Show help message
chat - Chat with AI assistant
createimage - Generate an AI image from text
code - Get coding help from AI
translate - Translate text between languages
settings - Open settings panel
```

6. (Optional) Send `/setuserpic` and upload a bot profile picture

---

## 🗄️ Step 2 — Neon PostgreSQL Database

1. Go to https://console.neon.tech → Sign up/login
2. Click **Create Project**
   - Name: `teleforge-ai`
   - Region: Choose closest to you
   - PostgreSQL version: 16
3. Wait for creation (~10 seconds)
4. Copy the **connection string** from the "Connection Details" section
   - It looks like: `postgresql://neondb_owner:xxxxxxxx@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`
   - **Important:** Use the **Pooled connection string** (it has `-pooler` in the hostname)
5. Save this as **DATABASE_URL**

---

## 🤖 Step 3 — Google AI Studio (Gemini API)

1. Go to https://aistudio.google.com/apikey
2. Sign in with your Google account
3. Click **Create API Key**
4. Copy the key (starts with `AIza...`)
5. Save as **GOOGLE_API_KEY_1**
6. (Optional) Create a second key for failover as **GOOGLE_API_KEY_2**

**⚠️ Google free tier limits:** 20 requests/day per model per key.
The bot uses automatic failover: Key 1 → Key 2 → Model fallback (Flash → Flash Lite → Pro).

---

## ☁️ Step 4 — Cloudflare Workers AI (Image Generation)

### 4.1 Create the Worker

1. Go to https://dash.cloudflare.com → **Workers & Pages**
2. Click **Create Worker**
3. Name: `teleforge-image-gen`
4. Delete the default code and paste the entire contents of `cloudflare-worker.js` from this repo
5. Click **Deploy**

### 4.2 Add Secret Variable

1. In the Worker page → **Settings** → **Variables**
2. Under **Environment Variables**, click **Add variable**
3. Name: `AI_KEY`
4. Value: Choose a strong password (e.g., `tf-img-gen-secret-2024`)
5. Click **Encrypt** (so it's hidden)
6. Click **Save**

### 4.3 Enable Workers AI

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **AI**
2. Make sure the account has Workers AI enabled (free tier: 100,000 requests/day)
3. The worker code uses `@cf/stabilityai/stable-diffusion-xl-base-1.0`

### 4.4 Test the Worker

```bash
curl -X POST https://teleforge-image-gen.your-subdomain.workers.dev \
  -H "Authorization: Bearer YOUR_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A cat wearing a hat"}'
```

This should return an image (PNG binary).

### 4.5 Save URLs

- **CLOUDFLARE_AI_URL**: `https://teleforge-image-gen.your-subdomain.workers.dev`
- **CLOUDFLARE_AI_KEY**: The `AI_KEY` secret you set above

---

## 🚀 Step 5 — Deploy on Render

### 5.1 Fork/Clone the Repo on GitHub

1. Go to https://github.com/teleforgeofficiall/TELEFORGE-AI-BOT
2. Click **Fork** or clone locally
3. The repo is now ready

### 5.2 Create Web Service on Render

1. Go to https://dashboard.render.com
2. Click **New +** → **Web Service**
3. Connect your GitHub account
4. Select the `TELEFORGE-AI-BOT` repository
5. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `teleforge-ai` |
| **Region** | Choose closest (e.g., Singapore, Oregon) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm ci && npx prisma generate && npm run build` |
| **Start Command** | `npx prisma db push --accept-data-loss && node dist/server.js` |
| **Plan** | **Free** (512 MB RAM, sleeps after inactivity) |

### 5.3 Add Environment Variables

In the Render service dashboard → **Environment** → **Add Environment Variables**:

| Key | Value | Secret? |
|-----|-------|---------|
| `NODE_ENV` | `production` | No |
| `PORT` | `3000` | No |
| `BOT_TOKEN` | Your Telegram bot token | ✅ Yes |
| `OWNER_ID` | Your Telegram user ID | ✅ Yes |
| `DATABASE_URL` | Neon connection string | ✅ Yes |
| `GOOGLE_API_KEY_1` | Google AI Studio key 1 | ✅ Yes |
| `GOOGLE_API_KEY_2` | Google AI Studio key 2 (optional) | ✅ Yes |
| `CLOUDFLARE_AI_URL` | Your Cloudflare Worker URL | ✅ Yes |
| `CLOUDFLARE_AI_KEY` | Your AI_KEY secret | ✅ Yes |
| `WEBHOOK_SECRET` | Any random string (e.g., `whsec_abc123`) | ✅ Yes |

### 5.4 Deploy

Click **Create Web Service**. Render will:
1. Pull the code from GitHub
2. Install dependencies (`npm ci`)
3. Generate Prisma client
4. Build TypeScript
5. Start the bot

Wait 2-3 minutes for first deploy. The bot will be available at:
`https://teleforge-ai.onrender.com`

### 5.5 Set Webhook (Production)

Once deployed, set the Telegram webhook by visiting:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://teleforge-ai.onrender.com/<YOUR_BOT_TOKEN>&secret_token=<YOUR_WEBHOOK_SECRET>
```

Replace:
- `<YOUR_BOT_TOKEN>` with your actual bot token
- `teleforge-ai` with your actual Render service name
- `<YOUR_WEBHOOK_SECRET>` with the WEBHOOK_SECRET you set

**Verify webhook:**
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

Response should show `"url": "https://teleforge-ai.onrender.com/..."` and `"pending_update_count": 0`.

---

## 💻 Step 6 — Local Development

### Prerequisites
- Node.js v20+
- A Neon database (or local PostgreSQL)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/teleforgeofficiall/TELEFORGE-AI-BOT.git
cd TELEFORGE-AI-BOT

# 2. Install dependencies
npm install

# 3. Copy .env.example to .env and fill in values
cp .env.example .env
# Edit .env with your actual keys

# 4. Run (auto: db push + prisma generate + ts-node)
.\start.bat
```

Or manually:

```bash
# 4. Generate Prisma client
npx prisma generate

# 5. Push schema to database
npx prisma db push

# 6. Start in dev mode (polling, not webhook)
npm run dev
```

The bot will start in **polling mode** (no webhook needed) when `NODE_ENV=development`.

---

## 🔧 Step 7 — Configuration

### Setting Bot Identity

After first run, use these commands in Telegram as the **Owner**:

```
/settings → Identity Settings
```

Or set via in-app admin panel.

### Adding Required Channels

1. Open bot → Admin Panel → Channels
2. Tap **➕ Add Channel**
3. Forward a message from the channel OR send `@channelusername`
4. The bot must be an admin in the channel

The protected channel `@TeleforgeOfficial` is hardcoded and cannot be removed.

---

## 📊 Step 8 — Monitoring

### Health Endpoint
```
GET https://teleforge-ai.onrender.com/health
```

Returns:
```json
{
  "status": "healthy",
  "ai": {
    "key1Valid": true,
    "key2Valid": false,
    "currentModel": "models/gemini-2.5-flash",
    "validatedModels": ["models/gemini-2.5-flash", "models/gemini-2.5-flash-lite"]
  },
  "uptime": 1234.56
}
```

### Logs (Render)
Render Dashboard → Your Service → **Logs** tab

### Database (Neon)
Neon Console → Your Project → **Tables** — view/query data directly

---

## ⚠️ Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 429 Too Many Requests | Google free tier quota exhausted (20/day) | Wait 24h or add more API keys |
| P2021: Table not found | DB schema not pushed | Bot auto-runs `prisma db push` on start |
| Webhook not responding | Secret token mismatch | Check WEBHOOK_SECRET matches in both .env and setWebhook call |
| Image generation fails | Cloudflare Worker URL wrong | Verify CLOUDFLARE_AI_URL and CLOUDFLARE_AI_KEY match |
| Bot not responding (prod) | Service sleep (free Render) | Render free tier sleeps after 15min inactivity. First request wakes it (~30s delay) |

---

## 🔐 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | ✅ Yes | — | Telegram Bot API token from BotFather |
| `OWNER_ID` | ✅ Yes | — | Your Telegram numeric user ID |
| `DATABASE_URL` | ✅ Yes | — | Neon PostgreSQL connection string (pooled) |
| `GOOGLE_API_KEY_1` | ✅ Yes | — | Google AI Studio API key (primary) |
| `GOOGLE_API_KEY_2` | ❌ No | `''` | Google AI Studio API key (failover) |
| `CLOUDFLARE_AI_URL` | ❌ No | `''` | Cloudflare Worker URL for image gen |
| `CLOUDFLARE_AI_KEY` | ❌ No | `''` | Cloudflare Worker auth key |
| `WEBHOOK_SECRET` | ❌ No | `''` | Telegram webhook secret token |
| `PORT` | ❌ No | `3000` | Server port |
| `NODE_ENV` | ❌ No | `development` | `development` = polling, `production` = webhook |

---

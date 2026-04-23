# 🎬 CineBot — WhatsApp Movie Recommendation Bot

A fully personalised WhatsApp movie recommendation bot powered by **Claude AI**, **Twilio**, **Supabase**, and **Node.js**.

Users chat with the bot over WhatsApp to get tailored movie suggestions, manage a watchlist, log movies they've seen, and set reminders — all from a simple chat interface.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Project Structure](#project-structure)
5. [Step 1 — Supabase Setup](#step-1--supabase-setup)
6. [Step 2 — Twilio Setup](#step-2--twilio-setup)
7. [Step 3 — Anthropic Setup](#step-3--anthropic-setup)
8. [Step 4 — Local Installation](#step-4--local-installation)
9. [Step 5 — Environment Variables](#step-5--environment-variables)
10. [Step 6 — Run Locally](#step-6--run-locally)
11. [Step 7 — Expose with ngrok](#step-7--expose-with-ngrok)
12. [Step 8 — Connect Twilio Webhook](#step-8--connect-twilio-webhook)
13. [Step 9 — Test the Bot](#step-9--test-the-bot)
14. [Deploying to Production](#deploying-to-production)
15. [What Users Can Say](#what-users-can-say)
16. [Troubleshooting](#troubleshooting)

---

## Features

- 🤖 **AI-powered recommendations** — Claude learns each user's taste from their watch history, rejected movies, preferred genres, and age
- 🧠 **Personalised system prompt** — every user gets a unique AI context built from their full profile
- 📋 **Wishlist management** — add and view movies to watch later
- 🎬 **Watch history tracking** — log watched movies with optional ratings
- 🚫 **Rejection memory** — Claude never re-suggests movies the user said no to
- ⏰ **Scheduled reminders** — set WhatsApp reminders for any movie at any time
- 👋 **Guided onboarding** — collects name, age, and favourite genres on first contact
- 💬 **Conversation memory** — remembers context within a session

---

## Architecture

```
WhatsApp User
     │
     ▼
Twilio WhatsApp API
     │  POST /webhook
     ▼
Express Server (server.js)
     │
     ├──► Supabase (database.js)   — user profiles, history, wishlist, reminders
     │
     └──► Anthropic Claude (claude.js) — AI recommendations
     
Node-cron (scheduler.js)
     │
     ├──► Supabase — fetch due reminders
     └──► Twilio — send WhatsApp reminders
```

---

## Prerequisites

Make sure you have the following before starting:

- **Node.js** v18 or higher — https://nodejs.org
- **npm** v9 or higher (comes with Node.js)
- **A Twilio account** (free trial works) — https://twilio.com
- **A Supabase account** (free tier works) — https://supabase.com
- **An Anthropic API key** — https://console.anthropic.com
- **ngrok** (for local development) — https://ngrok.com

---

## Project Structure

```
whatsapp-movie-bot/
├── server.js        # Express webhook server (main entry point)
├── scheduler.js     # Cron job for sending reminders
├── claude.js        # Claude AI logic + system prompt builder
├── database.js      # All Supabase queries
├── schema.sql       # Database schema (run once in Supabase)
├── .env             # Your real secrets (never commit this)
├── .env.example     # Template showing required variables
├── package.json     # Dependencies
└── README.md        # This file
```

---

## Step 1 — Supabase Setup

1. Go to https://supabase.com and create a free account
2. Click **New Project** and fill in a name and password
3. Wait for the project to finish provisioning (~1 minute)
4. In the left sidebar, click **SQL Editor**
5. Click **New Query**
6. Open `schema.sql` from this project, copy the entire contents, paste into the editor, and click **Run**
7. You should see: *"Success. No rows returned"* — all tables are now created
8. In the left sidebar, click **Settings → API**
9. Copy your:
   - **Project URL** (e.g. `https://xyzabc.supabase.co`)
   - **anon / public key** (safe for server-side use)

---

## Step 2 — Twilio Setup

### 2a — Create an account and get credentials

1. Go to https://twilio.com and sign up for a free account
2. From the **Console Dashboard**, copy your:
   - **Account SID** (starts with `AC`)
   - **Auth Token**

### 2b — Enable the WhatsApp Sandbox

1. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message**
2. Follow the instructions to join the sandbox:
   - Send the join code (e.g. `join <word>-<word>`) to **+1 415 523 8886** on WhatsApp
3. Your sandbox number is: `whatsapp:+14155238886`

> **Note:** The sandbox is for development only. For production, you need to apply for a Twilio WhatsApp-approved number, which requires Meta Business verification.

---

## Step 3 — Anthropic Setup

1. Go to https://console.anthropic.com
2. Sign in or create an account
3. Click **API Keys → Create Key**
4. Copy the key — it starts with `sk-ant-`

> Keep this key secret. It is billed per token used.

---

## Step 4 — Local Installation

Clone or download the project, then install all dependencies:

```bash
# Navigate into the project folder
cd whatsapp-movie-bot

# Install all dependencies
npm install
```

This installs:
- `express` — web server
- `twilio` — WhatsApp messaging
- `@supabase/supabase-js` — database client
- `@anthropic-ai/sdk` — Claude AI client
- `node-cron` — reminder scheduler
- `dotenv` — environment variable loader

---

## Step 5 — Environment Variables

```bash
# Copy the template
cp .env.example .env

# Open and fill in your values
nano .env   # or use any text editor
```

Fill in every value:

```env
PORT=3000

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your_anon_key

ANTHROPIC_API_KEY=sk-ant-your_key
CLAUDE_MODEL=claude-sonnet-4-20250514
CLAUDE_MAX_TOKENS=1024

CRON_SCHEDULE=* * * * *
CRON_TIMEZONE=UTC

DEBUG=true
NODE_ENV=development
```

---

## Step 6 — Run Locally

You can run the server and scheduler together or separately.

### Run server + scheduler together (recommended)

Add a start script to your `package.json`:

```json
{
  "scripts": {
    "start": "node server.js",
    "scheduler": "node scheduler.js"
  }
}
```

Open **two terminal windows**:

**Terminal 1 — Start the server:**
```bash
node server.js
```

You should see:
```
[server] ✅ CineBot server running on port 3000
[server] Webhook URL: http://localhost:3000/webhook
[server] Health check: http://localhost:3000/health
```

**Terminal 2 — Start the scheduler:**
```bash
node scheduler.js
```

You should see:
```
[scheduler] ✅ Starting cron job
[scheduler]    Schedule : * * * * *
[scheduler]    Timezone : UTC
[scheduler] Running standalone. Press Ctrl+C to stop.
```

### Verify the server is running

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","timestamp":"..."}
```

---

## Step 7 — Expose with ngrok

Twilio needs a **public HTTPS URL** to send webhook events to your local server. ngrok creates a secure tunnel.

1. Download and install ngrok: https://ngrok.com/download
2. Sign up for a free account and connect your authtoken:
   ```bash
   ngrok config add-authtoken YOUR_NGROK_AUTH_TOKEN
   ```
3. Start the tunnel:
   ```bash
   ngrok http 3000
   ```
4. Copy the **Forwarding** URL — it looks like:
   ```
   https://a1b2-123-456-789.ngrok-free.app
   ```
5. Your webhook URL is:
   ```
   https://a1b2-123-456-789.ngrok-free.app/webhook
   ```

> **Important:** The ngrok URL changes every time you restart ngrok (on the free plan). You'll need to update the Twilio webhook URL each time.

---

## Step 8 — Connect Twilio Webhook

1. Go to https://console.twilio.com
2. Navigate to **Messaging → Settings → WhatsApp Sandbox Settings**
3. In the **"When a message comes in"** field, paste your webhook URL:
   ```
   https://a1b2-123-456-789.ngrok-free.app/webhook
   ```
4. Make sure the method is set to **HTTP POST**
5. Click **Save**

---

## Step 9 — Test the Bot

1. Open WhatsApp on your phone
2. Make sure you have already joined the Twilio sandbox (Step 2b)
3. Send a message to **+1 415 523 8886**
4. The bot will greet you and begin onboarding

### Expected onboarding flow:

```
You:    Hi
Bot:    👋 Hi there! Welcome to CineBot! What's your name?

You:    Alex
Bot:    Great to meet you, Alex! 🍿 How old are you?

You:    28
Bot:    Perfect! What are your favourite genres? (e.g. Action, Comedy, Thriller)

You:    Thriller, Sci-Fi, Drama
Bot:    You're all set, Alex! 🎉 What are you in the mood for? 🍿
```

### After onboarding:

```
You:    Recommend me a thriller
Bot:    [Claude gives a personalised recommendation]

You:    I watched Inception
Bot:    Got it! I've logged Inception to your watch history 🎬

You:    Add Oppenheimer to my wishlist
Bot:    I've added Oppenheimer to your wishlist ✅

You:    Not interested in Avatar
Bot:    No problem! I won't suggest Avatar again 🚫

You:    Show my wishlist
Bot:    [Lists wishlist]

You:    Remind me to watch Dune on Friday at 8pm
Bot:    Reminder set! I'll message you on Friday at 8pm ⏰
```

---

## Deploying to Production

### Option A — Railway (easiest)

1. Push your code to a GitHub repository
2. Go to https://railway.app and create a new project
3. Connect your GitHub repo
4. Add all environment variables in the Railway dashboard
5. Railway will auto-deploy and give you a public URL
6. Update your Twilio webhook URL to the Railway URL + `/webhook`
7. Run the scheduler as a separate Railway service using `node scheduler.js`

### Option B — Render

1. Push your code to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your repo, set build command to `npm install`, start command to `node server.js`
4. Add environment variables in the Render dashboard
5. Create a second Render service for the scheduler with start command `node scheduler.js`

### Option C — VPS (DigitalOcean, AWS EC2, etc.)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your repo
git clone https://github.com/yourname/whatsapp-movie-bot.git
cd whatsapp-movie-bot
npm install

# Set up environment variables
cp .env.example .env
nano .env   # fill in your values

# Run with PM2 (keeps processes alive)
npm install -g pm2
pm2 start server.js    --name cinebot-server
pm2 start scheduler.js --name cinebot-scheduler
pm2 save
pm2 startup
```

> For production, use your server's public IP or a domain with SSL (required by Twilio).

---

## What Users Can Say

| User says | What happens |
|---|---|
| `Hi` / any first message | Starts onboarding |
| `Recommend me a movie` | Claude suggests a personalised film |
| `Something funny for tonight` | Claude picks a comedy |
| `I watched Inception` | Logged to watch history |
| `I watched Inception, I'd rate it 9/10` | Logged with rating |
| `Add Dune to my wishlist` | Added to wishlist |
| `Show my wishlist` | Lists wishlist |
| `Not interested in Avatar` | Added to rejected list |
| `Remind me to watch Oppenheimer on Friday at 8pm` | Reminder created |
| `What have I watched?` | Lists watch history |
| `Help` | Shows the full feature menu |

---

## Troubleshooting

**Bot is not responding**
- Check that ngrok is running and the tunnel URL matches what's in Twilio
- Check the server terminal for errors
- Make sure you joined the WhatsApp sandbox (Step 2b)
- Run `curl http://localhost:3000/health` to verify the server is up

**"Missing environment variable" error on startup**
- Make sure `.env` exists (not just `.env.example`)
- Check all required keys are filled in with real values (no placeholder text)

**Supabase errors**
- Verify you ran `schema.sql` in the Supabase SQL Editor
- Double-check `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`

**Claude not replying / API errors**
- Verify `ANTHROPIC_API_KEY` is correct and has credits
- Check the `CLAUDE_MODEL` value matches a valid model name

**Reminders not sending**
- Make sure the scheduler is running (`node scheduler.js`)
- Check that `send_at` times in the DB are in UTC
- Set `DEBUG=true` in `.env` to see verbose scheduler logs

**ngrok URL keeps changing**
- Upgrade to ngrok paid plan for a static domain
- Or redeploy to Railway/Render for a permanent URL

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.18.0 | Web server & webhook handler |
| `twilio` | ^5.0.0 | WhatsApp messaging via Twilio API |
| `@supabase/supabase-js` | ^2.0.0 | Supabase database client |
| `@anthropic-ai/sdk` | ^0.20.0 | Claude AI API client |
| `node-cron` | ^3.0.0 | Cron job scheduler |
| `dotenv` | ^16.0.0 | Load `.env` variables |

Install all at once:
```bash
npm install express twilio @supabase/supabase-js @anthropic-ai/sdk node-cron dotenv
```

---

*Built with ❤️ using Claude AI, Twilio, and Supabase.*

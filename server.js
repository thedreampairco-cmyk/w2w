// ============================================================
// server.js — Express webhook server (Green API version)
// ============================================================

'use strict';

require('dotenv').config();

const express  = require('express');
const axios    = require('axios');
const db       = require('./database');
const { getAIReply, ONBOARDING } = require('./claude');
const scheduler = require('./scheduler');

// ─────────────────────────────────────────
// Validate required env vars
// ─────────────────────────────────────────
const REQUIRED_ENV = [
    'GREEN_API_ID',
    'GREEN_API_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'ANTHROPIC_API_KEY',
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`[server] Missing required environment variable: ${key}`);
    }
}

const GREEN_API_ID    = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;
const GREEN_API_BASE  = `https://api.green-api.com/waInstance${GREEN_API_ID}`;
const PORT            = parseInt(process.env.PORT || '3000', 10);
const DEBUG           = process.env.DEBUG === 'true';

function log(...args) {
    if (DEBUG) console.log('[server]', ...args);
}

// ─────────────────────────────────────────
// In-memory conversation history
// ─────────────────────────────────────────
const conversationStore = new Map();

function getHistory(phoneNumber) {
    return conversationStore.get(phoneNumber) || [];
}

function appendHistory(phoneNumber, role, content) {
    const history = getHistory(phoneNumber);
    history.push({ role, content });
    if (history.length > 20) history.splice(0, history.length - 20);
    conversationStore.set(phoneNumber, history);
}

// ============================================================
// GREEN API — SEND MESSAGE
// ============================================================

/**
 * Send a WhatsApp message via Green API.
 *
 * @param {string} phoneNumber  e.g. "1234567890" or "1234567890@c.us"
 * @param {string} message      Text to send
 */
async function sendWhatsAppMessage(phoneNumber, message) {
    // Green API expects format: "1234567890@c.us"
    const chatId = phoneNumber.includes('@c.us')
        ? phoneNumber
        : `${phoneNumber}@c.us`;

    log(`Sending message to ${chatId}`);

    await axios.post(
        `${GREEN_API_BASE}/sendMessage/${GREEN_API_TOKEN}`,
        { chatId, message },
        { headers: { 'Content-Type': 'application/json' } }
    );
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Extract clean phone number from Green API sender format.
 * Green API sends senderData.sender as "1234567890@c.us"
 * We store it as-is and strip @c.us only when needed.
 *
 * @param {string} sender  e.g. "1234567890@c.us"
 * @returns {string}       e.g. "1234567890"
 */
function extractPhoneNumber(sender) {
    return sender.replace('@c.us', '').replace('@g.us', '');
}

/**
 * Parse comma-separated genre string into clean array.
 */
function parseGenres(input) {
    return input
        .split(',')
        .map(g => g.trim())
        .filter(g => g.length > 0)
        .map(g => g.charAt(0).toUpperCase() + g.slice(1).toLowerCase());
}

// ============================================================
// ONBOARDING FLOW
// ============================================================

async function handleOnboarding(user, message) {
    const { id: userId, onboarding_status } = user;

    switch (onboarding_status) {

        case 'new': {
            await db.setOnboardingStatus(userId, 'awaiting_name');
            return ONBOARDING.ASK_NAME;
        }

        case 'awaiting_name': {
            const name = message.trim();
            if (!name || name.length < 1) {
                return "I didn't catch that — what's your name? 😊";
            }
            await db.updateUser(userId, { name, onboarding_status: 'awaiting_age' });
            return ONBOARDING.ASK_AGE(name);
        }

        case 'awaiting_age': {
            const age = parseInt(message.trim(), 10);
            if (isNaN(age) || age < 1 || age > 120) {
                return "Hmm, that doesn't look like a valid age. Please enter a number (e.g. 25) 🔢";
            }
            const updatedUser = await db.updateUser(userId, { age, onboarding_status: 'awaiting_genres' });
            return ONBOARDING.ASK_GENRES(updatedUser.name);
        }

        case 'awaiting_genres': {
            const genres = parseGenres(message);
            if (genres.length === 0) {
                return "Please enter at least one genre (e.g. Action, Comedy, Thriller) 🎬";
            }
            const updatedUser = await db.updateUser(userId, {
                preferred_genres: genres,
                onboarding_status: 'complete',
            });
            return ONBOARDING.ONBOARDING_COMPLETE(updatedUser.name);
        }

        default: {
            await db.setOnboardingStatus(userId, 'new');
            return ONBOARDING.ASK_NAME;
        }
    }
}

// ============================================================
// INTENT HANDLER
// ============================================================

async function handleIntent(user, intent) {
    const { id: userId } = user;

    try {
        switch (intent.intent) {
            case 'WATCHED':
                if (intent.movieTitle) {
                    await db.addToWatchHistory(userId, intent.movieTitle);
                    log(`Logged watched: "${intent.movieTitle}"`);
                }
                break;

            case 'ADD_WISHLIST':
                if (intent.movieTitle) {
                    await db.addToWishlist(userId, intent.movieTitle);
                    log(`Added to wishlist: "${intent.movieTitle}"`);
                }
                break;

            case 'REJECT':
                if (intent.movieTitle) {
                    await db.addRejectedMovie(userId, intent.movieTitle);
                    log(`Rejected: "${intent.movieTitle}"`);
                }
                break;

            default:
                break;
        }
    } catch (err) {
        console.error('[server] handleIntent error:', err.message);
    }
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────
// Health check
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
// Green API Webhook — POST /webhook
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    // Always respond 200 immediately so Green API doesn't retry
    res.sendStatus(200);

    const body = req.body;
    log('Incoming webhook:', JSON.stringify(body));

    // Green API sends different typeWebhook values.
    // We only care about incoming text messages.
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    // Only handle text messages (ignore images, audio, etc.)
    const messageData = body.messageData;
    if (!messageData || messageData.typeMessage !== 'TextMessage') return;

    const incomingMessage = messageData.textMessageData?.textMessage?.trim();
    const sender          = body.senderData?.sender; // e.g. "1234567890@c.us"
    const chatId          = body.senderData?.chatId; // same as sender for private chats

    if (!incomingMessage || !sender) {
        log('Missing message or sender — ignoring');
        return;
    }

    // Ignore group messages (chatId ends in @g.us)
    if (chatId && chatId.endsWith('@g.us')) {
        log('Group message — ignoring');
        return;
    }

    const phoneNumber = extractPhoneNumber(sender);
    log(`Message from ${phoneNumber}: "${incomingMessage}"`);

    try {
        // ── Step 1: Get or create user ─────────────────────
        const { user } = await db.getOrCreateUser(phoneNumber);
        log(`User: ${user.id} | onboarding: ${user.onboarding_status}`);

        // ── Step 2: Onboarding flow ────────────────────────
        if (user.onboarding_status !== 'complete') {
            const reply = await handleOnboarding(user, incomingMessage);
            appendHistory(phoneNumber, 'user', incomingMessage);
            appendHistory(phoneNumber, 'assistant', reply);
            await sendWhatsAppMessage(sender, reply);
            return;
        }

        // ── Step 3: Load full profile for Claude ──────────
        const profile = await db.getFullProfile(user.id);

        // ── Step 4: Get conversation history ──────────────
        const history = getHistory(phoneNumber);

        // ── Step 5: Call Claude ────────────────────────────
        const { reply, intent } = await getAIReply(profile, history, incomingMessage);
        log(`Intent: ${intent.intent} | Reply length: ${reply.length}`);

        // ── Step 6: DB side-effects ────────────────────────
        await handleIntent(user, intent);

        // ── Step 7: Update conversation history ───────────
        appendHistory(phoneNumber, 'user', incomingMessage);
        appendHistory(phoneNumber, 'assistant', reply);

        // ── Step 8: Send reply ─────────────────────────────
        await sendWhatsAppMessage(sender, reply);

    } catch (err) {
        console.error('[server] Webhook error:', err);
        try {
            await sendWhatsAppMessage(
                sender,
                "Sorry, something went wrong on my end 😅 Please try again in a moment!"
            );
        } catch (sendErr) {
            console.error('[server] Failed to send error message:', sendErr.message);
        }
    }
});

// ─────────────────────────────────────────
// 404 + error handlers
// ─────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
    console.log(`[server] ✅ CineBot running on port ${PORT}`);
    console.log(`[server] Webhook: http://localhost:${PORT}/webhook`);
    console.log(`[server] Health:  http://localhost:${PORT}/health`);
});

// Start scheduler in same process (no separate worker needed)
scheduler.start();

// ============================================================
// EXPORTS
// ============================================================
module.exports = { sendWhatsAppMessage };


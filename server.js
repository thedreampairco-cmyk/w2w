// ============================================================
// server.js — Express webhook server
// ============================================================
// Responsibilities:
//   1. Receive incoming WhatsApp messages from Twilio
//   2. Run the onboarding flow for new users
//   3. Detect intent and trigger the right DB operations
//   4. Call Claude for AI replies
//   5. Send the reply back via Twilio
//
// Start the server:
//   node server.js
// ============================================================

'use strict';

require('dotenv').config();

const express    = require('express');
const twilio     = require('twilio');
const db         = require('./database');
const { getAIReply, ONBOARDING } = require('./claude');

// ─────────────────────────────────────────
// Validate required env vars at startup
// ─────────────────────────────────────────
const REQUIRED_ENV = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'ANTHROPIC_API_KEY',
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`[server] Missing required environment variable: ${key}`);
    }
}

// ─────────────────────────────────────────
// Twilio client + MessagingResponse helper
// ─────────────────────────────────────────
const twilioClient     = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;
const FROM_NUMBER       = process.env.TWILIO_WHATSAPP_NUMBER;

const PORT  = parseInt(process.env.PORT || '3000', 10);
const DEBUG = process.env.DEBUG === 'true';

function log(...args) {
    if (DEBUG) console.log('[server]', ...args);
}

// ─────────────────────────────────────────
// In-memory conversation history store
// ─────────────────────────────────────────
// Maps phoneNumber → [{ role, content }, ...]
// Kept in memory (not DB) for speed. Resets on server restart.
// We trim to the last 20 messages per user to stay lean.
const conversationStore = new Map();

function getHistory(phoneNumber) {
    return conversationStore.get(phoneNumber) || [];
}

function appendHistory(phoneNumber, role, content) {
    const history = getHistory(phoneNumber);
    history.push({ role, content });
    // Keep only last 20 messages (10 exchanges)
    if (history.length > 20) history.splice(0, history.length - 20);
    conversationStore.set(phoneNumber, history);
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Send a WhatsApp message via Twilio REST API.
 * Used by the scheduler and anywhere outside the webhook response cycle.
 *
 * @param {string} to       e.g. "whatsapp:+1234567890"
 * @param {string} body     Message text
 */
async function sendWhatsAppMessage(to, body) {
    log(`Sending message to ${to}`);
    await twilioClient.messages.create({ from: FROM_NUMBER, to, body });
}

/**
 * Reply inline using TwiML (faster — no extra API call).
 * Used inside the webhook handler.
 *
 * @param {object} res      Express response object
 * @param {string} message  Text to send
 */
function twimlReply(res, message) {
    const twiml = new MessagingResponse();
    twiml.message(message);
    res.type('text/xml').send(twiml.toString());
}

/**
 * Parse a comma-separated genre string into a clean array.
 * e.g. "action, comedy , Thriller" → ["Action", "Comedy", "Thriller"]
 *
 * @param {string} input
 * @returns {string[]}
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

/**
 * Handle messages from users who haven't completed onboarding yet.
 * Returns the reply string and updates the DB state machine.
 *
 * States:
 *   new              → send welcome, set awaiting_name
 *   awaiting_name    → save name, set awaiting_age
 *   awaiting_age     → save age, set awaiting_genres
 *   awaiting_genres  → save genres, set complete
 *
 * @param {object} user     User row from DB
 * @param {string} message  Incoming message text
 * @returns {Promise<string>} Reply to send back
 */
async function handleOnboarding(user, message) {
    const { id: userId, onboarding_status } = user;

    switch (onboarding_status) {

        case 'new': {
            // First contact — greet and ask for name
            await db.setOnboardingStatus(userId, 'awaiting_name');
            return ONBOARDING.ASK_NAME;
        }

        case 'awaiting_name': {
            const name = message.trim();

            if (!name || name.length < 1) {
                return "I didn't catch that — what's your name? 😊";
            }

            await db.updateUser(userId, {
                name,
                onboarding_status: 'awaiting_age',
            });

            return ONBOARDING.ASK_AGE(name);
        }

        case 'awaiting_age': {
            const age = parseInt(message.trim(), 10);

            if (isNaN(age) || age < 1 || age > 120) {
                return "Hmm, that doesn't look like a valid age. Please enter a number (e.g. 25) 🔢";
            }

            // Fetch updated user to get the name we saved earlier
            const updatedUser = await db.updateUser(userId, {
                age,
                onboarding_status: 'awaiting_genres',
            });

            return ONBOARDING.ASK_GENRES(updatedUser.name);
        }

        case 'awaiting_genres': {
            const genres = parseGenres(message);

            if (genres.length === 0) {
                return "Please enter at least one genre (e.g. Action, Comedy, Thriller) 🎬";
            }

            // Fetch updated user to get the name
            const updatedUser = await db.updateUser(userId, {
                preferred_genres: genres,
                onboarding_status: 'complete',
            });

            return ONBOARDING.ONBOARDING_COMPLETE(updatedUser.name);
        }

        default: {
            // Should never reach here, but safe fallback
            await db.setOnboardingStatus(userId, 'new');
            return ONBOARDING.ASK_NAME;
        }
    }
}

// ============================================================
// INTENT HANDLERS
// ============================================================

/**
 * After Claude replies, check the detected intent and
 * run the appropriate DB side-effect.
 *
 * @param {object} user
 * @param {object} intent  From detectIntent()
 * @param {string} message Original user message
 */
async function handleIntent(user, intent, message) {
    const { id: userId } = user;

    try {
        switch (intent.intent) {

            case 'WATCHED': {
                if (intent.movieTitle) {
                    await db.addToWatchHistory(userId, intent.movieTitle);
                    log(`Logged watched movie: "${intent.movieTitle}" for user ${userId}`);
                }
                break;
            }

            case 'ADD_WISHLIST': {
                if (intent.movieTitle) {
                    await db.addToWishlist(userId, intent.movieTitle);
                    log(`Added to wishlist: "${intent.movieTitle}" for user ${userId}`);
                }
                break;
            }

            case 'REJECT': {
                if (intent.movieTitle) {
                    await db.addRejectedMovie(userId, intent.movieTitle);
                    log(`Rejected movie: "${intent.movieTitle}" for user ${userId}`);
                }
                break;
            }

            case 'SET_REMINDER': {
                // Claude handles the natural language parsing in its reply.
                // For structured reminder creation, we rely on a follow-up
                // message from the user confirming the time — Claude will
                // include "Reminder set!" in its reply when ready.
                // The user can also say: "Remind me tomorrow at 8pm to watch Inception"
                // and Claude will confirm. A more advanced implementation could
                // parse the datetime here and call db.createReminder() directly.
                log('SET_REMINDER intent detected — Claude handles NL parsing');
                break;
            }

            // SHOW_WISHLIST, SHOW_HISTORY, HELP, CHAT — Claude handles these
            // entirely in its reply. No DB side-effects needed.
            default:
                break;
        }
    } catch (err) {
        // Log but don't crash — the user still got Claude's reply
        console.error('[server] handleIntent error:', err.message);
    }
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

// Parse URL-encoded bodies (Twilio sends application/x-www-form-urlencoded)
app.use(express.urlencoded({ extended: false }));

// Parse JSON bodies (useful for testing with curl/Postman)
app.use(express.json());

// ─────────────────────────────────────────
// Health check endpoint
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
// Main Twilio webhook endpoint
// POST /webhook
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    const incomingMessage = (req.body.Body     || '').trim();
    const fromNumber      =  req.body.From     || '';   // e.g. "whatsapp:+1234567890"
    const toNumber        =  req.body.To       || '';   // Our Twilio number

    log(`Incoming message from ${fromNumber}: "${incomingMessage}"`);

    // ── Guard: ignore empty messages ──────
    if (!incomingMessage || !fromNumber) {
        log('Empty message or missing sender — ignoring');
        return res.sendStatus(200);
    }

    try {
        // ── Step 1: Get or create user ─────────────────────
        const { user } = await db.getOrCreateUser(fromNumber);
        log(`User: ${user.id} | onboarding: ${user.onboarding_status}`);

        // ── Step 2: Onboarding flow ────────────────────────
        if (user.onboarding_status !== 'complete') {
            const reply = await handleOnboarding(user, incomingMessage);
            appendHistory(fromNumber, 'user',      incomingMessage);
            appendHistory(fromNumber, 'assistant', reply);
            return twimlReply(res, reply);
        }

        // ── Step 3: Load full profile for Claude ──────────
        const profile = await db.getFullProfile(user.id);
        log('Full profile loaded');

        // ── Step 4: Get conversation history ──────────────
        const history = getHistory(fromNumber);

        // ── Step 5: Call Claude ────────────────────────────
        const { reply, intent } = await getAIReply(profile, history, incomingMessage);
        log(`Claude intent: ${intent.intent} | Reply length: ${reply.length}`);

        // ── Step 6: Run DB side-effects based on intent ───
        await handleIntent(user, intent, incomingMessage);

        // ── Step 7: Update conversation history ───────────
        appendHistory(fromNumber, 'user',      incomingMessage);
        appendHistory(fromNumber, 'assistant', reply);

        // ── Step 8: Reply to user ──────────────────────────
        return twimlReply(res, reply);

    } catch (err) {
        console.error('[server] Webhook error:', err);

        // Always respond to Twilio — never leave a webhook hanging
        return twimlReply(
            res,
            "Sorry, something went wrong on my end 😅 Please try again in a moment!"
        );
    }
});

// ─────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ─────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`[server] ✅ CineBot server running on port ${PORT}`);
    console.log(`[server] Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`[server] Health check: http://localhost:${PORT}/health`);
});

// ============================================================
// EXPORTS (for scheduler.js to reuse sendWhatsAppMessage)
// ============================================================
module.exports = { sendWhatsAppMessage };

// ============================================================
// claude.js — AI brain for the WhatsApp Movie Recommendation Bot
// ============================================================
// Responsibilities:
//   1. Build a personalised system prompt from the user's profile
//   2. Send the user's message + conversation history to Claude
//   3. Return Claude's plain-text reply
//
// Usage:
//   const { getAIReply } = require('./claude');
//   const reply = await getAIReply(userProfile, conversationHistory, incomingMessage);
// ============================================================

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ─────────────────────────────────────────
// Validate required env vars at startup
// ─────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[claude] Missing ANTHROPIC_API_KEY in environment.');
}

const client = new Anthropic.default({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL        = process.env.CLAUDE_MODEL      || 'claude-sonnet-4-20250514';
const MAX_TOKENS   = parseInt(process.env.CLAUDE_MAX_TOKENS || '1024', 10);
const DEBUG        = process.env.DEBUG === 'true';

function log(...args) {
    if (DEBUG) console.log('[claude]', ...args);
}

// ============================================================
// SECTION 1 — SYSTEM PROMPT BUILDER
// ============================================================

/**
 * Build a rich, personalised system prompt by injecting
 * everything we know about the user.
 *
 * @param {object} profile  Result of db.getFullProfile()
 *   {
 *     user:           { name, age, preferred_genres, preferred_languages, preferred_platforms, ... },
 *     watchHistory:   [{ movie_title, user_rating, genres }],
 *     rejectedMovies: [{ movie_title, reason }],
 *     wishlist:       [{ movie_title, notes }],
 *   }
 * @returns {string} The complete system prompt
 */
function buildSystemPrompt(profile) {
    const { user, watchHistory, rejectedMovies, wishlist } = profile;

    // ── User identity ──────────────────────────────────────
    const userName     = user.name             || 'the user';
    const userAge      = user.age              ? `${user.age} years old` : 'unknown age';
    const genres       = user.preferred_genres?.length
                            ? user.preferred_genres.join(', ')
                            : 'not specified';
    const languages    = user.preferred_languages?.length
                            ? user.preferred_languages.join(', ')
                            : 'English';
    const platforms    = user.preferred_platforms?.length
                            ? user.preferred_platforms.join(', ')
                            : 'not specified';

    // ── Watch history ──────────────────────────────────────
    const watchedLines = watchHistory.length
        ? watchHistory.map(w => {
            const rating = w.user_rating ? ` (rated ${w.user_rating}/10)` : '';
            const g      = w.genres?.length ? ` [${w.genres.join(', ')}]` : '';
            return `  • ${w.movie_title}${rating}${g}`;
          }).join('\n')
        : '  • None yet';

    // ── Rejected movies ────────────────────────────────────
    const rejectedLines = rejectedMovies.length
        ? rejectedMovies.map(r => {
            const reason = r.reason ? ` (reason: ${r.reason})` : '';
            return `  • ${r.movie_title}${reason}`;
          }).join('\n')
        : '  • None';

    // ── Wishlist ───────────────────────────────────────────
    const wishlistLines = wishlist.length
        ? wishlist.map(w => {
            const notes = w.notes ? ` — "${w.notes}"` : '';
            return `  • ${w.movie_title}${notes}`;
          }).join('\n')
        : '  • Empty';

    // ── Assemble ───────────────────────────────────────────
    return `You are CineBot, a friendly and knowledgeable WhatsApp movie recommendation assistant.
You are chatting with ${userName}, who is ${userAge}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER PROFILE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name:                ${userName}
Age:                 ${userAge}
Preferred genres:    ${genres}
Preferred languages: ${languages}
Preferred platforms: ${platforms}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MOVIES ALREADY WATCHED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${watchedLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MOVIES THE USER DOES NOT WANT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rejectedLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WISHLIST (wants to watch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${wishlistLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER recommend a movie that appears in "MOVIES ALREADY WATCHED" or "MOVIES THE USER DOES NOT WANT".
2. Always tailor recommendations to the user's preferred genres, languages, and platforms.
3. When recommending a movie, always include:
   - Title + year
   - Genre(s)
   - A 1–2 sentence synopsis (no spoilers)
   - Why you think THIS user will enjoy it (reference their taste)
   - Which platform it's available on (if you know)
4. Keep responses concise and WhatsApp-friendly. Use short paragraphs and emojis sparingly.
5. If the user asks to add a movie to their wishlist, confirm it and say "I've added [title] to your wishlist ✅".
6. If the user says they've watched a movie, confirm and say "Got it! I've logged [title] to your watch history 🎬".
7. If the user says they're not interested in a movie, confirm and say "No problem! I won't suggest [title] again 🚫".
8. If the user asks to set a reminder, confirm the time and say "Reminder set! I'll message you on [date/time] ⏰".
9. If the user asks to see their wishlist, list it clearly.
10. If the user asks for help or doesn't know what to say, show them a friendly menu of things they can do.
11. Be warm, enthusiastic about movies, and conversational — not robotic.
12. If the user's message is unrelated to movies or the bot's features, gently redirect them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THINGS THE USER CAN DO (help menu)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Ask for a movie recommendation (by mood, genre, actor, etc.)
• Say "I watched [movie]" to log it
• Say "Add [movie] to my wishlist"
• Say "Not interested in [movie]"
• Say "Show my wishlist"
• Say "Remind me to watch [movie] on [date/time]"
• Say "What have I watched?"
• Say "Help" to see this menu`;
}

// ============================================================
// SECTION 2 — INTENT DETECTION
// ============================================================

/**
 * Lightweight keyword-based intent detection.
 * Returns a structured intent object so server.js can
 * trigger the right DB operations before/after calling Claude.
 *
 * @param {string} message  Raw user message
 * @returns {object} { intent, movieTitle, datetime, reason }
 */
function detectIntent(message) {
    const m = message.toLowerCase().trim();

    // Watched a movie
    if (/i (watched|saw|just watched|finished|have seen)\s+(.+)/i.test(message)) {
        const match = message.match(/i (?:watched|saw|just watched|finished|have seen)\s+(.+)/i);
        return { intent: 'WATCHED', movieTitle: match?.[1]?.trim() || null };
    }

    // Add to wishlist
    if (/add (.+) to (my )?wishlist/i.test(message)) {
        const match = message.match(/add (.+) to (?:my )?wishlist/i);
        return { intent: 'ADD_WISHLIST', movieTitle: match?.[1]?.trim() || null };
    }

    // Not interested / reject
    if (/(not interested in|don'?t want to watch|skip|reject)\s+(.+)/i.test(message)) {
        const match = message.match(/(?:not interested in|don'?t want to watch|skip|reject)\s+(.+)/i);
        return { intent: 'REJECT', movieTitle: match?.[1]?.trim() || null };
    }

    // Show wishlist
    if (/show (my )?wishlist|my wishlist|what'?s on my wishlist/i.test(m)) {
        return { intent: 'SHOW_WISHLIST' };
    }

    // Show watch history
    if (/what (have i|did i) watch|my watch history|show (my )?history/i.test(m)) {
        return { intent: 'SHOW_HISTORY' };
    }

    // Set a reminder
    if (/remind me|set (a )?reminder/i.test(m)) {
        // We pass this to Claude — it will parse the natural language date/time
        return { intent: 'SET_REMINDER' };
    }

    // Help
    if (/^help$|^menu$|^what can you do/i.test(m)) {
        return { intent: 'HELP' };
    }

    // Default: general recommendation / chat
    return { intent: 'CHAT' };
}

// ============================================================
// SECTION 3 — MAIN FUNCTION
// ============================================================

/**
 * Send a message to Claude and get a reply.
 *
 * @param {object}   profile             Full user profile from db.getFullProfile()
 * @param {object[]} conversationHistory Array of { role: 'user'|'assistant', content: string }
 *                                       Pass the last N messages for context (we trim to 10 pairs).
 * @param {string}   incomingMessage     The user's latest message
 * @returns {Promise<{ reply: string, intent: object }>}
 */
async function getAIReply(profile, conversationHistory, incomingMessage) {
    log('getAIReply called. Model:', MODEL);

    // Detect intent for server.js to act on
    const intent = detectIntent(incomingMessage);
    log('Detected intent:', intent);

    // Build the system prompt with full user profile injected
    const systemPrompt = buildSystemPrompt(profile);

    // Keep conversation history lean — last 10 exchanges (20 messages)
    const trimmedHistory = (conversationHistory || []).slice(-20);

    // Append the new user message
    const messages = [
        ...trimmedHistory,
        { role: 'user', content: incomingMessage },
    ];

    log(`Sending ${messages.length} messages to Claude`);

    try {
        const response = await client.messages.create({
            model:      MODEL,
            max_tokens: MAX_TOKENS,
            system:     systemPrompt,
            messages,
        });

        // Extract the text reply from the response
        const reply = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim();

        log('Claude reply received. Length:', reply.length);

        return { reply, intent };

    } catch (err) {
        console.error('[claude] API error:', err.message);

        // Return a graceful fallback so the bot never goes silent
        return {
            reply: "Sorry, I'm having a little trouble thinking right now 🤔 Please try again in a moment!",
            intent,
        };
    }
}

// ============================================================
// SECTION 4 — ONBOARDING MESSAGES
// ============================================================
// These are fixed bot messages used during the onboarding flow.
// Centralised here so they're easy to edit.

const ONBOARDING = {
    WELCOME: (name) =>
        `🎬 Welcome to *CineBot*, ${name ? name : 'movie lover'}!\n\nI'm your personal WhatsApp movie recommendation assistant. I'll learn your taste and suggest movies you'll actually enjoy.\n\nLet's get started! What's your name?`,

    ASK_NAME:
        `👋 Hi there! Welcome to *CineBot*!\n\nI'm your personal movie recommendation assistant.\n\nFirst things first — what's your name?`,

    ASK_AGE: (name) =>
        `Great to meet you, *${name}*! 🍿\n\nHow old are you? (This helps me recommend age-appropriate content)`,

    ASK_GENRES: (name) =>
        `Perfect! Now, *${name}*, what are your favourite movie genres?\n\nFor example:\n_Action, Comedy, Thriller, Romance, Horror, Sci-Fi, Drama, Animation, Documentary_\n\nYou can list as many as you like, separated by commas.`,

    ONBOARDING_COMPLETE: (name) =>
        `You're all set, *${name}*! 🎉\n\nI now know enough to start recommending great movies for you.\n\nTry asking me:\n• "Recommend me a movie"\n• "Something funny for tonight"\n• "Best thriller from the last 5 years"\n\nWhat are you in the mood for? 🍿`,
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    getAIReply,
    detectIntent,
    buildSystemPrompt,
    ONBOARDING,
};

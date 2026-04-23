// ============================================================
// database.js — All Supabase queries for the bot
// ============================================================
// Import this file anywhere you need DB access:
//   const db = require('./database');
// ============================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────
// Initialise Supabase client (singleton)
// ─────────────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('[database] Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.');
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const DEBUG = process.env.DEBUG === 'true';

function log(...args) {
    if (DEBUG) console.log('[database]', ...args);
}

// ============================================================
// SECTION 1 — USER
// ============================================================

/**
 * Fetch a user by their WhatsApp phone number.
 * Returns the user row, or null if not found.
 *
 * @param {string} phoneNumber  e.g. "whatsapp:+1234567890"
 * @returns {Promise<object|null>}
 */
async function getUserByPhone(phoneNumber) {
    log('getUserByPhone:', phoneNumber);

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

    if (error && error.code === 'PGRST116') {
        // PGRST116 = no rows found — this is expected for new users
        return null;
    }

    if (error) throw new Error(`getUserByPhone failed: ${error.message}`);

    return data;
}

/**
 * Create a brand-new user row with onboarding_status = 'new'.
 * Called the very first time we hear from a phone number.
 *
 * @param {string} phoneNumber
 * @returns {Promise<object>} The newly created user row
 */
async function createUser(phoneNumber) {
    log('createUser:', phoneNumber);

    const { data, error } = await supabase
        .from('users')
        .insert({ phone_number: phoneNumber, onboarding_status: 'new' })
        .select()
        .single();

    if (error) throw new Error(`createUser failed: ${error.message}`);

    return data;
}

/**
 * Convenience: return existing user or create a new one.
 * This is the main entry point called on every incoming message.
 *
 * @param {string} phoneNumber
 * @returns {Promise<{ user: object, isNew: boolean }>}
 */
async function getOrCreateUser(phoneNumber) {
    let user = await getUserByPhone(phoneNumber);
    let isNew = false;

    if (!user) {
        user = await createUser(phoneNumber);
        isNew = true;
        log('New user created:', phoneNumber);
    }

    return { user, isNew };
}

/**
 * Update any fields on the users table for a given user ID.
 * Pass only the fields you want to change.
 *
 * @param {string} userId   UUID
 * @param {object} fields   e.g. { name: 'Alice', age: 28 }
 * @returns {Promise<object>} Updated user row
 */
async function updateUser(userId, fields) {
    log('updateUser:', userId, fields);

    const { data, error } = await supabase
        .from('users')
        .update(fields)
        .eq('id', userId)
        .select()
        .single();

    if (error) throw new Error(`updateUser failed: ${error.message}`);

    return data;
}

/**
 * Shortcut to update just the onboarding_status field.
 *
 * @param {string} userId
 * @param {string} status  One of: 'new' | 'awaiting_name' | 'awaiting_age' | 'awaiting_genres' | 'complete'
 * @returns {Promise<object>}
 */
async function setOnboardingStatus(userId, status) {
    return updateUser(userId, { onboarding_status: status });
}

// ============================================================
// SECTION 2 — WATCH HISTORY
// ============================================================

/**
 * Get all movies a user has already watched.
 * Returns an array of watch_history rows.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getWatchHistory(userId) {
    log('getWatchHistory:', userId);

    const { data, error } = await supabase
        .from('watch_history')
        .select('*')
        .eq('user_id', userId)
        .order('watched_at', { ascending: false });

    if (error) throw new Error(`getWatchHistory failed: ${error.message}`);

    return data || [];
}

/**
 * Add a movie to the user's watch history.
 * Silently ignores duplicates (same user + same title).
 *
 * @param {string} userId
 * @param {string} movieTitle
 * @param {number|null} userRating  Optional 1–10 rating
 * @param {string[]} genres         Optional genre tags
 * @returns {Promise<object>} The inserted (or existing) row
 */
async function addToWatchHistory(userId, movieTitle, userRating = null, genres = []) {
    log('addToWatchHistory:', userId, movieTitle);

    const { data, error } = await supabase
        .from('watch_history')
        .upsert(
            {
                user_id: userId,
                movie_title: movieTitle,
                user_rating: userRating,
                genres,
            },
            { onConflict: 'user_id,movie_title' }
        )
        .select()
        .single();

    if (error) throw new Error(`addToWatchHistory failed: ${error.message}`);

    return data;
}

// ============================================================
// SECTION 3 — REJECTED MOVIES
// ============================================================

/**
 * Get all movies the user has rejected.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getRejectedMovies(userId) {
    log('getRejectedMovies:', userId);

    const { data, error } = await supabase
        .from('rejected_movies')
        .select('*')
        .eq('user_id', userId)
        .order('rejected_at', { ascending: false });

    if (error) throw new Error(`getRejectedMovies failed: ${error.message}`);

    return data || [];
}

/**
 * Mark a movie as rejected by this user.
 * Silently ignores duplicates.
 *
 * @param {string} userId
 * @param {string} movieTitle
 * @param {string|null} reason  Optional reason
 * @returns {Promise<object>}
 */
async function addRejectedMovie(userId, movieTitle, reason = null) {
    log('addRejectedMovie:', userId, movieTitle);

    const { data, error } = await supabase
        .from('rejected_movies')
        .upsert(
            { user_id: userId, movie_title: movieTitle, reason },
            { onConflict: 'user_id,movie_title' }
        )
        .select()
        .single();

    if (error) throw new Error(`addRejectedMovie failed: ${error.message}`);

    return data;
}

// ============================================================
// SECTION 4 — WISHLIST
// ============================================================

/**
 * Get the user's full wishlist.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getWishlist(userId) {
    log('getWishlist:', userId);

    const { data, error } = await supabase
        .from('wishlist')
        .select('*')
        .eq('user_id', userId)
        .order('added_at', { ascending: false });

    if (error) throw new Error(`getWishlist failed: ${error.message}`);

    return data || [];
}

/**
 * Add a movie to the user's wishlist.
 * Silently ignores duplicates.
 *
 * @param {string} userId
 * @param {string} movieTitle
 * @param {string|null} notes  Optional personal note
 * @returns {Promise<object>}
 */
async function addToWishlist(userId, movieTitle, notes = null) {
    log('addToWishlist:', userId, movieTitle);

    const { data, error } = await supabase
        .from('wishlist')
        .upsert(
            { user_id: userId, movie_title: movieTitle, notes },
            { onConflict: 'user_id,movie_title' }
        )
        .select()
        .single();

    if (error) throw new Error(`addToWishlist failed: ${error.message}`);

    return data;
}

/**
 * Remove a movie from the user's wishlist by title.
 *
 * @param {string} userId
 * @param {string} movieTitle
 * @returns {Promise<void>}
 */
async function removeFromWishlist(userId, movieTitle) {
    log('removeFromWishlist:', userId, movieTitle);

    const { error } = await supabase
        .from('wishlist')
        .delete()
        .eq('user_id', userId)
        .eq('movie_title', movieTitle);

    if (error) throw new Error(`removeFromWishlist failed: ${error.message}`);
}

// ============================================================
// SECTION 5 — REMINDERS
// ============================================================

/**
 * Create a new scheduled reminder for a user.
 *
 * @param {string} userId
 * @param {string} message   The WhatsApp message to send
 * @param {Date|string} sendAt  When to send it (UTC)
 * @returns {Promise<object>} The created reminder row
 */
async function createReminder(userId, message, sendAt) {
    log('createReminder:', userId, sendAt);

    const { data, error } = await supabase
        .from('reminders')
        .insert({
            user_id: userId,
            message,
            send_at: new Date(sendAt).toISOString(),
            status: 'pending',
        })
        .select()
        .single();

    if (error) throw new Error(`createReminder failed: ${error.message}`);

    return data;
}

/**
 * Fetch all pending reminders whose send_at time has passed.
 * This is called by the scheduler every minute.
 *
 * @returns {Promise<object[]>} Array of reminder rows joined with user phone numbers
 */
async function getDueReminders() {
    log('getDueReminders: checking for due reminders');

    const now = new Date().toISOString();

    const { data, error } = await supabase
        .from('reminders')
        .select(`
            id,
            message,
            send_at,
            users (
                phone_number
            )
        `)
        .eq('status', 'pending')
        .lte('send_at', now);

    if (error) throw new Error(`getDueReminders failed: ${error.message}`);

    return data || [];
}

/**
 * Mark a reminder as successfully sent.
 *
 * @param {string} reminderId  UUID
 * @returns {Promise<void>}
 */
async function markReminderSent(reminderId) {
    log('markReminderSent:', reminderId);

    const { error } = await supabase
        .from('reminders')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', reminderId);

    if (error) throw new Error(`markReminderSent failed: ${error.message}`);
}

/**
 * Mark a reminder as failed and store the error message.
 *
 * @param {string} reminderId
 * @param {string} errorMessage
 * @returns {Promise<void>}
 */
async function markReminderFailed(reminderId, errorMessage) {
    log('markReminderFailed:', reminderId, errorMessage);

    const { error } = await supabase
        .from('reminders')
        .update({ status: 'failed', error_message: errorMessage })
        .eq('id', reminderId);

    if (error) throw new Error(`markReminderFailed failed: ${error.message}`);
}

/**
 * Get all reminders for a specific user (any status).
 * Useful for letting a user view or cancel their reminders.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getUserReminders(userId) {
    log('getUserReminders:', userId);

    const { data, error } = await supabase
        .from('reminders')
        .select('*')
        .eq('user_id', userId)
        .order('send_at', { ascending: true });

    if (error) throw new Error(`getUserReminders failed: ${error.message}`);

    return data || [];
}

/**
 * Delete a specific reminder by ID (used when user cancels a reminder).
 *
 * @param {string} reminderId
 * @param {string} userId  Passed for safety — only deletes if it belongs to this user
 * @returns {Promise<void>}
 */
async function deleteReminder(reminderId, userId) {
    log('deleteReminder:', reminderId);

    const { error } = await supabase
        .from('reminders')
        .delete()
        .eq('id', reminderId)
        .eq('user_id', userId);

    if (error) throw new Error(`deleteReminder failed: ${error.message}`);
}

// ============================================================
// SECTION 6 — FULL PROFILE (used by claude.js)
// ============================================================

/**
 * Load the complete user profile in one shot:
 * user row + watch history + rejected movies + wishlist.
 *
 * This is what gets injected into Claude's system prompt.
 *
 * @param {string} userId
 * @returns {Promise<object>} { user, watchHistory, rejectedMovies, wishlist }
 */
async function getFullProfile(userId) {
    log('getFullProfile:', userId);

    const [user, watchHistory, rejectedMovies, wishlist] = await Promise.all([
        supabase.from('users').select('*').eq('id', userId).single().then(({ data, error }) => {
            if (error) throw new Error(`getFullProfile/user failed: ${error.message}`);
            return data;
        }),
        getWatchHistory(userId),
        getRejectedMovies(userId),
        getWishlist(userId),
    ]);

    return { user, watchHistory, rejectedMovies, wishlist };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // User
    getUserByPhone,
    createUser,
    getOrCreateUser,
    updateUser,
    setOnboardingStatus,

    // Watch history
    getWatchHistory,
    addToWatchHistory,

    // Rejected movies
    getRejectedMovies,
    addRejectedMovie,

    // Wishlist
    getWishlist,
    addToWishlist,
    removeFromWishlist,

    // Reminders
    createReminder,
    getDueReminders,
    markReminderSent,
    markReminderFailed,
    getUserReminders,
    deleteReminder,

    // Full profile (for Claude)
    getFullProfile,
};

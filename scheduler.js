// ============================================================
// scheduler.js — Cron job for scheduled WhatsApp reminders
// ============================================================
// Responsibilities:
//   1. Run on a configurable cron schedule (default: every minute)
//   2. Query the DB for all pending reminders whose send_at has passed
//   3. Send each reminder via Twilio WhatsApp
//   4. Mark each reminder as 'sent' or 'failed' in the DB
//
// Run standalone:
//   node scheduler.js
//
// Or import and start from another file:
//   const scheduler = require('./scheduler');
//   scheduler.start();
// ============================================================

'use strict';

require('dotenv').config();

const cron   = require('node-cron');
const twilio = require('twilio');
const db     = require('./database');

// ─────────────────────────────────────────
// Validate required env vars at startup
// ─────────────────────────────────────────
const REQUIRED_ENV = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`[scheduler] Missing required environment variable: ${key}`);
    }
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '* * * * *';   // every minute
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'UTC';
const FROM_NUMBER   = process.env.TWILIO_WHATSAPP_NUMBER;          // e.g. "whatsapp:+14155238886"
const DEBUG         = process.env.DEBUG === 'true';

// ─────────────────────────────────────────
// Twilio client
// ─────────────────────────────────────────
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

function log(...args) {
    if (DEBUG) console.log('[scheduler]', ...args);
}

// ─────────────────────────────────────────
// Lock: prevent overlapping runs
// ─────────────────────────────────────────
// If a cron tick takes longer than 1 minute (e.g. many reminders
// + slow Twilio responses), we don't want the next tick to start
// processing the same rows simultaneously.
let isRunning = false;

// ============================================================
// CORE: processReminders()
// ============================================================

/**
 * Main function that runs on every cron tick.
 * Fetches all due pending reminders and sends them.
 */
async function processReminders() {
    if (isRunning) {
        log('Previous run still in progress — skipping this tick');
        return;
    }

    isRunning = true;
    log(`Tick at ${new Date().toISOString()} — checking for due reminders`);

    let reminders = [];

    try {
        reminders = await db.getDueReminders();
    } catch (err) {
        console.error('[scheduler] Failed to fetch due reminders:', err.message);
        isRunning = false;
        return;
    }

    if (reminders.length === 0) {
        log('No due reminders found');
        isRunning = false;
        return;
    }

    console.log(`[scheduler] Found ${reminders.length} due reminder(s) — processing`);

    // Process all reminders concurrently for speed
    const results = await Promise.allSettled(
        reminders.map(reminder => sendReminder(reminder))
    );

    // Log summary
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;
    console.log(`[scheduler] Done — ✅ ${succeeded} sent, ❌ ${failed} failed`);

    isRunning = false;
}

// ============================================================
// SEND A SINGLE REMINDER
// ============================================================

/**
 * Send one reminder via Twilio and update its status in the DB.
 *
 * The reminder row from getDueReminders() looks like:
 * {
 *   id:      "uuid",
 *   message: "Hey! Don't forget to watch Inception tonight 🎬",
 *   send_at: "2025-01-01T20:00:00Z",
 *   users: {
 *     phone_number: "whatsapp:+1234567890"
 *   }
 * }
 *
 * @param {object} reminder
 */
async function sendReminder(reminder) {
    const { id, message, users } = reminder;
    const phoneNumber = users?.phone_number;

    if (!phoneNumber) {
        console.error(`[scheduler] Reminder ${id} has no associated phone number — skipping`);
        await db.markReminderFailed(id, 'No phone number associated with user');
        return;
    }

    log(`Sending reminder ${id} to ${phoneNumber}`);

    try {
        await twilioClient.messages.create({
            from: FROM_NUMBER,
            to:   phoneNumber,
            body: message,
        });

        await db.markReminderSent(id);
        console.log(`[scheduler] ✅ Reminder ${id} sent to ${phoneNumber}`);

    } catch (err) {
        const errorMessage = err.message || 'Unknown Twilio error';
        console.error(`[scheduler] ❌ Failed to send reminder ${id}: ${errorMessage}`);

        try {
            await db.markReminderFailed(id, errorMessage);
        } catch (dbErr) {
            console.error(`[scheduler] Also failed to mark reminder ${id} as failed:`, dbErr.message);
        }

        // Re-throw so Promise.allSettled captures it as 'rejected'
        throw err;
    }
}

// ============================================================
// CRON JOB
// ============================================================

/**
 * Validate the cron schedule string before registering the job.
 * node-cron will throw if the expression is invalid.
 */
function validateCronSchedule(schedule) {
    if (!cron.validate(schedule)) {
        throw new Error(`[scheduler] Invalid CRON_SCHEDULE: "${schedule}"`);
    }
}

/**
 * Start the scheduler.
 * Safe to call multiple times — only one job will be registered.
 */
let cronJob = null;

function start() {
    if (cronJob) {
        console.log('[scheduler] Already running — ignoring duplicate start()');
        return;
    }

    validateCronSchedule(CRON_SCHEDULE);

    console.log(`[scheduler] ✅ Starting cron job`);
    console.log(`[scheduler]    Schedule : ${CRON_SCHEDULE}`);
    console.log(`[scheduler]    Timezone : ${CRON_TIMEZONE}`);

    cronJob = cron.schedule(
        CRON_SCHEDULE,
        () => {
            // Fire and forget — errors are caught inside processReminders()
            processReminders().catch(err => {
                console.error('[scheduler] Unhandled error in processReminders:', err);
            });
        },
        {
            scheduled: true,
            timezone:  CRON_TIMEZONE,
        }
    );
}

/**
 * Stop the scheduler gracefully.
 * Useful for clean shutdowns and testing.
 */
function stop() {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
        console.log('[scheduler] Cron job stopped');
    }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
// When the process receives SIGTERM or SIGINT (e.g. Ctrl+C or
// a deployment platform stopping the process), stop the cron
// job cleanly and wait for any in-progress run to finish.

function shutdown(signal) {
    console.log(`[scheduler] Received ${signal} — shutting down gracefully`);
    stop();

    // Give in-progress reminder sends up to 10 seconds to finish
    const timeout = setTimeout(() => {
        console.log('[scheduler] Timeout reached — forcing exit');
        process.exit(0);
    }, 10_000);

    // Poll until the current run finishes
    const poll = setInterval(() => {
        if (!isRunning) {
            clearTimeout(timeout);
            clearInterval(poll);
            console.log('[scheduler] Clean shutdown complete');
            process.exit(0);
        }
        log('Waiting for in-progress run to finish...');
    }, 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ============================================================
// AUTO-START when run directly (node scheduler.js)
// ============================================================
if (require.main === module) {
    start();
    console.log('[scheduler] Running standalone. Press Ctrl+C to stop.');
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = { start, stop, processReminders };

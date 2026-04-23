-- ============================================================
-- WhatsApp Movie Recommendation Bot — Supabase Database Schema
-- ============================================================
-- Run this entire file in your Supabase SQL Editor to set up
-- all required tables, indexes, and constraints.
-- ============================================================


-- ─────────────────────────────────────────
-- TABLE 1: users
-- Core user profile. One row per WhatsApp number.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- WhatsApp number in E.164 format, e.g. "whatsapp:+1234567890"
    -- This is the unique identifier we receive from Twilio on every message.
    phone_number        TEXT NOT NULL UNIQUE,

    -- Basic profile (collected during onboarding)
    name                TEXT,
    age                 INTEGER CHECK (age > 0 AND age < 130),

    -- Preferred genres as a simple text array, e.g. {"Action","Comedy","Thriller"}
    preferred_genres    TEXT[] DEFAULT '{}',

    -- Preferred spoken/subtitle languages, e.g. {"English","Hindi"}
    preferred_languages TEXT[] DEFAULT '{"English"}',

    -- Preferred streaming platforms, e.g. {"Netflix","Prime Video"}
    preferred_platforms TEXT[] DEFAULT '{}',

    -- Onboarding state machine.
    -- Possible values:
    --   'new'              → brand new user, onboarding not started
    --   'awaiting_name'    → bot asked for name, waiting for reply
    --   'awaiting_age'     → bot asked for age, waiting for reply
    --   'awaiting_genres'  → bot asked for genres, waiting for reply
    --   'complete'         → onboarding done, full chat mode active
    onboarding_status   TEXT NOT NULL DEFAULT 'new'
                            CHECK (onboarding_status IN (
                                'new',
                                'awaiting_name',
                                'awaiting_age',
                                'awaiting_genres',
                                'complete'
                            )),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- TABLE 2: watch_history
-- Movies the user has already watched.
-- Claude will never recommend these again.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watch_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    movie_title TEXT NOT NULL,

    -- Optional rating the user gave (1–10), if they shared it
    user_rating INTEGER CHECK (user_rating >= 1 AND user_rating <= 10),

    -- Optional genres for this movie (helps Claude learn taste over time)
    genres      TEXT[] DEFAULT '{}',

    watched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate entries for the same user + movie
    UNIQUE (user_id, movie_title)
);

-- ─────────────────────────────────────────
-- TABLE 3: rejected_movies
-- Movies the user explicitly said NO to.
-- Claude will never suggest these again.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rejected_movies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    movie_title TEXT NOT NULL,

    -- Optional: why did they reject it? e.g. "not in mood", "seen trailer, not interested"
    reason      TEXT,

    rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate rejections
    UNIQUE (user_id, movie_title)
);

-- ─────────────────────────────────────────
-- TABLE 4: wishlist
-- Movies the user wants to watch in the future.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wishlist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    movie_title TEXT NOT NULL,

    -- Optional notes the user added, e.g. "watch with family"
    notes       TEXT,

    -- Whether the user has been reminded about this movie
    reminded    BOOLEAN NOT NULL DEFAULT FALSE,

    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicates
    UNIQUE (user_id, movie_title)
);

-- ─────────────────────────────────────────
-- TABLE 5: reminders
-- Scheduled WhatsApp messages.
-- The scheduler checks this table every minute.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The exact message to send via WhatsApp
    message         TEXT NOT NULL,

    -- When to send it (UTC). The scheduler fires when NOW() >= send_at.
    send_at         TIMESTAMPTZ NOT NULL,

    -- Tracks delivery state.
    -- Possible values:
    --   'pending' → not yet sent
    --   'sent'    → successfully delivered to Twilio
    --   'failed'  → Twilio returned an error
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),

    -- If status = 'failed', store the error for debugging
    error_message   TEXT,

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ  -- filled in when actually sent
);


-- ============================================================
-- INDEXES
-- These speed up the most frequent queries the app will run.
-- ============================================================

-- Look up a user by their phone number on every incoming message
CREATE INDEX IF NOT EXISTS idx_users_phone_number
    ON users(phone_number);

-- Fetch all watched movies for a user (used when building Claude's prompt)
CREATE INDEX IF NOT EXISTS idx_watch_history_user_id
    ON watch_history(user_id);

-- Fetch all rejected movies for a user (used when building Claude's prompt)
CREATE INDEX IF NOT EXISTS idx_rejected_movies_user_id
    ON rejected_movies(user_id);

-- Fetch a user's wishlist
CREATE INDEX IF NOT EXISTS idx_wishlist_user_id
    ON wishlist(user_id);

-- The scheduler's query: find all pending reminders whose send_at has passed
CREATE INDEX IF NOT EXISTS idx_reminders_status_send_at
    ON reminders(status, send_at);


-- ============================================================
-- AUTO-UPDATE updated_at ON users
-- Keeps the updated_at column accurate without manual updates.
-- ============================================================

-- Step 1: Create the trigger function (runs on any UPDATE to users)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 2: Attach the trigger to the users table
DROP TRIGGER IF EXISTS set_updated_at ON users;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- DONE
-- All tables, indexes, and triggers are now created.
-- ============================================================

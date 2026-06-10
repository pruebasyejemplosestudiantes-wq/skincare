-- Extensión para gen_random_uuid() en Postgres < 13
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tabla de usuarios (identificados por UUID generado en el navegador)
CREATE TABLE IF NOT EXISTS quiz_users (
    id          UUID        PRIMARY KEY,
    ip_address  TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla de respuestas del quiz
CREATE TABLE IF NOT EXISTS quiz_responses (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES quiz_users(id) ON DELETE CASCADE,
    answers      JSONB       NOT NULL,   -- [{question:0, option:2, type:"oily"}, ...]
    result_type  VARCHAR(20) NOT NULL,   -- oily | dry | combo | normal | aging | sensitive
    scores       JSONB       NOT NULL,   -- {oily:4, dry:1, ...}
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_responses_user_id   ON quiz_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_responses_result    ON quiz_responses(result_type);
CREATE INDEX IF NOT EXISTS idx_responses_completed ON quiz_responses(completed_at);

-- Tabla de usuarios (identificados por UUID generado en el navegador)
CREATE TABLE IF NOT EXISTS quiz_users (
    id          UUID        PRIMARY KEY,
    ip_address  TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla de respuestas del quiz (soporta guardado parcial y completo)
CREATE TABLE IF NOT EXISTS quiz_responses (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES quiz_users(id) ON DELETE CASCADE,
    answers         JSONB       NOT NULL DEFAULT '[]',
    questions_done  INT         NOT NULL DEFAULT 0,
    result_type     VARCHAR(20),             -- NULL si no terminó
    scores          JSONB,                   -- NULL si no terminó
    is_completed    BOOLEAN     NOT NULL DEFAULT false,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_responses_user_id   ON quiz_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_responses_result    ON quiz_responses(result_type);
CREATE INDEX IF NOT EXISTS idx_responses_started   ON quiz_responses(started_at);

-- Migración segura para tablas ya existentes
DO $$ BEGIN
  ALTER TABLE quiz_responses ALTER COLUMN result_type DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ALTER COLUMN scores DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ADD COLUMN is_completed BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ADD COLUMN questions_done INT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ADD COLUMN started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ADD COLUMN completed_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ALTER COLUMN answers SET DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Tabla de usuarios (identificados por UUID generado en el navegador)
CREATE TABLE IF NOT EXISTS quiz_users (
    id          UUID        PRIMARY KEY,
    ip_address  TEXT,
    user_agent  TEXT,
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla de respuestas del quiz (soporta guardado parcial y completo)
CREATE TABLE IF NOT EXISTS quiz_responses (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES quiz_users(id) ON DELETE CASCADE,
    answers         JSONB       NOT NULL DEFAULT '[]',
    questions_done  INT         NOT NULL DEFAULT 0,
    result_type     VARCHAR(20),
    scores          JSONB,
    is_completed    BOOLEAN     NOT NULL DEFAULT false,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

-- Migraciones seguras (columnas que pueden faltar en tablas preexistentes)
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
  ALTER TABLE quiz_responses ALTER COLUMN completed_at DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_responses ALTER COLUMN answers SET DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quiz_users ADD COLUMN email TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Tabla de clics en "Ir a pagar"
CREATE TABLE IF NOT EXISTS pay_clicks (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        REFERENCES quiz_users(id) ON DELETE SET NULL,
    email       TEXT,
    clicked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla de pagos (webhooks de Hotmart)
CREATE TABLE IF NOT EXISTS payments (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  TEXT        UNIQUE,
    email           TEXT,
    name            TEXT,
    status          TEXT,
    event_type      TEXT,
    raw_payload     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE quiz_users ADD COLUMN email TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Índices (después de garantizar que las columnas existen; se ignoran si ya existen o fallan)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_responses_user_id ON quiz_responses(user_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_responses_result ON quiz_responses(result_type);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_responses_started ON quiz_responses(started_at);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

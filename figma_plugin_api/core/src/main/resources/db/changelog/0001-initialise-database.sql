--liquibase formatted sql
--changeset dhiaeddine:initialise-database

-- Create the table for UserEntity (with idempotency checks and logging)
DO
$$
BEGIN
        RAISE
NOTICE 'Creating ENUM type user_roles';
CREATE TYPE user_roles AS ENUM ('ADMIN', 'USER', 'GUEST');
EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table Users already exists, skipping creation';
END
$$;

DO
$$
BEGIN
        RAISE
NOTICE 'Creating table users';
CREATE TABLE users
(
    id                         VARCHAR PRIMARY KEY,
    username                   VARCHAR,
    email                      VARCHAR    UNIQUE,
    name                       VARCHAR    NOT NULL,
    role                       user_roles NOT NULL,
    created_at                 TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    allow_saving_completions   BOOLEAN    NOT NULL DEFAULT FALSE,
    encryption_key             VARCHAR,
    encryption_key_expires_at  TIMESTAMP,
    port                       INTEGER,
    auth0_sub                  VARCHAR    UNIQUE
);
Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table users already exists, skipping creation';
END
$$;

-- Create the table for ComponentCompletionEntity (with checks and logs for both table and foreign key)
DO
$$
BEGIN
        RAISE
NOTICE 'Creating table component_completions';
CREATE TABLE component_completions
(
    user_id       VARCHAR,
    CONSTRAINT fk_component_user FOREIGN KEY (user_id) REFERENCES users (id),
    id            VARCHAR PRIMARY KEY,
    prompt        TEXT      NOT NULL,
    ai_completion TEXT      NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table component_completions already exists, skipping creation';
END
$$;

-- Create the social_providers type (with idempotency check and logs)
DO
$$
BEGIN
        RAISE
NOTICE 'Creating ENUM type social_providers';
CREATE TYPE social_providers AS ENUM ('FIGMA', 'GITHUB', 'GOOGLE');
Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'ENUM type social_providers already exists, skipping creation';
END
$$;

-- Create the SocialLogins table (with checks and logging)
DO
$$
BEGIN
        RAISE
NOTICE 'Creating table social_logins';
CREATE TABLE social_logins
(
    id                        VARCHAR PRIMARY KEY,
    provider_user_id          VARCHAR UNIQUE   NOT NULL,
    user_id                   VARCHAR          NOT NULL,
    provider                  social_providers NOT NULL,
    refresh_token             VARCHAR,
    refresh_token_expires_at  TIMESTAMP        Not NULL,
    main                      BOOLEAN          NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_social_user FOREIGN KEY (user_id) REFERENCES users (id)
);
EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table social_logins already exists, skipping creation';
END
$$;

-- Add any necessary indexes (with idempotency checks and logs)
DO
$$
BEGIN
        RAISE
NOTICE 'Creating index idx_component_completions_user_id_id';
CREATE INDEX idx_component_completions_user_id_id ON component_completions (user_id, id);
EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Index idx_component_completions_user_id_id already exists, skipping creation';
END
$$;

DO
$$
BEGIN
        RAISE
NOTICE 'Creating index idx_social_logins_user_id';
CREATE INDEX idx_social_logins_user_id ON social_logins (user_id);
EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Index idx_social_logins_user_id already exists, skipping creation';
END
$$;

--changeset dhiaeddine:session-replay-metadata
-- Holds derived session-replay metadata after the processor stage runs. Populated
-- by MetadataChunkProcessor (processor module) on SESSION_ANONYMIZED. Drives the
-- /api/replay/sessions list endpoint and the demo-app sessions UI.
DO
$$
BEGIN
    RAISE NOTICE 'Creating table session_metadata';
    CREATE TABLE session_metadata
    (
        session_id        VARCHAR PRIMARY KEY,
        org_id            VARCHAR   NOT NULL,
        first_seq         BIGINT    NOT NULL,
        last_seq          BIGINT    NOT NULL,
        chunk_count       BIGINT    NOT NULL DEFAULT 0,
        event_count       BIGINT    NOT NULL DEFAULT 0,
        duration_ms       BIGINT    NOT NULL DEFAULT 0,
        page_transitions  INTEGER   NOT NULL DEFAULT 0,
        first_event_at    TIMESTAMP,
        last_event_at     TIMESTAMP,
        processed_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Table session_metadata already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating index idx_session_metadata_org_processed';
    CREATE INDEX idx_session_metadata_org_processed ON session_metadata (org_id, processed_at DESC);
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Index idx_session_metadata_org_processed already exists, skipping';
END
$$;

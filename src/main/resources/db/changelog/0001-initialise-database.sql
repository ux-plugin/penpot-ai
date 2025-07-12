--liquibase formatted sql
--changeset dhiaeddine:initialise-database

-- Create the table for UserEntity
CREATE TABLE Users
(
    id                              VARCHAR PRIMARY KEY,
    username                        VARCHAR   NOT NULL UNIQUE,
    password                        VARCHAR   NOT NULL,
    name                            VARCHAR   NOT NULL,
    role                            VARCHAR   NOT NULL,
    createdAt                       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    companionAppConnected           BOOLEAN   NOT NULL DEFAULT FALSE,
    companionAppPort                INT       NOT NULL DEFAULT 64032,
    allowSavingCompletions          BOOLEAN   NOT NULL DEFAULT FALSE,
    verified                        BOOLEAN   NOT NULL DEFAULT FALSE,
    emailVerificationFailedAttempts INT       NOT NULL DEFAULT 0,
    emailVerificationCodeGenerated  INT       NOT NULL DEFAULT 0,
    emailVerificationCodeExpiresAt  TIMESTAMP,
    emailVerificationCode           VARCHAR
);

-- Create the table for ComponentCompletionEntity
CREATE TABLE ComponentCompletions
(
    userId       VARCHAR,
    CONSTRAINT fk_component_user FOREIGN KEY (userId) REFERENCES Users (id),
    id           VARCHAR PRIMARY KEY,
    prompt       TEXT      NOT NULL,
    aiCompletion TEXT      NOT NULL,
    createdAt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add any necessary indexes (if required for constraints or optimization)
CREATE INDEX idx_component_completions_userId_completionId ON ComponentCompletions (userId, id);

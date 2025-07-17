--liquibase formatted sql
--changeset dhiaeddine:initialise-database

-- Create the table for UserEntity (with idempotency checks and logging)
DO
$$
    BEGIN
        RAISE NOTICE 'Creating ENUM type user_roles';
        CREATE TYPE user_roles AS ENUM ('admin', 'user', 'guest');
    EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table Users already exists, skipping creation';
    END
$$;

CREATE OR REPLACE FUNCTION random_name()
    RETURNS TEXT AS
$$
BEGIN
    RETURN 'User_' || substring(md5(random()::text), 1, 8);
END
$$ LANGUAGE plpgsql;

DO
$$
    BEGIN
        RAISE NOTICE 'Creating table Users';
        CREATE TABLE Users
        (
            id                                     VARCHAR PRIMARY KEY,
            username                               VARCHAR    NOT NULL UNIQUE,
            name                                   VARCHAR    NOT NULL DEFAULT random_name(),
            role                                   user_roles NOT NULL,
            createdAt                              TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
            companionAppConnected                  BOOLEAN    NOT NULL DEFAULT FALSE,
            companionAppPort                       INT        NOT NULL DEFAULT 64032,
            allowSavingCompletions                 BOOLEAN    NOT NULL DEFAULT FALSE,
            verified                               BOOLEAN    NOT NULL DEFAULT FALSE,
            emailVerificationFailedAttempts        INT        NOT NULL DEFAULT 0,
            numberOfEmailVerificationCodeGenerated INT        NOT NULL DEFAULT 0,
            emailVerificationCodeExpiresAt         TIMESTAMP,
            emailVerificationCode                  VARCHAR
        );
    Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table Users already exists, skipping creation';
    END
$$;

-- Create the table for ComponentCompletionEntity (with checks and logs for both table and foreign key)
DO
$$
    BEGIN
        RAISE NOTICE 'Creating table ComponentCompletions';
        CREATE TABLE ComponentCompletions
        (
            userId       VARCHAR,
            CONSTRAINT fk_component_user FOREIGN KEY (userId) REFERENCES Users (id),
            id           VARCHAR PRIMARY KEY,
            prompt       TEXT      NOT NULL,
            aiCompletion TEXT      NOT NULL,
            createdAt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table ComponentCompletions already exists, skipping creation';
    END
$$;

-- Create the social_providers type (with idempotency check and logs)
DO
$$
    BEGIN
        RAISE NOTICE 'Creating ENUM type social_providers';
        CREATE TYPE social_providers AS ENUM ('figma', 'github', 'google');
    Exception
        WHEN duplicate_object THEN
            RAISE NOTICE 'ENUM type social_providers already exists, skipping creation';
    END
$$;

-- Create the SocialLogins table (with checks and logging)
DO
$$
    BEGIN
        RAISE NOTICE 'Creating table SocialLogins';
        CREATE TABLE SocialLogins
        (
            id           VARCHAR PRIMARY KEY,
            userId       VARCHAR          NOT NULL,
            provider     social_providers NOT NULL,
            refreshToken VARCHAR,
            CONSTRAINT fk_social_user FOREIGN KEY (userId) REFERENCES Users (id)
        );
    EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Table SocialLogins already exists, skipping creation';
    END
$$;

-- Add any necessary indexes (with idempotency checks and logs)
DO
$$
    BEGIN
        RAISE NOTICE 'Creating index idx_component_completions_userId_completionId';
        CREATE INDEX idx_component_completions_userId_completionId ON ComponentCompletions (userId, id);
    EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Index idx_component_completions_userId_completionId already exists, skipping creation';
    END
$$;

DO
$$
    BEGIN
        RAISE NOTICE 'Creating index idx_social_logins_userId';
        CREATE INDEX idx_social_logins_userId ON SocialLogins (userId);
    EXCEPTION
        WHEN duplicate_object THEN
            RAISE NOTICE 'Index idx_social_logins_userId already exists, skipping creation';
    END
$$;
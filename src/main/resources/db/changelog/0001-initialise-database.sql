--liquibase formatted sql
--changeset dhiaeddine:initialise-database

-- Create the table for UserEntity
CREATE TABLE Users
(
    userId                VARCHAR PRIMARY KEY,
    companionAppConnected BOOLEAN NOT NULL DEFAULT FALSE,
    companionAppPort      INT     NOT NULL DEFAULT 64032
);

-- Create the table for ComponentCompletionEntity
CREATE TABLE ComponentCompletions
(
    userId       VARCHAR,
    CONSTRAINT fk_component_user FOREIGN KEY (userId) REFERENCES Users (userId),
    completionId VARCHAR PRIMARY KEY,
    prompt       TEXT      NOT NULL,
    aiCompletion TEXT      NOT NULL,
    createdAt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- Add any necessary indexes (if required for constraints or optimization)
CREATE INDEX idx_component_completions_userId_completionId ON ComponentCompletions (userId, completionId);
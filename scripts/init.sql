-- MySQL initialization script for figma_plugin database

-- Use the figma_plugin database
USE figma_plugin;

-- Create ComponentCompletions table if it doesn't exist
CREATE TABLE IF NOT EXISTS ComponentCompletions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    completion_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    prompt TEXT NOT NULL,
    component_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_completion_id (completion_id)
);

-- Create UserConfigs table if it doesn't exist
CREATE TABLE IF NOT EXISTS UserConfigs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    config_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);

-- Add any other necessary tables or initial data here
--liquibase formatted sql
--changeset dhiaeddine:orgs-and-api-keys

DO
$$
BEGIN
    RAISE NOTICE 'Creating ENUM type org_member_roles';
    CREATE TYPE org_member_roles AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'ENUM org_member_roles already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating table organizations';
    CREATE TABLE organizations
    (
        id         VARCHAR PRIMARY KEY,
        slug       VARCHAR   NOT NULL UNIQUE,
        name       VARCHAR   NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Table organizations already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating table organization_members';
    CREATE TABLE organization_members
    (
        org_id     VARCHAR          NOT NULL,
        user_id    VARCHAR          NOT NULL,
        role       org_member_roles NOT NULL,
        created_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (org_id, user_id),
        CONSTRAINT fk_org_members_org FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_org_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Table organization_members already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating index idx_org_members_user_id';
    CREATE INDEX idx_org_members_user_id ON organization_members (user_id);
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Index idx_org_members_user_id already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating table api_keys';
    CREATE TABLE api_keys
    (
        id                  VARCHAR PRIMARY KEY,
        org_id              VARCHAR   NOT NULL,
        created_by_user_id  VARCHAR   NOT NULL,
        name                VARCHAR   NOT NULL,
        prefix              VARCHAR   NOT NULL,
        key_hash            VARCHAR   NOT NULL UNIQUE,
        last_used_at        TIMESTAMP,
        revoked_at          TIMESTAMP,
        created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_api_keys_org FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_api_keys_user FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
    );
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Table api_keys already exists, skipping';
END
$$;

DO
$$
BEGIN
    RAISE NOTICE 'Creating index idx_api_keys_org_active';
    CREATE INDEX idx_api_keys_org_active ON api_keys (org_id) WHERE revoked_at IS NULL;
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Index idx_api_keys_org_active already exists, skipping';
END
$$;

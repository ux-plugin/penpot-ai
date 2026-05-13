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

--changeset dhiaeddine:seed-dev-api-key
-- Seeds a deterministic user/org/api-key for local dev so the demo-app can call
-- the ingest endpoints without going through the auth flow. The plaintext key is:
--   pk_live_demo0000000000000000000000000000000000
-- Stored as SHA-256 hex (matches ApiKeyGenerator.hash). Safe to ship until a real
-- prod DB exists; revisit before first prod deploy and gate behind a dev profile.

INSERT INTO users (id, name, role)
VALUES ('dev-user', 'Dev User', 'ADMIN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organizations (id, slug, name)
VALUES ('dev-org', 'dev-org', 'Dev Org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_members (org_id, user_id, role)
VALUES ('dev-org', 'dev-user', 'OWNER')
ON CONFLICT (org_id, user_id) DO NOTHING;

INSERT INTO api_keys (id, org_id, created_by_user_id, name, prefix, key_hash)
VALUES (
    'dev-key',
    'dev-org',
    'dev-user',
    'demo-app dev key',
    'pk_live_demo',
    'b480d797bf4b30a7d209db1854798e4577f4e6e1cb32ebd4e2d8366cf8894fd9'
)
ON CONFLICT (id) DO NOTHING;

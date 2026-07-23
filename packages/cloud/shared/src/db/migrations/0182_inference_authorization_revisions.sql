CREATE SEQUENCE IF NOT EXISTS inference_authorization_revision_seq AS bigint;
--> statement-breakpoint

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS inference_auth_revision bigint NOT NULL
  DEFAULT 0;
--> statement-breakpoint

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS inference_auth_revision bigint NOT NULL
  DEFAULT 0;
--> statement-breakpoint

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS inference_session_not_before bigint NOT NULL
  DEFAULT 0;
--> statement-breakpoint

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS inference_auth_revision bigint NOT NULL
  DEFAULT 0;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION advance_organization_inference_auth_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.inference_auth_revision := GREATEST(
      OLD.inference_auth_revision + 1,
      nextval('inference_authorization_revision_seq')
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION advance_user_inference_auth_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.steward_user_id IS DISTINCT FROM OLD.steward_user_id THEN
    NEW.inference_auth_revision := GREATEST(
      OLD.inference_auth_revision + 1,
      nextval('inference_authorization_revision_seq')
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION advance_api_key_inference_auth_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    NEW.inference_auth_revision := GREATEST(
      OLD.inference_auth_revision + 1,
      nextval('inference_authorization_revision_seq')
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS organizations_inference_auth_revision_trigger
  ON organizations;
--> statement-breakpoint

CREATE TRIGGER organizations_inference_auth_revision_trigger
BEFORE UPDATE OF is_active ON organizations
FOR EACH ROW
EXECUTE FUNCTION advance_organization_inference_auth_revision();
--> statement-breakpoint

DROP TRIGGER IF EXISTS users_inference_auth_revision_trigger ON users;
--> statement-breakpoint

CREATE TRIGGER users_inference_auth_revision_trigger
BEFORE UPDATE OF is_active, organization_id, deleted_at, steward_user_id ON users
FOR EACH ROW
EXECUTE FUNCTION advance_user_inference_auth_revision();
--> statement-breakpoint

DROP TRIGGER IF EXISTS api_keys_inference_auth_revision_trigger ON api_keys;
--> statement-breakpoint

CREATE TRIGGER api_keys_inference_auth_revision_trigger
BEFORE UPDATE OF is_active, key_hash, expires_at, deleted_at, user_id,
  organization_id ON api_keys
FOR EACH ROW
EXECUTE FUNCTION advance_api_key_inference_auth_revision();

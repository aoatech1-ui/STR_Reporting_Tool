-- Two-factor login (TOTP + recovery codes).
-- The TOTP secret is stored encrypted (AES-256-GCM, bound to the user id); recovery codes only as keyed hashes.
ALTER TABLE users
  ADD COLUMN totp_secret_enc  text,
  ADD COLUMN totp_pending_enc text,
  ADD COLUMN totp_pending_at  timestamptz,
  ADD COLUMN totp_enabled_at  timestamptz,
  ADD COLUMN totp_last_step   bigint,
  ADD CONSTRAINT users_totp_enabled_has_secret CHECK (totp_enabled_at IS NULL OR totp_secret_enc IS NOT NULL);

ALTER TABLE organizations ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;

CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- A password-verified login waiting for its second factor. No session exists until it is completed.
CREATE TABLE mfa_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mfa_challenges (user_id);
CREATE INDEX ON mfa_challenges (expires_at);

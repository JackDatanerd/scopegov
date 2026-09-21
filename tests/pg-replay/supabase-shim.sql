-- Minimal Supabase shim for replaying ScopeGov migrations on vanilla Postgres 16
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOINHERIT LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT; END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aud varchar(255), role varchar(255),
  email varchar(255), encrypted_password varchar(255), email_confirmed_at timestamptz,
  invited_at timestamptz, confirmation_token varchar(255), confirmation_sent_at timestamptz,
  recovery_token varchar(255), recovery_sent_at timestamptz, email_change_token_new varchar(255),
  email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), phone text, banned_until timestamptz,
  deleted_at timestamptz, is_anonymous boolean DEFAULT false
);
CREATE TABLE IF NOT EXISTS auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id text, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), email text
);
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  friendly_name text, factor_type text, status text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), secret text
);
CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), refreshed_at timestamp, user_agent text, ip inet, aal text, not_after timestamptz);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'sub')), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.role', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'role')), '')::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.email', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'email')), '')::text $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt(), auth.email() TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), metadata jsonb
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE _parts text[]; BEGIN _parts := string_to_array(name, '/'); RETURN _parts[1:array_length(_parts,1)-1]; END $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE _parts text[]; BEGIN _parts := string_to_array(name, '/'); RETURN _parts[array_length(_parts,1)]; END $$;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;

-- Supabase default privileges in public
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

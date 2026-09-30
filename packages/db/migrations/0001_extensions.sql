-- 0001_extensions.sql
-- Idempotent extension creation for vector, pg_trgm, pgcrypto, uuid-ossp, and casefile_app role setup.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casefile_app') THEN
    CREATE ROLE casefile_app NOINHERIT NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO casefile_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO casefile_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO casefile_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO casefile_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO casefile_app;

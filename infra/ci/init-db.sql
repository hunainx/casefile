-- Runs once at cluster creation. Mirrors scripts/dev-db.sh provision().

-- 1. Create the application role.
-- NOSUPERUSER, not the table owner, and NOBYPASSRLS. Invariant I7 is unenforceable otherwise:
-- a superuser or owner silently ignores every row-level security policy, which would make
-- the entire tenancy guardrail suite pass against a database that is not actually isolating anything.
CREATE ROLE casefile_app LOGIN PASSWORD 'casefile_app'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- 2. Provision casefile (default database)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

GRANT CONNECT ON DATABASE casefile TO casefile_app;
GRANT USAGE ON SCHEMA public TO casefile_app;
REVOKE CREATE ON SCHEMA public FROM casefile_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Create and provision casefile_test database
CREATE DATABASE casefile_test OWNER casefile;

\connect casefile_test

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

GRANT CONNECT ON DATABASE casefile_test TO casefile_app;
GRANT USAGE ON SCHEMA public TO casefile_app;
REVOKE CREATE ON SCHEMA public FROM casefile_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Per-database bootstrap. Runs as a PostgreSQL superuser inside each Hamnivo database.
-- Extensions need a superuser (pgvector is not a trusted extension), so migrations only assert them.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO hamnivo_app, hamnivo_platform;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hamnivo_app, hamnivo_platform, hamnivo_resolver;

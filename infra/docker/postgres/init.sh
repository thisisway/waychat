#!/bin/sh
# Roda uma única vez na criação do volume. O usuário owner (POSTGRES_USER) é dono do schema e roda as migrações.
# A role da aplicação NÃO é dona das tabelas e NÃO tem BYPASSRLS: por isso a RLS a atinge.
set -eu
psql -v ON_ERROR_STOP=1 -v app_pw="$WAYCHAT_APP_PASSWORD" -v relay_pw="$WAYCHAT_RELAY_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE waychat_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- Relay do outbox: lê eventos de todos os tenants; privilégios mínimos concedidos na migração (só a tabela outbox).
CREATE ROLE waychat_relay LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE waychat TO waychat_relay;
GRANT USAGE ON SCHEMA public TO waychat_relay;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT CONNECT ON DATABASE waychat TO waychat_app;
GRANT USAGE ON SCHEMA public TO waychat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE waychat_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO waychat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE waychat_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO waychat_app;
SQL

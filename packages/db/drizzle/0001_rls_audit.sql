-- Isolamento por tenant (RLS), auditoria append-only e privilégios do relay do outbox.
-- Pré-requisito: roles waychat_app e waychat_relay (infra/docker/postgres/init.sh). Migrações rodam como waychat_owner.

-- Tenant da transação atual. `set_config('app.account_id', <uuid>, true)` é local à transação.
-- nullif: depois do COMMIT a GUC volta como '' (não NULL); sem o nullif o cast para uuid daria erro.
-- Sem tenant definido => NULL => nenhuma linha passa (deny-by-default).
CREATE OR REPLACE FUNCTION app_account_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;
--> statement-breakpoint

-- Tabelas com account_id: RLS ligada e FORÇADA (vale até para o dono da tabela, exceto superusuário).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'role_permissions', 'account_users', 'api_keys', 'inbound_events', 'outbox']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- accounts: a linha é o próprio tenant.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON accounts
  USING (id = app_account_id()) WITH CHECK (id = app_account_id());
--> statement-breakpoint

-- audit_logs: só INSERT (eventos globais, sem conta, também podem ser inseridos) e SELECT do próprio tenant.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_select ON audit_logs FOR SELECT USING (account_id = app_account_id());
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (account_id IS NULL OR account_id = app_account_id());
--> statement-breakpoint

-- Append-only em três camadas: privilégio, trigger e ausência de policy de UPDATE/DELETE.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM waychat_app;
--> statement-breakpoint
CREATE FUNCTION audit_logs_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_logs é append-only (% bloqueado)', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint

-- Relay do outbox: enxerga todos os tenants, mas só nesta tabela e só pode alterar published_at.
GRANT SELECT ON outbox TO waychat_relay;
--> statement-breakpoint
GRANT UPDATE (published_at) ON outbox TO waychat_relay;
--> statement-breakpoint
CREATE POLICY relay_all ON outbox FOR ALL TO waychat_relay USING (true) WITH CHECK (true);

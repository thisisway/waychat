-- O login precisa descobrir "a quais contas este usuário pertence" ANTES de existir um tenant.
-- Solução sem BYPASSRLS: uma segunda GUC (app.user_id), definida pelo código só DEPOIS de autenticar o usuário,
-- libera a leitura das próprias associações. Não permite escrita nem leitura de outras linhas.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE POLICY member_self_read ON account_users FOR SELECT USING (user_id = app_user_id());

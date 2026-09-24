ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON message_templates
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
--> statement-breakpoint
ALTER TABLE contact_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contact_opt_outs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_opt_outs
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
--> statement-breakpoint

-- Recuperação do envio: acha rápido as mensagens de saída que ainda não terminaram.
CREATE INDEX messages_pending_send_idx ON messages (created_at)
  WHERE direction = 'out' AND status IN ('queued', 'sending');

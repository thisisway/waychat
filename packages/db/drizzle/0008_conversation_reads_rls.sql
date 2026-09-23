ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_reads
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
--> statement-breakpoint

-- Contador de não lidas: mensagens recebidas depois da última leitura, por conversa.
CREATE INDEX messages_unread_idx ON messages (conversation_id, created_at)
  WHERE direction = 'in' AND private = false;

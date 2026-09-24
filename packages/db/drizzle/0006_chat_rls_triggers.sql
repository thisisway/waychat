-- Fase 1: RLS das tabelas de atendimento, cursor de eventos sem lacunas, numeração de conversas,
-- buscas (trigram + full-text) e leitura por chave pública antes de existir tenant.

-- Tabelas de tenant: RLS ligada e FORÇADA + a policy padrão.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_counters', 'inboxes', 'inbox_members', 'contacts', 'contact_identities',
    'conversations', 'messages', 'attachments', 'labels', 'conversation_labels', 'canned_responses'
  ]
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

-- Cursor de eventos por conta, SEM LACUNAS (ADR 0006).
-- O UPSERT trava a linha do contador até o COMMIT: duas transações da mesma conta não numeram em paralelo,
-- então a ordem de commit é a ordem do cursor. ROLLBACK desfaz o incremento: nunca sobra um "buraco".
CREATE FUNCTION outbox_assign_seq() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  INSERT INTO account_counters (account_id, event_seq) VALUES (NEW.account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET event_seq = account_counters.event_seq + 1
  RETURNING event_seq INTO NEW.account_seq;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbox_assign_seq BEFORE INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_assign_seq();
--> statement-breakpoint

-- Numeração sequencial de conversas por conta (display_id).
CREATE FUNCTION conversations_assign_display_id() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  INSERT INTO account_counters (account_id, conversation_seq) VALUES (NEW.account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET conversation_seq = account_counters.conversation_seq + 1
  RETURNING conversation_seq INTO NEW.display_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER conversations_assign_display_id BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_assign_display_id();
--> statement-breakpoint

-- Uma mensagem só pode existir numa conversa da MESMA conta e da MESMA inbox (defesa em profundidade contra
-- um bug de aplicação que misture ids de tenants ou de inboxes).
CREATE FUNCTION messages_check_conversation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id AND c.inbox_id = NEW.inbox_id
  ) THEN
    RAISE EXCEPTION 'mensagem inconsistente com a conversa (conta/inbox)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_check_conversation BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_check_conversation();
--> statement-breakpoint

-- Buscas: trigram em nome/telefone/e-mail e full-text em português nas mensagens.
CREATE INDEX contacts_name_trgm ON contacts USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX contacts_email_trgm ON contacts USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX contacts_phone_trgm ON contacts USING gin (phone gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX messages_content_fts ON messages USING gin (to_tsvector('portuguese', coalesce(content, '')))
  WHERE private = false;
--> statement-breakpoint

-- Localizar inbox e chave de API pela chave pública, ANTES de existir tenant (widget e canal API).
-- Mesmo padrão de `member_self_read`: uma GUC definida pelo código só com o valor que o chamador apresentou.
-- A policy só devolve a linha cujo valor bate, e só para SELECT; o segredo (hash) é verificado no código.
CREATE POLICY inbox_public_key_read ON inboxes FOR SELECT
  USING (public_key = nullif(current_setting('app.inbox_public_key', true), ''));
--> statement-breakpoint
CREATE POLICY api_key_prefix_read ON api_keys FOR SELECT
  USING (key_prefix = nullif(current_setting('app.api_key_prefix', true), ''));

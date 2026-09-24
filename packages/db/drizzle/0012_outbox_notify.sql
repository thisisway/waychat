-- Acorda o relay assim que um evento entra no outbox (a notificação só sai no COMMIT), em vez de esperar o próximo
-- ciclo de polling. O polling continua como rede de segurança: NOTIFY não é entregue se o relay estiver desconectado.
CREATE FUNCTION outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('waychat_outbox', '');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_notify_ai AFTER INSERT ON outbox
  FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

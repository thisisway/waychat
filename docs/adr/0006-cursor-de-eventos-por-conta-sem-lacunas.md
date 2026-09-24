# 0006 — Cursor de eventos por conta, sem lacunas

- Status: aceito
- Fase: 1

## Contexto

O cliente (painel, widget) recebe eventos por WebSocket e, ao reconectar, chama `GET /sync?since={cursor}` para recuperar o que perdeu. Isso só é correto se o cursor for **monotônico na ordem de commit**.

A coluna `outbox.cursor` da Fase 0 é uma identity global. Uma sequência é alocada no INSERT, não no COMMIT: a transação T1 pode receber o número 10, a T2 o 11, T2 confirmar primeiro e o cliente sincronizar com `since=11`. Quando T1 confirma, o evento 10 nunca mais é entregue. É perda silenciosa de mensagem, exatamente o que o sistema promete evitar.

## Decisão

Cursor **por conta e sem lacunas**, alocado por trigger:

- `account_counters(account_id, event_seq, conversation_seq)`, uma linha por conta.
- `BEFORE INSERT` em `outbox` executa `INSERT ... ON CONFLICT (account_id) DO UPDATE SET event_seq = event_seq + 1 RETURNING event_seq` e grava o resultado em `outbox.account_seq`. Vale para qualquer inserção, não depende de a aplicação lembrar.
- O UPSERT trava a linha do contador até o COMMIT: duas transações da mesma conta não numeram em paralelo, então **a ordem de commit é a ordem do cursor**. ROLLBACK desfaz o incremento, sem "buracos".
- O envelope de evento carrega `cursor = account_seq`. A identity antiga (`cursor`) continua apenas para o relay varrer pendentes.
- O mesmo mecanismo numera as conversas (`display_id`).

## Consequências

- `GET /sync?since=N` é uma consulta simples: `account_seq > N ORDER BY account_seq`.
- **Custo:** escritas que geram evento _na mesma conta_ se serializam durante a região crítica (a transação inteira, porque o lock só cai no commit). Contas diferentes não se bloqueiam (testado). Para dezenas de atendentes por conta o custo é desprezível; a mitigação prática é manter transações curtas e emitir o evento no fim da transação. Se uma conta tiver volume que sature isso, particionar o contador por inbox é o caminho, com cursor composto.
- Testes: 30 transações concorrentes numeram 1..90 sem repetir; ROLLBACK não deixa buraco; a transação rápida espera a lenta; contas diferentes não esperam.
- Migração: linhas existentes recebem `account_seq` na ordem do cursor antigo.

# 0002 — Isolamento multi-tenant com RLS

- Status: aceito
- Fase: 0

## Contexto

Vazamento entre tenants é o pior defeito possível num SaaS de atendimento. Filtrar por `account_id` no código é necessário, mas um único `WHERE` esquecido expõe dados de todos.

## Decisão

Segunda camada no banco: **Row-Level Security** do PostgreSQL.

- Toda tabela com `account_id` tem RLS **habilitada e forçada** e a policy `account_id = app_account_id()`.
- `app_account_id()` lê a GUC `app.account_id`, definida com `set_config(..., true)` (local à transação) por `withTenant(db, accountId, fn)`. Sem tenant definido, a função devolve `NULL` e nenhuma linha passa (deny-by-default). O `nullif` cobre o caso em que a GUC volta como `''` depois de um COMMIT.
- Três roles no banco: `waychat_owner` (dono do schema, roda migrações), `waychat_app` (aplicação: **sem** `BYPASSRLS`, **não** dona das tabelas) e `waychat_relay` (ver ADR 0003).
- `accounts` usa `id = app_account_id()`. O cadastro de conta gera o UUID antes e abre `withTenant` sobre ele.
- Um teste percorre o catálogo do Postgres e falha se qualquer tabela com `account_id` (exceto as listadas abaixo) não tiver RLS habilitada, forçada e com policy.

### Exceções deliberadas

`users`, `sessions`, `user_mfa_factors` e `user_recovery_codes` são identidade/sessão **globais**: o login e o refresh precisam localizá-las antes de existir um tenant. Elas não têm RLS por tenant; o acesso é sempre por chave que só o próprio usuário possui (e-mail + senha, hash do refresh token). `sessions` tem `account_id` e está numa lista explícita do teste.

Para o login descobrir "a quais contas este usuário pertence" sem `BYPASSRLS`, `account_users` tem uma segunda policy, `member_self_read` (`FOR SELECT`, `user_id = app_user_id()`), habilitada por `withUser(db, userId, fn)` **somente depois** de a senha ser verificada. Ela não permite escrita nem leitura de linhas de outros usuários.

`api_keys`: a busca por prefixo antes de haver tenant precisará de uma função `SECURITY DEFINER` (backlog, Fase 1).

## Consequências

- Um bug de aplicação que esquece o filtro devolve zero linhas, não dados alheios.
- Toda consulta a tabela de tenant precisa estar dentro de `withTenant`; fora dela, o resultado é vazio (falha segura, mas pode confundir em desenvolvimento).
- O superusuário do Postgres ignora RLS: em produção o dono das tabelas **não** deve ser superusuário e a aplicação nunca conecta como dono.

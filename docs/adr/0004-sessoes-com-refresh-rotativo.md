# 0004 — Sessões: access token curto + refresh rotativo com detecção de reuso

- Status: aceito
- Fase: 0

## Decisão

- **Access token** JWT HS256 de 10 min (`sub`, `acc`, `fam`, `mfa`), assinado com chave derivada por HKDF do `SESSION_SECRET` (uma chave por finalidade: access token e challenge de MFA nunca são intercambiáveis). Validado a cada requisição contra o banco (a família de sessão precisa estar ativa e o usuário ainda ser membro), então a revogação é imediata.
- **Refresh token** opaco de 256 bits; no banco só o SHA-256. Vale 30 dias e é **rotativo**: cada uso emite um novo e invalida o anterior (`UPDATE ... WHERE revoked_at IS NULL`, que também resolve a corrida entre duas requisições).
- **Detecção de reuso**: apresentar um refresh já rotacionado revoga a **família inteira** (`family_id`) e audita `session.refresh_reuse_detected`. Duas rotações simultâneas do mesmo token contam como reuso: o cliente deve serializar o refresh.
- Cookies `HttpOnly`, `SameSite=Lax`, `Secure` em HTTPS. O refresh usa `path=/auth`. Tokens nunca vão no corpo da resposta.
- **CSRF**: checagem de `Origin` em toda rota que muda estado + double-submit (`wc_csrf` legível pelo JS ↔ header `X-CSRF-Token`) nas rotas autenticadas.
- **2FA**: TOTP (`otplib`) com segredo cifrado em AES-256-GCM (AAD `mfa:<userId>`), código nunca aceito duas vezes (o passo de tempo só avança, com UPDATE condicional) e 10 códigos de recuperação de uso único (só hash). Falhas de 2FA e de senha compartilham o mesmo bloqueio progressivo (a partir da 5ª, 30 s dobrando até 15 min).
- Resposta única `invalid_credentials` para e-mail inexistente, senha errada, conta bloqueada ou desativada, com verificação Argon2 contra um hash descartável para igualar o tempo.

## Consequências

- Uma consulta ao banco por requisição autenticada (cacheável depois, se medido).
- Passkeys/WebAuthn ficam para a Fase 7.

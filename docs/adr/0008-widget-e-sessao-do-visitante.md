# ADR 0008 — Widget e sessão do visitante

Status: aceito (Fase 1)

## Contexto

O widget roda dentro do site do cliente (outra origem), fala com a API sem cookies e precisa: identificar o visitante,
impedir que um site não autorizado abra conversas na inbox, e nunca deixar um visitante ver a conversa de outro.

## Decisão

1. **Sessão própria, não a do painel.** `POST /widget/v1/session` recebe a chave pública da inbox e devolve um JWT
   (HS256, chave derivada por HKDF com finalidade `widget-visitor`, 24 h). Ele carrega conta, inbox e a identidade do
   contato; **tudo que a API usa vem do token, nunca do corpo**. Um access token do painel não vale aqui e vice-versa.
2. **Quem pode abrir sessão:** só origens da lista `allowedOrigins` da inbox (lista vazia = ninguém). Chave
   desconhecida, inbox de outro canal ou desativada respondem o mesmo `404`. O mesmo vale no handshake do WebSocket
   (`/widget`). A checagem fica na abertura de sessão e de conexão, não em cada requisição: o token é bearer, então a
   origem só serve para barrar sites não autorizados no navegador.
3. **CORS aberto só para `/widget/*`** (`*`, sem credenciais, só `authorization`/`content-type`). O painel continua
   preso à própria origem.
4. **Identidade.** Anônimo: o servidor gera um `visitor_id` de 128 bits, o cliente guarda e reenvia para retomar a
   conversa (é um segredo de portador, como um cookie). Logado no site do cliente: `user_id` + `HMAC-SHA256(segredo
de identidade, user_id)` em hex, gerado no **servidor do cliente**; o HMAC errado é recusado. Identidades ficam em
   espaços separados (`user:` e `anon:`), então um anônimo nunca vira um usuário.
5. **O que o visitante enxerga:** só as próprias mensagens e as respostas públicas da conversa dele; notas privadas e
   ids de atendente nunca saem. O WebSocket do visitante recebe a resposta já pronta (o conteúdo é dele), enquanto os
   eventos do painel continuam sem conteúdo.
6. **Orçamento:** Preact + socket.io-client, 23,5 KB gzip (limite 50 KB, verificado no build). Estilo dentro de Shadow
   DOM; sem fonte externa.

## Consequências

- O `visitor_id` no `localStorage` é o preço da continuidade sem cookie de terceiros; sem armazenamento (navegação
  privada) a conversa recomeça a cada visita.
- Trocar o segredo de identidade não derruba sessões já emitidas (vencem em 24 h). Se isso virar requisito, incluir
  uma versão do segredo no token.

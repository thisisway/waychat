# ADR 0007 — Visibilidade de eventos e tempo real

Status: aceito (Fase 1)

## Contexto

O painel precisa reagir a mensagens novas sem recarregar, e um atendente só pode ver o que a API já o deixaria ler
(decisão D5: só as caixas de que é membro, ou tudo com `conversations:read_all`). Um canal em tempo real que ignorasse
essa regra seria uma segunda porta de acesso aos dados.

## Decisão

1. **Uma só regra de visibilidade.** `canSeeEvent` (`packages/core/events/visibility.ts`) decide se um usuário pode
   receber um evento. É usada pelo `GET /sync` e pelo WebSocket, então os dois nunca divergem. Evento de conversa fora
   da visibilidade é simplesmente descartado para aquele socket.
2. **Eventos só carregam ids.** Sem conteúdo nem dados pessoais; o cliente reage invalidando o cache e a API (que
   filtra por permissão) devolve o dado. Notas privadas: o payload traz `private`, e a checagem impede que
   quem não pode vê-las receba sequer o aviso.
3. **Socket.IO no servidor HTTP do Fastify**, autenticado pelo cookie `wc_at` (mesma sessão do painel). Defesas:
   verificação de `Origin` no handshake (anti-CSWSH), máximo de 10 sockets por usuário, `typing` com limite de
   5 avisos/s, e revalidação periódica do ator (`actorForSession`) — sessão revogada ou papel/membership alterado
   passam a valer sem esperar o access token vencer.
4. **Fan-out por socket, não por sala de conta.** A filtragem é feita a cada socket com o escopo do evento, porque
   salas por caixa exigiriam reentrar em todas as salas a cada mudança de membership.
5. **Recuperação por cursor.** O envelope leva `cursor = account_seq` (ADR 0006). Ao reconectar, o cliente chama
   `GET /sync?since=N` e deduplica por `event_id`. O WebSocket é otimização; o `/sync` é a fonte de verdade.
6. O relay publica no canal Valkey `wc:events:{account_id}`; a API assina o padrão `wc:events:*`. Com o WebSocket
   no ar, o polling do painel cai de 4 s para 60 s (rede de segurança).

## Consequências

- Entrega é _at-least-once_; o cliente precisa deduplicar (já faz).
- Cada evento custa uma checagem de visibilidade por socket interessado; cacheável por conta se virar gargalo
  (registrado no backlog).
- Presença e digitação são efêmeras e ficam só na memória do processo (uma instância da API por enquanto; com
  várias, usar o adaptador Redis do Socket.IO).

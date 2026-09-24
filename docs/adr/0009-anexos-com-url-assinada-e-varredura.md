# ADR 0009 — Anexos: URL assinada, assinatura de arquivo e varredura

Status: aceito (Fase 1)

## Contexto

Atendentes e visitantes enviam arquivos. Um anexo é entrada não confiável que outra pessoa vai abrir: precisa de limite
de tamanho, de checagem do que ele realmente é, de antivírus e de um caminho de download que não vire XSS nem vazamento
entre contas.

## Decisão

1. **Upload direto ao S3**, sem passar pela API: `POST .../attachments` registra o anexo e devolve um formulário POST
   assinado com `content-length-range 1..10 MB` (o próprio S3 recusa arquivo maior) e a chave fixa
   `accounts/<conta>/<id>`, montada no servidor. Nada que o cliente manda entra no caminho do objeto.
2. **O tipo vem do conteúdo.** Ao concluir (`.../complete`) a API lê os primeiros 4 KB e confere a assinatura contra
   uma **lista fechada** (imagens, PDF, áudio, vídeo, texto puro). A extensão declarada precisa combinar com o conteúdo;
   HTML, SVG, scripts, executáveis e ZIP/Office ficam de fora. Reprovou: o objeto é apagado e o anexo fica `rejected`.
3. **Varredura antes de entregar.** Estados: `awaiting_upload → scanning → clean | infected | rejected`. O job
   `attachment-scan` (BullMQ, 10 tentativas com backoff) envia o objeto ao clamd por INSTREAM. Falha do antivírus
   **nunca vira "limpo"**: o job repete e o arquivo continua retido. Infectado: objeto apagado e auditado
   (`attachment.infected`). Só anexos `clean` entram numa mensagem ou aparecem para o outro lado.
4. **Posse.** Um anexo só é usado por quem enviou (atendente por `user_id`, visitante pela identidade do token), na mesma
   inbox e uma única vez; qualquer outra combinação responde o mesmo erro genérico. No máximo 5 por mensagem e 20
   uploads soltos por remetente.
5. **Download por link assinado de 5 minutos**, gerado só depois de provar acesso: o atendente precisa poder ver a
   conversa (mesma regra da API de mensagens), o visitante só enxerga a própria conversa e notas privadas nunca. O link
   força `Content-Disposition: attachment` e o `Content-Type` **detectado** (nunca o declarado).
6. **Antivírus obrigatório em produção**: sem `CLAMAV_HOST` a API se recusa a subir. Em desenvolvimento, sem ele os
   arquivos passam como limpos (com aviso no log); o serviço é opcional no compose (`--profile antivirus`).

## Consequências

- O navegador fala com o S3: o endereço público do bucket (`S3_PUBLIC_ENDPOINT`) e o CORS do bucket precisam permitir
  POST das origens do painel e dos sites com widget (a URL assinada é a autorização).
- A varredura acrescenta segundos entre enviar e poder mandar o arquivo; a interface mostra "Verificando…".
- Formatos fora da lista (planilhas, documentos do Office, ZIP) serão avaliados depois, com desarmamento de conteúdo.

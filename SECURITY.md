# Política de segurança

## Reportando uma vulnerabilidade

**Não abra uma issue pública.** Use o recurso de relatório privado de vulnerabilidades do GitHub (aba _Security_ → _Report a vulnerability_) deste repositório.

Inclua: descrição, passos para reproduzir, impacto estimado e versão/commit afetado.

- Confirmamos o recebimento em até **3 dias úteis**.
- Damos um retorno com avaliação e prazo de correção em até **10 dias úteis**.
- Pedimos divulgação coordenada: aguarde a correção publicada antes de divulgar detalhes.

## Escopo

Todo o código deste repositório e as imagens Docker publicadas por ele. Fora do escopo: engenharia social, negação de serviço volumétrica e vulnerabilidades em dependências já corrigidas na versão mais recente.

## Práticas do projeto

Isolamento entre tenants com Row-Level Security testado em CI, deny-by-default de rotas, segredos cifrados com AES-256-GCM, logs com redaction, varredura de segredos (gitleaks), análise estática (Semgrep), auditoria de dependências (`pnpm audit`) e de imagens (Trivy) em cada pull request.

## Superfícies expostas na Fase 1

- **Tempo real (WebSocket):** autenticado pelo cookie de sessão, com checagem de `Origin` (anti-CSWSH), limite de conexões por usuário e cada evento filtrado pela mesma regra de visibilidade da API (ADR 0007).
- **Widget e canal API:** o visitante usa um token próprio e assinado; sessões só abrem a partir das origens cadastradas na caixa de entrada; a identidade de usuário logado exige HMAC calculado no servidor do cliente; chaves de API são guardadas só como hash SHA-256 e têm escopo (ADR 0008).
- **Anexos:** URL de upload assinada com limite de tamanho, tipo conferido pela assinatura do arquivo (lista fechada), varredura antivírus antes da entrega, download por link de 5 minutos e sempre como `attachment` (ADR 0009). O antivírus é obrigatório em produção.

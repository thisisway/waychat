# Decisões sobre os tokens de cor

A seção 10A do prompt define os valores de referência. Onde eles não atingem contraste **WCAG 2.1 AA** (4,5:1 para texto normal, 3:1 para ícones e indicadores), o token foi ajustado o mínimo necessário. O teste `packages/ui/src/contrast.test.ts` valida 39 pares de cores em cada tema e falha se algum regredir.

| Token                      | Referência | Adotado                           | Motivo                                                                                               |
| -------------------------- | ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--text-muted`             | `#8A8E94`  | `#6A6E75`                         | 3,3:1 sobre branco e 3,0:1 sobre `--chat-bg`; horários de 12px exigem 4,5:1                          |
| `--text-secondary`         | `#686C70`  | `#5A5E64`                         | mantém hierarquia visível acima do muted já escurecido (5,3:1 → 6,7:1)                               |
| `--note-meta`              | `#767A5F`  | `#5F6349`                         | 3,7:1 sobre `--note-bg`                                                                              |
| `--avatar-fallback`        | `#2DABEE`  | `#1D76AA`                         | branco sobre a referência dá 2,6:1; iniciais são texto                                               |
| `--danger`                 | `#EB4240`  | mantido para pontos/ícones/bordas | 3,9:1 sobre branco serve a elementos gráficos (mínimo 3:1)                                           |
| `--danger-text` (novo)     | —          | `#C62828` (claro) / `#FF8A87`     | texto de erro precisa de 4,5:1                                                                       |
| `--primary-text` (novo)    | —          | `#1560FF` (claro) / `#7AA5FF`     | no tema escuro `#1560FF` sobre `#1B1F26` dá ~3:1; botões seguem com `--primary` (texto branco 5,1:1) |
| `--primary-hover` (escuro) | —          | `#0F4CDC`                         | escurece no hover também no tema escuro, mantendo o branco acima de 4,5:1                            |

Também derivados (a referência não os cobre): `--surface-input`, `--surface-info`, `--primary-soft`, `--warning-*`, `--note-bg` e `--offline` no tema escuro; `--on-*` para o texto sobre fundos coloridos; `--hairline`, `--shadow-*`, `--focus-ring` e os tokens de movimento.

Indicadores de presença (`--success`, `--offline`) sempre vêm acompanhados de texto para leitores de tela, então a cor nunca é a única informação.

## Tailwind

O projeto usa Tailwind v4 (configuração CSS-first): o "preset" pedido no prompt é `packages/ui/src/theme.css` (`@theme inline`), que zera as cores padrão do Tailwind e expõe só os tokens (`bg-surface`, `text-primary-text`, `rounded-control`...). Como usa `var(--token)`, trocar `data-theme` muda o tema sem recompilar.

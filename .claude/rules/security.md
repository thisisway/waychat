# Diretrizes de Segurança

## Verificações de Segurança Obrigatórias

Antes de QUALQUER commit:
- [ ] Sem segredos hardcoded (chaves de API, senhas, tokens)
- [ ] Todas as entradas de usuário validadas
- [ ] Prevenção de injeção SQL (queries parametrizadas)
- [ ] Prevenção de XSS (HTML sanitizado)
- [ ] Proteção CSRF habilitada
- [ ] Autenticação/autorização verificada
- [ ] Rate limiting em todos os endpoints
- [ ] Mensagens de erro não vazam dados sensíveis

## Gerenciamento de Segredos

```typescript
// NUNCA: Segredos hardcoded
const apiKey = "sk-proj-xxxxx"

// SEMPRE: Variáveis de ambiente
const apiKey = process.env.OPENAI_API_KEY

if (!apiKey) {
  throw new Error('OPENAI_API_KEY não configurada')
}
```

## Protocolo de Resposta a Segurança

Se encontrar problema de segurança:
1. PARE imediatamente
2. Use o agente **especialista-seguranca**
3. Corrija problemas CRÍTICOS antes de continuar
4. Rotacione quaisquer segredos expostos
5. Revise toda a base de código para problemas similares

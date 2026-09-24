import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No CI, as falhas viram anotações do GitHub com a mensagem do erro (os logs completos exigem login).
  test: { reporters: process.env['GITHUB_ACTIONS'] ? ['default', 'github-actions'] : ['default'] },
});

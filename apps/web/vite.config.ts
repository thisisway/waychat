import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Em desenvolvimento o painel (5173) e a API (3000) parecem a mesma origem: o Vite repassa as rotas da API,
// então os cookies de sessão (HttpOnly) e o CSRF funcionam exatamente como em produção atrás de um proxy.
const API = process.env['API_URL'] ?? 'http://127.0.0.1:3000';
const apiPaths = [
  '/auth',
  '/conversations',
  '/contacts',
  '/inboxes',
  '/members',
  '/roles',
  '/labels',
  '/canned-responses',
  '/account',
  '/audit-logs',
  '/api-keys',
  '/sync',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(apiPaths.map((p) => [p, { target: API, changeOrigin: false }])),
      '/socket.io': { target: API, ws: true, changeOrigin: false },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});

import { defineConfig } from 'vitest/config';

// Um único arquivo JS (IIFE) que o site do cliente carrega com <script>. Sem CSS externo: o estilo vai
// embutido e aplicado dentro do Shadow DOM, então nada do site vaza para o widget nem o contrário.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    lib: {
      entry: 'src/main.tsx',
      formats: ['iife'],
      name: 'WayChatWidget',
      fileName: () => 'waychat-widget.js',
    },
    minify: true,
    target: 'es2020',
    cssCodeSplit: false,
  },
  server: { port: 5174 },
  test: { environment: 'jsdom' },
});

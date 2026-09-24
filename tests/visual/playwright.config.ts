import { defineConfig } from '@playwright/test';

const PORT = 4173;

/**
 * Regressão visual. As linhas de base valem só para o container Linux do Playwright (mesma imagem do CI):
 * não há sufixo de plataforma no nome. Para regenerar: veja README.md.
 */
export default defineConfig({
  testDir: 'specs',
  snapshotDir: '__screenshots__',
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
  outputDir: 'test-results',
  retries: 0,
  reporter: [['list']],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    reducedMotion: 'reduce',
    launchOptions: { args: ['--font-render-hinting=none'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node serve.mjs',
    url: `http://127.0.0.1:${String(PORT)}/waychat-widget.js`,
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
  },
});

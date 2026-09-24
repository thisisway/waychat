import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

interface IndexEntry {
  id: string;
  title: string;
  type: string;
}

// Exige `pnpm --filter @waychat/ui build-storybook` antes; os ids vêm do índice, então história nova entra sozinha.
const index = JSON.parse(
  readFileSync(
    new globalThis.URL('../../../packages/ui/storybook-static/index.json', import.meta.url),
    'utf8',
  ),
) as { entries: Record<string, IndexEntry> };

const stories = Object.values(index.entries).filter(
  (e) => e.type === 'story' && ['Componentes', 'Fundamentos'].includes(e.title),
);

for (const theme of ['light', 'dark'] as const) {
  for (const story of stories) {
    test(`${story.id} (${theme})`, async ({ page }) => {
      await page.goto(
        `/storybook/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`,
      );
      await expect(page.locator('body')).toHaveClass(/sb-show-main/);
      const root = page.locator('#storybook-root');
      await expect(root).not.toBeEmpty();
      await page.evaluate(() => document.fonts.ready);
      await expect(root).toHaveScreenshot(['storybook', `${story.id}-${theme}.png`]);
    });
  }
}

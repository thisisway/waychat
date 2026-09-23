import type { Decorator, Preview } from '@storybook/react-vite';
import { TooltipProvider } from '../src/index.js';
import '../src/storybook.css';

/** Toda história aparece no tema claro, no escuro ou nos dois lado a lado (barra de ferramentas "Tema"). */
const withTheme: Decorator = (Story, context) => {
  const mode = (context.globals['theme'] as string | undefined) ?? 'both';
  const themes = mode === 'both' ? ['light', 'dark'] : [mode];
  return (
    <TooltipProvider>
      <div className={mode === 'both' ? 'grid gap-0 md:grid-cols-2' : ''}>
        {themes.map((t) => (
          <div key={t} data-theme={t} className="bg-shell p-6 text-fg">
            <p className="mb-3 text-caption text-fg-muted">tema {t}</p>
            <Story />
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Tema',
      toolbar: {
        title: 'Tema',
        icon: 'circlehollow',
        items: [
          { value: 'both', title: 'Claro + escuro' },
          { value: 'light', title: 'Claro' },
          { value: 'dark', title: 'Escuro' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'both' },
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
};

export default preview;

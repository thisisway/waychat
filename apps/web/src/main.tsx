import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@waychat/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationsPage } from './pages/Conversations.js';
import { LoginPage } from './pages/Login.js';
import type { FilterKey } from './types.js';
import './styles.css';

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const FILTERS: FilterKey[] = ['unassigned', 'mine', 'all'];
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // conversa aberta e filtro ficam na URL: recarregar a página ou compartilhar o link mantém o contexto
  validateSearch: (s: Record<string, unknown>): { c: string | undefined; f: FilterKey } => ({
    c: typeof s['c'] === 'string' ? s['c'] : undefined,
    f: FILTERS.find((f) => f === s['f']) ?? 'all',
  }),
  component: ConversationsPage,
});

const router = createRouter({ routeTree: rootRoute.addChildren([loginRoute, homeRoute]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } },
});

const el = document.getElementById('root');
if (!el) throw new Error('#root ausente');
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

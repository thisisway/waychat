// Servidor estático mínimo, só para os testes visuais (sem dependências).
//   /storybook/*  -> packages/ui/storybook-static
//   /*            -> apps/widget/dist, tests/visual/pages e apps/web/dist (painel; rotas sem extensão caem no index.html da SPA)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new globalThis.URL('.', import.meta.url));
const storybook = join(here, '../../packages/ui/storybook-static');
const web = join(here, '../../apps/web/dist');
const roots = [join(here, '../../apps/widget/dist'), join(here, 'pages'), web];
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Caminho absoluto de um arquivo existente dentro de `root`, ou null (também barra `..`). */
function resolveIn(root, rel) {
  const file = normalize(join(root, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel));
  if (!file.startsWith(root + sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

createServer((req, res) => {
  const path = decodeURIComponent(new globalThis.URL(req.url ?? '/', 'http://x').pathname);
  const file = path.startsWith('/storybook/')
    ? resolveIn(storybook, path.slice('/storybook/'.length))
    : (roots.map((r) => resolveIn(r, path.slice(1))).find(Boolean) ??
      (extname(path) ? null : resolveIn(web, 'index.html')));
  if (!file) {
    res.writeHead(404).end('não encontrado');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`visual: http://127.0.0.1:${String(port)}\n`);
});

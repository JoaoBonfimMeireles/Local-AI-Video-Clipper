#!/usr/bin/env node
// Pré-compila as páginas e APIs do `next dev` assim que o servidor sobe, em segundo plano.
// Sem isso, cada tela é compilada só no primeiro clique e a navegação trava por vários segundos.
const base = process.env.WARMUP_URL ?? 'http://localhost:3000';

// Só GETs sem efeito colateral; ids inválidos bastam para compilar as rotas dinâmicas.
const routes = [
  '/',
  '/api/jobs',
  '/api/inputs',
  '/api/library',
  '/api/presets',
  '/jobs/_warmup',
  '/api/jobs/_warmup',
  '/limpar',
  '/api/clean',
  '/memes',
  '/api/memes',
  '/curiosidades',
  '/api/curiosities',
  '/favorites',
  '/api/favorites',
  '/library',
  '/settings',
  '/api/settings',
  '/api/references',
  '/vods/0',
  '/api/vods/0',
];

async function waitForServer() {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(base, { method: 'HEAD' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

if (await waitForServer()) {
  const t0 = Date.now();
  // Em sequência: compilar tudo em paralelo disputa CPU e atrasa a página que o usuário abriu.
  for (const route of routes) await fetch(base + route).catch(() => {});
  console.log(`Páginas pré-compiladas em ${((Date.now() - t0) / 1000).toFixed(0)} s: a navegação agora é instantânea.`);
}

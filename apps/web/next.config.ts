import path from 'node:path';
import type { NextConfig } from 'next';

// Raiz do monorepo: os pacotes em packages/* são importados por alias (tsconfig paths).
const root = path.resolve(import.meta.dirname, '../..');

// Usamos o bundler webpack (`next dev --webpack`): o Turbopack cria junctions/symlinks para
// pacotes externos, o que falha em discos exFAT/FAT32. O webpack resolve externos sem links.
const nextConfig: NextConfig = {
  // Módulo nativo: deve ser carregado pelo Node, não empacotado.
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingRoot: root,
  experimental: {
    // Permite compilar os pacotes TypeScript de ../../packages
    externalDir: true,
  },
  devIndicators: false,
  webpack: (config) => {
    // Em exFAT, readlink retorna EISDIR (e não EINVAL) para arquivos comuns, o que quebra o resolver.
    // O projeto não usa symlinks, então a resolução deles pode ser desligada.
    config.resolve.symlinks = false;
    return config;
  },
};

export default nextConfig;

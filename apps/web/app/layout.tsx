import type { Metadata } from 'next';
import Link from 'next/link';
import { Clapperboard, Eraser, Laugh, LayoutDashboard, Library, Settings, Sparkles, Star } from 'lucide-react';
import { AiUsageBadge } from '@/components/ai-usage-badge';
import './globals.css';

export const metadata: Metadata = {
  title: 'Local AI Video Clipper',
  description: 'Cortes virais automáticos, 100% local',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: extensões do navegador (ex.: ColorZilla) injetam atributos no <html>/<body>
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Clapperboard className="size-4" />
              </span>
              <span>
                Local AI <span className="text-primary">Clipper</span>
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <NavLink href="/" icon={<LayoutDashboard className="size-4" />} label="Painel" />
              <NavLink href="/limpar" icon={<Eraser className="size-4" />} label="Limpar vídeo" />
              <NavLink href="/curiosidades" icon={<Sparkles className="size-4" />} label="Curiosidades" />
              <NavLink href="/memes" icon={<Laugh className="size-4" />} label="Editor de vídeo" />
              <NavLink href="/favorites" icon={<Star className="size-4" />} label="Favoritos" />
              <NavLink href="/library" icon={<Library className="size-4" />} label="Biblioteca" />
              <NavLink href="/settings" icon={<Settings className="size-4" />} label="Configurações" />
            </nav>
            <AiUsageBadge />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href} className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      {icon}
      {label}
    </Link>
  );
}

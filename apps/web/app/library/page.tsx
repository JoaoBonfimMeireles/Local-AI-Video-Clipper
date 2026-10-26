import { LibraryPanel } from '@/components/library-panel';

export default function LibraryPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Biblioteca de memes, sons e imagens</h1>
        <p className="text-sm text-muted-foreground">
          Envie arquivos e crie pastas aqui mesmo. Cada pasta é uma categoria que a IA pode escolher (ex.: <code>humor</code>, <code>choque</code>, <code>reacoes</code>, <code>impacto</code>, <code>risadas</code>,{' '}
          <code>transicao</code>). Formatos: PNG/JPG/WEBP/GIF/MP4 para memes, MP3/WAV/OGG para sons.
        </p>
      </div>
      <LibraryPanel detailed />
    </div>
  );
}

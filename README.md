# Local AI Video Clipper

App **100% local** que recebe vídeos longos (30min+), transcreve com `faster-whisper`, escolhe os trechos com maior potencial viral e renderiza cortes prontos com **legendas dinâmicas (estilo Hormozi)**, **zooms punch-in**, **memes** e **efeitos sonoros** da sua biblioteca local.

- Dashboard: <http://localhost:3000>
- Sem SaaS obrigatório: a seleção funciona em modo **heurístico local**; Gemini, Anthropic ou **Ollama** (local) são opcionais.

## Início rápido

```bash
npm install                 # dependências Node (Next.js, SQLite, Zod…)
npm run setup:python        # cria .venv com faster-whisper + OpenCV
npm run setup:cuda          # (opcional) cuBLAS/cuDNN para Whisper na GPU NVIDIA
npm run check-env           # valida Node, FFmpeg, Python, GPU/CUDA
npm run setup:samples       # (opcional) memes/sons de exemplo gerados pelo FFmpeg
npm run dev                 # sobe o dashboard (Next.js) + worker
```

Pré-requisitos: Node.js 20+, FFmpeg "full" (com libass) e Python 3.10+.
No Windows: `winget install Gyan.FFmpeg` e `winget install Python.Python.3.12`.
O app encontra o FFmpeg instalado pelo winget mesmo que o terminal ainda não tenha o PATH atualizado.

Para gerar um vídeo de teste (fala sintetizada pela voz pt-BR do Windows):

```bash
npx tsx scripts/make-test-video.ts
```

## Como funciona

```
Upload → [1] FFprobe → [2] faster-whisper (palavra a palavra) → [3] frames (cena/picos/silêncio)
       → [4] seleção (LLM ou heurística) → [5] plano de edição (JSON validado por Zod)
       → [6] legendas antigas (OpenCV + blur) / tradução → [7] FFmpeg → [8] data/output
```

| Etapa | Implementação |
| --- | --- |
| Fila | Tabela `jobs` no SQLite (`better-sqlite3`, WAL). Worker em processo separado (`apps/web/worker`), um job por vez. |
| Recuperação | Cada etapa grava cache em `data/temp/<job>/`. Se o worker cair, o job volta para a fila e retoma de onde parou. |
| Transcrição | `packages/ai-providers/python/transcribe.py` — CUDA (`int8_float16`) com fallback automático para CPU (`int8`). |
| Seleção | LLM recebe a transcrição + frames; resposta validada com Zod, ajustada para não cortar frases e deduplicada (NMS). Sem LLM: pontuação por ganchos, emoção, perguntas, números, energia do áudio. |
| Plano | Zooms, memes, SFX e palavras de ênfase por corte. Limites por intensidade. Arquivos só são aceitos se existirem no índice da biblioteca. |
| Render | Filtergraph FFmpeg: 9:16 com fundo desfocado / recorte / 1:1, punch-in zooms, overlays com fade, mix de SFX, legendas ASS. NVENC opcional (cai para x264 se falhar). |

### Saída

```
data/output/<nome_do_video>/
├── clips/
│   ├── clip_001.mp4      # vídeo final
│   ├── clip_001.srt      # legenda (idioma original)
│   ├── clip_001.<lang>.srt  # legenda traduzida (se ativada)
│   ├── clip_001.json     # metadados: nota, motivo, plano de edição aplicado…
│   └── clip_001.jpg      # thumbnail
├── metadata.json         # resumo do job
├── transcript.json
└── transcript.srt
```

## Biblioteca local

Cada subpasta é uma **categoria** que a IA pode escolher:

```
data/memes/humor | choque | reacoes | <sua_categoria>   (PNG, JPG, WEBP, GIF, MP4)
data/audio/impacto | risadas | transicao | <sua_categoria>   (MP3, WAV, OGG)
data/images/<categoria>                                 (stickers / imagens de apoio)
```

## Provedores de IA

Em **Configurações** (ou `.env.local` na raiz, veja `.env.example`):

| Provedor | Uso |
| --- | --- |
| Heurístico | Padrão, offline. Seleção e plano por regras. Não traduz. |
| Gemini | `GEMINI_API_KEY`, modelo padrão `gemini-2.5-flash`. Multimodal. |
| Anthropic | `ANTHROPIC_API_KEY`, modelo padrão `claude-sonnet-5-5`. Multimodal. |
| Ollama | `http://127.0.0.1:11434`, modelo padrão `llama3`. Transcrições longas são divididas em blocos. |

Se a IA falhar ou responder um JSON inválido (após uma tentativa de correção), o pipeline usa a heurística local em vez de falhar.

## Segurança

- Nenhum comando passa por shell: FFmpeg/Python são executados com `spawn(..., { shell: false })` e argumentos em array.
- Respostas da IA são validadas com Zod (tempos, escalas, posições, nomes) antes de virar filtro FFmpeg; números são reformatados, nunca interpolados como texto.
- Memes/sons só podem ser arquivos presentes no índice escaneado de `data/` (sem path traversal).
- `/api/files` serve apenas arquivos dentro de `data/output`; uploads só gravam em `data/input`.
- Chaves de API ficam em `.env.local` e nunca são enviadas ao navegador.
- Falha em um corte não cancela os demais; `data/temp/<job>` é limpo após sucesso.

## Estrutura

```
apps/web/                 Next.js (App Router, Tailwind, componentes estilo shadcn/ui) + worker
packages/shared/          tipos, SQLite, caminhos, env, execução segura de processos
packages/ai-providers/    Whisper (Python), Gemini / Anthropic / Ollama, tradução
packages/video-processing FFprobe, áudio, frames, legendas ASS/SRT, renderização
packages/clip-selection/  frases, pontuação heurística, seleção sem redundância
packages/editing-planner/ schemas Zod, prompts, plano heurístico, resolução de assets
scripts/                  check-env, setup-python, assets de exemplo, vídeo de teste
```

### Notas para discos exFAT/FAT32

O projeto roda em discos sem suporte a symlinks:

- não usa npm workspaces — os pacotes são resolvidos por aliases do `tsconfig` (`@clipper/*`);
- o Next usa o bundler webpack (`--webpack`), pois o Turbopack cria junctions;
- o Next é iniciado por `scripts/run-next.js`, que pré-carrega `scripts/exfat-fs-shim.cjs`: no exFAT,
  `fs.readlink` retorna `EISDIR` (em vez de `EINVAL`) para arquivos comuns, o que quebra o webpack.

### Testes

```bash
npm run typecheck   # TypeScript de pacotes, worker, scripts e app
npm run test:e2e    # pipeline completo com o vídeo de teste e validação dos arquivos gerados
```

> Desempenho: rodando dentro de alguns ambientes (ex.: painel de preview de apps desktop) a transcrição
> na GPU pode ficar várias vezes mais lenta por disputa com a renderização da interface. No terminal
> comum, o vídeo de teste (2min23s) leva ~3 min de ponta a ponta numa GTX 1650.

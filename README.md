# Local AI Video Clipper

App **100% local** que recebe vídeos longos (30min+), transcreve com `faster-whisper`, escolhe os trechos com maior potencial viral e renderiza cortes prontos com **legendas dinâmicas (estilo Hormozi)**, **zooms punch-in**, **memes** e **efeitos sonoros** da sua biblioteca local.

- Dashboard: <http://localhost:3000>
- IA padrão: **Gemini 3 Flash** (tem plano gratuito). Sem chave, o app usa a seleção **heurística local**. Anthropic e Ollama também são suportados.

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
| Gemini (padrão) | `GEMINI_API_KEY`. Planos abaixo. Multimodal (transcrição + frames). |
| Heurístico | Offline, sem chave. Seleção e plano por regras. Não traduz nem gera hashtags. |
| Anthropic (recomendado para qualidade) | `ANTHROPIC_API_KEY`. **Claude Opus 5.5** escolhe os cortes (raciocínio alto, transcrição completa junto) e **Claude Sonnet 5.5** faz edição, títulos e tradução. Streaming, novas tentativas automáticas e custo estimado no log. |
| Ollama | `http://127.0.0.1:11434`, modelo padrão `llama3`. Transcrições longas são divididas em blocos. |

### Planos do Gemini

| Plano | Cortes | Edição, memes, sons, títulos, hashtags, tradução | Custo estimado* |
| --- | --- | --- | --- |
| Gratuito | `gemini-3-flash-preview` | `gemini-3-flash-preview` | US$ 0 (limites por minuto/dia; o Google pode usar os dados) |
| Pago | `gemini-3-flash-preview` | `gemini-3-flash-preview` | ~US$ 10–25/mês |
| Combinado | `gemini-3.1-pro-preview` (raciocínio alto) | `gemini-3-flash-preview` (raciocínio baixo) | ~US$ 30–60/mês |

\* ~3 vídeos/dia. Os modelos são editáveis e o botão "Listar modelos" mostra os disponíveis para a sua chave.
Cada job registra tokens usados e custo estimado. No plano gratuito o app espaça as chamadas (~8/min) e respeita o `retryDelay` dos erros 429.

### Cota gratuita

O plano gratuito do `gemini-3-flash-preview` permite **20 requisições por dia**. Quando acaba, o app usa
automaticamente o **modelo reserva** (padrão `gemini-3.1-flash-lite`, cota própria) e avisa no log.
Um vídeo novo usa ~4–6 chamadas; reprocessar o mesmo vídeo usa ~2 (graças ao cache abaixo).

### Cache de conhecimento do vídeo

Na primeira vez, a IA analisa o vídeo (resumo, pessoas e posição no quadro, momentos com nota) e isso fica
em `data/cache/transcripts/<id>.knowledge.json`, junto da transcrição e do texto em português. Reprocessar o
mesmo arquivo com outra edição não reenvia transcrição nem frames: a seleção usa só essa análise.
A seleção pode **juntar trechos distantes** num mesmo corte (até 4, em qualquer ordem — ex.: a conclusão como gancho).

### Enquadramento e legenda antiga

- **Quem fala:** a IA decide quem/o que enquadrar a cada momento (vendo frames + transcrição); a detecção local de
  rostos (YuNet, OpenCV) corrige a posição e os cortes de câmera do vídeo original são respeitados.
- **Pessoa inteira:** a janela só é usada se couber a cabeça com folga e os ombros; senão reduz a aproximação ou
  abre o plano (só a faixa onde estão as pessoas).
- **Legenda antiga** (ligada por padrão): "Recortar fora" enquadra sem a faixa da legenda (imagem 100% real);
  "Apagar e preencher" remove o texto e reconstrói o fundo (útil para legenda no meio da tela; pode deixar marcas).
- **Texto em português:** `transcricao_pt.txt` em toda saída (só texto, gerado uma vez por vídeo).
- **Créditos:** campos de título/canal/link do vídeo original (Creative Commons) no formulário; a linha de créditos
  vai ao fim de cada descrição.

### Modo Twitch (lives)

No formulário, escolha **Live da Twitch**. Muda o olhar da IA e a edição:

- **Análise como espectador de live:** mapeia a live inteira em momentos com tipo e **assunto**. Os cortes são
  separados por categoria (mais engraçados, tensos/assustadores, interação com o chat, zoeira entre pessoas, falas
  marcantes, jogadas, reações) e pode haver um corte **Top da live** (3 a 5 melhores momentos, cada um com o contexto que levou a ele;
  se não houver 3 momentos bons, não é feito).
- **Quantidade pela qualidade:** a IA faz quantos cortes o material merece (nota ≥ 70) — vídeo curto ou fraco gera 1–3,
  live longa e rica pode gerar dezenas. Ela usa um repertório de formatos virais (contexto → reação, storytime, fail,
  treta, plot twist, pergunta do chat…) e cada corte precisa de gancho, contexto e desfecho.
- **Sem frase pela metade:** se o corte acabaria num "mas", "aí", "que…" ou sem pontuação final, ele é estendido até o
  pensamento fechar.
- **Recorte por assunto:** até 8 trechos por corte. Se o streamer fala de "banana", desvia para "maçã" e volta, o corte
  junta só os trechos de "banana". Tempo morto é cortado.
- **Layout facecam + jogo:** se houver facecam fixa num canto (detectada automaticamente), o vertical vira câmera em
  cima e jogo embaixo, com a legenda na emenda. Em **react**, a área do vídeo assistido é detectada pelo movimento e vai
  inteira embaixo, sem nenhum pedaço da câmera. Para IRL/sem facecam, usa o enquadramento por pessoas.
  - **Câmera do streamer sempre inteira:** o retângulo exato da facecam (em qualquer canto, e o layout pode mudar
    durante a live) é medido em cada corte pela moldura fixa em volta do rosto; ela ocupa toda a largura do topo, na
    proporção da própria câmera — sem faixa vazia e sem cortar a pessoa.
  - **Só o vídeo assistido:** em react de post do Instagram/Facebook/YouTube, o player é encontrado (região que muda,
    encaixada nas bordas fixas) e só ele aparece embaixo, ampliado e centralizado — sem página, comentários ou espaço
    em branco. Sem player claro, o conteúdo aparece inteiro com desfoque nas sobras (nunca um zoom exagerado).
- **Memes green screen** (ex.: Green Screen Memes): vídeos com fundo verde são detectados e recortados (chroma key) por
  cima do vídeo; memes com áudio entram na mixagem e o som da live abaixa enquanto tocam. Sons (ex.: myinstants) vão em
  `data/audio/<categoria>`. A IA recebe duração, áudio e fundo verde de cada arquivo da biblioteca.
- O cache de conhecimento do modo Twitch é separado do modo YouTube (análises diferentes do mesmo arquivo).

### Painel do vídeo (trecho e áreas marcadas à mão)

Ao escolher o vídeo, o formulário mostra um player para assistir tudo e:

- **Marcar o trecho** (início/fim) em que a IA deve procurar os cortes — ela só analisa e só corta dentro dele.
- **Desenhar a câmera do streamer**: retângulo, ou círculo no rosto com duas opções — *expandir* até o quadradinho
  inteiro (ocupa o topo) ou *só o rosto* num círculo com aro branco no canto superior, sobre o conteúdo em tela cheia.
- **Desenhar a área do conteúdo** do react. Com **dinâmico** ligado, a IA foca nesse player e analisa cada corte em
  janelas de ~4s: se o conteúdo crescer bem além da área marcada (o streamer pôs o vídeo em tela cheia), o
  enquadramento passa para a área nova naquele trecho e volta ao quadradinho depois. Trocas de menos de ~8s são
  ignoradas, para não ficar piscando.
- **Acompanhar**: com a chave ligada, a IA ajusta perto do que foi marcado se a pessoa ou o player mudarem de lugar
  (em cada corte); desligada, usa exatamente a área desenhada.

Lives baixadas da Twitch costumam vir em MPEG-TS com extensão .mp4 (o navegador não toca): na primeira vez o app
gera uma versão leve de prévia (360p, em `data/cache/previews`) — alguns minutos para 1h de live; depois é imediato.
O corte final sempre usa o vídeo original.

### Faixa de ouro dos Shorts

A duração padrão é 25s e a IA escolhe, para cada corte, um de dois formatos: **loop** (15-20s: gancho → entrega →
frase final que se conecta com a primeira) ou **story** (20-40s: gancho de curiosidade → conflito acelerado →
clímax → desfecho seco, sem "se inscreva"). O corte começa na palavra mais forte (sem saudação), a intensidade média
troca o enquadramento a cada ~3s com whoosh/pop nas emendas, e o título tem menos de 50 caracteres; o metadata do
corte traz `shortFormat` e `coverText` (texto sugerido para a capa).

### Versão em mandarim e legendas em 4 idiomas

Todo corte com legenda queimada ganha também `clip_NNN.zh.mp4`: a mesma edição (enquadramento, memes, sons, pausas),
só que com a legenda em **chinês simplificado**. Além disso, cada corte exporta as legendas em **português, inglês,
espanhol e chinês**, nos formatos aceitos pelo YouTube Studio:

- **SBV** (`clip_NNN.pt.sbv`…): `0:01:05.250,0:01:08.000` + texto (hora:minuto:segundo.milissegundo);
- **SRT** (`clip_NNN.pt.srt`…): `00:01:05,250 --> 00:01:08,000` + texto.

Os tempos já consideram as pausas dos efeitos sonoros. A tradução é por bloco de legenda, uma chamada por idioma para
todos os cortes (barata, em cache). No card do corte (e nos Favoritos) aparecem o botão **MP4 中文** e os links SRT/SBV
de cada idioma. Sem provedor de IA, só o idioma original é exportado.

### Favoritos

Clique na **estrela** de um corte pronto para guardá-lo na aba **Favoritos**. O favorito é uma **cópia independente**
(em `data/favorites/<id>`: vídeo, capa, SRT, metadados e transcrição), então reprocessar ou excluir o job não o afeta.
Cada favorito mostra a data e a hora em que foi favoritado, a descrição/hashtags, os memes e sons usados, e aceita
**pedido de ajuste** direto nele (a nova versão fica na pasta do favorito). Dá para filtrar por período e buscar por texto.

### Sons sem atropelar a fala

Efeitos sonoros não tocam mais por cima da voz: no ponto do som (sempre no fim de uma palavra) o vídeo **pausa**
(quadro congelado), o som toca sozinho e o vídeo continua. No máximo 3 pausas por corte; o SRT acompanha o novo tempo.
Memes ficam sempre inteiros dentro do quadro (os de baixo encostam a base na borda, nunca aparecem pela metade).

### Clipes de referência (guia de estilo)

Coloque cortes virais do seu nicho em `data/references/` (lives de jogos, conversa com o público, react…). Cada clipe
é analisado **uma vez** — transcrição local, métricas de ritmo (cortes/min, palavras/s, picos de volume) e uma chamada
pequena de IA (~5 mil tokens) que descreve a fórmula: gancho, estrutura, ritmo, humor, edição, legendas e final.
As análises viram um **guia de estilo** compacto (em cache) que entra na escolha dos momentos, no plano de edição e nos
ajustes. Em **Configurações → Clipes de referência** dá para ligar/desligar, ver o guia e "Analisar agora"; clipes novos
também são analisados automaticamente no próximo processamento. Use os clipes só como referência privada de estudo.

### Ajustar um corte pronto

Na página do job, cada corte mostra os memes e sons usados e tem **"Pedir ajuste neste corte"**: descreva a mudança
(trocar/tirar meme, começar antes, título…) e só aquele corte é refeito (~1 chamada pequena de IA), salvo como
`clip_NNN_vN.mp4` — a versão anterior fica na pasta.

### Biblioteca grande numa pasta só

Pode jogar milhares de memes direto em `data/memes/` e sons em `data/audio/`, sem subpastas. A cada job:

1. Os nomes são limpos e decodificados (`Ai-cat-laughing-Meme-Green-Screen.mp4` → "Ai cat laughing"; nomes `%D0%...`
   viram texto legível) e comparados com o que acontece nos cortes (fala, análise, categoria — com tradução de
   conceitos PT→EN como risada→laugh, susto→scared).
2. Só os ~70 memes e ~60 sons mais relevantes são analisados (duração, áudio, fundo verde; com cache) e entram no
   prompt num **catálogo compacto com códigos** (`m12: Cat shocked (2.1s, com áudio, fundo verde)`). Sons longos
   (músicas, > 8s) ficam de fora e cada efeito toca no máximo ~5s com fade.
3. A IA só usa um meme/som se o nome combinar com o momento e justifica em `reason`; código inexistente é corrigido
   para o nome mais parecido ou descartado (nunca é sorteado um aleatório).
4. Para memes com áudio a IA decide `audioMode`: **meme** (só o som do meme), **video** (meme mudo, fica a fala) ou
   **both** (os dois, vídeo a 30%).

Imagens estáticas não são usadas nas edições (só memes em vídeo e sons).

**Economia de tokens:** a análise do vídeo (resumo + momentos) fica em cache e substitui transcrição e frames nas
seleções seguintes; o plano envia 8 frames por corte (a posição exata vem da detecção local de rostos) e só o catálogo
pré-selecionado da biblioteca.

### Diretrizes editoriais

Em **Configurações → Diretrizes editoriais da IA** você descreve como a IA deve escolher trechos, editar,
destacar palavras e escrever títulos/hashtags. O texto entra no prompt de sistema de todas as chamadas
(seleção, edição e tradução), com prioridade sobre o estilo padrão; os limites técnicos continuam valendo.

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

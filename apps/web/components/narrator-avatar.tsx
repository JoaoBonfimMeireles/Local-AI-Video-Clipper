'use client';
import { useState } from 'react';
// Narrador (apresentador de terno, óculos redondos e barba). Reserva em SVG: mesmo desenho de
// packages/ai-providers/python/narrator_sprites.py, usado quando não há ilustração em data/narrator.

const pts = (a: [number, number][]) => a.map(([x, y]) => `${x},${y}`).join(' ');

/**
 * Narrador do painel: os mesmos sprites do render (vindos de data/narrator/apresentador.png quando existe).
 * As 6 imagens ficam carregadas e só a do estado atual aparece, para a boca trocar sem piscar.
 */
export function NarratorAvatar({ mouth = 0, blink = false, className }: { mouth?: 0 | 1 | 2; blink?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <NarratorAvatarSvg mouth={mouth} blink={blink} className={className} />;
  return (
    <span className={`relative inline-grid ${className ?? ''}`}>
      {[0, 1, 2].flatMap((m) =>
        [0, 1].map((e) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${m}${e}`}
            src={`/api/narrator?m=${m}&e=${e}`}
            alt={m === 0 && e === 0 ? 'Narrador' : ''}
            onError={() => setFailed(true)}
            className="col-start-1 row-start-1 h-full w-full object-contain"
            style={{ visibility: m === mouth && e === (blink ? 1 : 0) ? 'visible' : 'hidden' }}
          />
        )),
      )}
    </span>
  );
}

function NarratorAvatarSvg({ mouth = 0, blink = false, className }: { mouth?: 0 | 1 | 2; blink?: boolean; className?: string }) {
  const lift = mouth === 2 ? 3 : 0;
  const oh = mouth === 1 ? 7 : 13;
  const ink = '#181c28';
  return (
    <svg viewBox="0 0 360 420" className={className} aria-label="Narrador">
      <polygon points={pts([[20, 420], [30, 330], [70, 292], [145, 270], [215, 270], [290, 292], [330, 330], [340, 420]])} fill="#28465c" stroke={ink} strokeWidth="3" />
      <polygon points={pts([[148, 270], [212, 270], [198, 360], [180, 380], [162, 360]])} fill="#c4deee" />
      <polygon points={pts([[172, 292], [188, 292], [194, 370], [180, 388], [166, 370]])} fill="#6e285a" />
      <polygon points={pts([[170, 278], [190, 278], [188, 294], [172, 294]])} fill="#6e285a" />
      <polygon points={pts([[148, 270], [122, 300], [158, 320], [166, 380]])} fill="#1e3446" stroke={ink} strokeWidth="2.5" />
      <polygon points={pts([[212, 270], [238, 300], [202, 320], [194, 380]])} fill="#1e3446" stroke={ink} strokeWidth="2.5" />
      <circle cx="238" cy="330" r="8" fill="none" stroke="#ebd7b4" strokeWidth="2" />
      <polygon points={pts([[238, 323], [241, 330], [238, 337], [235, 330]])} fill="#ebd7b4" />
      <polygon points={pts([[40, 380], [300, 372], [320, 400], [60, 412]])} fill="#1e3446" stroke={ink} strokeWidth="2.5" />
      <ellipse cx="300" cy="386" rx="18" ry="12" transform="rotate(-8 300 386)" fill="#deac8a" stroke={ink} strokeWidth="2" />
      <polygon points={pts([[160, 225], [200, 225], [204, 275], [180, 286], [156, 275]])} fill="#c4916e" />
      <ellipse cx="106" cy="158" rx="12" ry="20" fill="#deac8a" />
      <ellipse cx="254" cy="158" rx="12" ry="20" fill="#deac8a" />
      <polygon points={pts([[110, 120], [250, 120], [252, 190], [232, 238], [200, 262], [160, 262], [128, 238], [108, 190]])} fill="#deac8a" />
      <polygon points={pts([[110, 185], [128, 236], [160, 262], [200, 262], [232, 236], [250, 185], [242, 222], [215, 240], [180, 246], [145, 240], [118, 222]])} fill="#6e5546" />
      <ellipse cx="180" cy="222" rx="34" ry="9" fill="#6e5546" />
      <polygon points={pts([[110, 120], [250, 120], [252, 190], [232, 238], [200, 262], [160, 262], [128, 238], [108, 190]])} fill="none" stroke={ink} strokeWidth="3" />
      <polygon points={pts([[104, 140], [100, 90], [125, 55], [175, 40], [230, 48], [262, 82], [258, 140], [246, 108], [215, 92], [165, 96], [124, 112]])} fill="#161e30" />
      <path d={`M128 ${138 - lift} L164 ${134 - lift} M196 ${134 - lift} L232 ${138 - lift}`} stroke="#161e30" strokeWidth="6" strokeLinecap="round" />
      {[147, 213].map((ex) =>
        blink ? (
          <path key={ex} d={`M${ex - 10} 161 H${ex + 10}`} stroke={ink} strokeWidth="3" />
        ) : (
          <g key={ex}>
            <ellipse cx={ex} cy="160" rx="10" ry="7" fill="#f5f5f5" />
            <circle cx={ex} cy="160" r="5.5" fill={ink} />
            <circle cx={ex + 2} cy="158" r="1.6" fill="#fff" />
          </g>
        ),
      )}
      <g fill="none" stroke={ink} strokeLinecap="round">
        <circle cx="147" cy="160" r="23" strokeWidth="3.5" />
        <circle cx="213" cy="160" r="23" strokeWidth="3.5" />
        <path d="M170 158 H190 M124 156 L108 150 M236 156 L252 150" strokeWidth="3" />
        <path d="M180 168 L174 196 L184 198" stroke="#c4916e" strokeWidth="3" />
      </g>
      {mouth === 0 ? (
        <path d="M161 225 Q180 232 199 225" fill="none" stroke={ink} strokeWidth="3.5" strokeLinecap="round" />
      ) : (
        <g>
          <ellipse cx="180" cy="226" rx="22" ry={oh} fill="#6e2832" />
          <path d={`M162 ${226 - oh * 0.45} A18 ${oh * 0.45} 0 0 1 198 ${226 - oh * 0.45} Z`} fill="#faf5f5" />
          <ellipse cx="180" cy="226" rx="22" ry={oh} fill="none" stroke={ink} strokeWidth="3" />
        </g>
      )}
    </svg>
  );
}

"""Encontra o retângulo da FACECAM (o quadradinho do streamer) em frames de um corte de live/react.

Uso: python detect_cam.py <cx> <cy> <fw> <fh> frame1.jpg frame2.jpg ...
  (cx, cy, fw, fh) = centro e tamanho do rosto do streamer, em frações do quadro.
Saída (stdout, última linha): {"box": {"x0":..,"y0":..,"x1":..,"y1":..}, "method": "..."}

Como funciona: a borda da câmera é uma linha reta e FIXA (aparece igual em todos os frames) e separa duas regiões
diferentes: dentro, o quarto do streamer quase parado; fora, o conteúdo que muda (vídeo, página). Para cada lado,
procura a partir do rosto, para fora, a primeira linha longa com borda constante OU com salto de movimento.
Se não houver borda (câmera colada na lateral do quadro), usa a própria borda do quadro.
"""
import json
import sys

import cv2
import numpy as np

W, H = 320, 180


def main():
    cx, cy, fw, fh = (float(v) for v in sys.argv[1:5])
    paths = sys.argv[5:]
    frames = []
    for p in paths:
        img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
        if img is not None:
            frames.append(cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32))
    if len(frames) < 3:
        print(json.dumps({"box": None, "method": "poucos frames"}))
        return
    F = np.stack(frames)
    std = F.std(axis=0)
    # Fração dos frames em que há borda forte em cada pixel (bordas fixas = moldura da câmera, layout)
    gx = np.mean([np.abs(cv2.Sobel(f, cv2.CV_32F, 1, 0, ksize=3)) > 60 for f in frames], axis=0)
    gy = np.mean([np.abs(cv2.Sobel(f, cv2.CV_32F, 0, 1, ksize=3)) > 60 for f in frames], axis=0)

    fx0, fx1 = (cx - fw / 2) * W, (cx + fw / 2) * W
    fy0, fy1 = (cy - fh / 2) * H, (cy + fh / 2) * H
    pw, ph = fw * W, fh * H

    M = F.mean(axis=0)
    pcx, pcy = cx * W, cy * H

    def side_stats(a, b):
        """Diferença entre as faixas de dentro (a) e de fora (b): brilho por linha e movimento."""
        contrast = float(np.clip(np.mean(np.abs(a[0] - b[0])) / 90.0, 0, 1))
        jump = float(np.clip((b[1].mean() - a[1].mean()) / 15.0, 0, 1))
        return contrast, jump

    def vscore(x, y0, y1, outside):
        """Linha vertical em x. outside=-1: o lado de fora fica à esquerda."""
        y0, y1 = max(0, int(y0)), min(H, int(y1))
        if y1 - y0 < 4 or x < 8 or x > W - 9:
            return 0.0, 0.0
        cont = float(np.mean(gx[y0:y1, x - 1:x + 2].max(axis=1) > 0.55))
        L = (M[y0:y1, x - 7:x - 2].mean(axis=1), std[y0:y1, x - 7:x - 2])
        R = (M[y0:y1, x + 3:x + 8].mean(axis=1), std[y0:y1, x + 3:x + 8])
        inside, out = (R, L) if outside < 0 else (L, R)
        contrast, jump = side_stats(inside, out)
        return 0.9 * cont + jump + 0.5 * contrast, cont

    def hscore(y, x0, x1, outside):
        x0, x1 = max(0, int(x0)), min(W, int(x1))
        if x1 - x0 < 4 or y < 8 or y > H - 9:
            return 0.0, 0.0
        cont = float(np.mean(gy[y - 1:y + 2, x0:x1].max(axis=0) > 0.55))
        T = (M[y - 7:y - 2, x0:x1].mean(axis=0), std[y - 7:y - 2, x0:x1])
        B = (M[y + 3:y + 8, x0:x1].mean(axis=0), std[y + 3:y + 8, x0:x1])
        inside, out = (B, T) if outside < 0 else (T, B)
        contrast, jump = side_stats(inside, out)
        return 0.9 * cont + jump + 0.5 * contrast, cont

    def best_line(lo, hi, edge, fn, near):
        """Borda da câmera na janela [lo, hi]. Prioridade: linha FIXA de ponta a ponta (presente em ~todos os
        frames) que separa regiões diferentes, a mais perto do rosto; senão, a melhor separação; a borda do
        quadro entra como candidata quando a janela chega nela."""
        lo, hi = int(max(0, lo)), int(min(hi, W if edge is None else max(hi, 0)))
        lines = [(p,) + tuple(fn(p)) for p in range(lo, hi + 1)]
        solid = [c for c in lines if c[2] >= 0.85]
        if solid:
            top = max(c[1] for c in solid)
            close = [c for c in solid if c[1] >= 0.97 * top]
            return min(close, key=lambda c: abs(c[0] - near))[0], top
        cands = [(c[0], c[1]) for c in lines] + ([(edge, 0.85)] if edge is not None else [])
        if not cands:
            return None, 0
        p, s = max(cands, key=lambda c: c[1])
        return (p if s >= 0.55 else None), s

    # Faixa inicial: um pouco acima do rosto até o peito
    y0, y1 = max(0, fy0 - ph * 0.8), min(H, fy1 + ph * 1.8)
    x0, x1 = 0.0, float(W)
    for _ in range(3):
        l, _s = best_line(pcx - pw * 4.5, fx0 - pw * 0.9, 0 if pcx - pw * 4.5 <= 8 else None, lambda x: vscore(x, y0, y1, -1), fx0)
        if l is None and pcx - pw * 4.5 <= 8:
            l = 0
        r, _s = best_line(fx1 + pw * 0.9, pcx + pw * 4.5, W if pcx + pw * 4.5 >= W - 8 else None, lambda x: vscore(x, y0, y1, 1), fx1)
        if r is None and pcx + pw * 4.5 >= W - 8:
            r = W
        x0 = float(l) if l is not None else max(0.0, pcx - pw * 2.5)
        x1 = float(r) if r is not None else min(float(W), pcx + pw * 2.5)
        t, _s = best_line(pcy - ph * 2.5, fy0 - ph * 0.4, 0 if pcy - ph * 2.5 <= 8 else None, lambda y: hscore(y, x0 + 2, x1 - 2, -1), fy0)
        if t is None and pcy - ph * 2.5 <= 8:
            t = 0
        b, _s = best_line(fy1 + ph * 0.5, pcy + ph * 4.2, H if pcy + ph * 4.2 >= H - 8 else None, lambda y: hscore(y, x0 + 2, x1 - 2, 1), fy1)
        if b is None and pcy + ph * 4.2 >= H - 8:
            b = H
        y0 = float(t) if t is not None else max(0.0, pcy - ph * 1.5)
        y1 = float(b) if b is not None else min(float(H), pcy + ph * 2.5)
        # Linha encostada na borda do quadro = a própria borda
        if x0 <= 8: x0 = 0.0
        if x1 >= W - 9: x1 = float(W)
        if y0 <= 8: y0 = 0.0
        if y1 >= H - 9: y1 = float(H)

    w, h = x1 - x0, y1 - y0
    ok = w >= pw * 2.4 and h >= ph * 2.0 and 0.7 <= w / max(1, h) <= 2.8 and w * h < W * H * 0.7
    if not ok:
        # Sem moldura confiável: câmera 16:9 típica, rosto ocupando ~20% da largura, um pouco acima do centro
        cw = min(W, pw * 5.0)
        chh = min(H, cw * 9 / 16)
        x0 = min(max(0, (fx0 + fx1) / 2 - cw / 2), W - cw)
        y0 = min(max(0, (fy0 + fy1) / 2 - chh * 0.42), H - chh)
        x1, y1 = x0 + cw, y0 + chh
        method = "estimado pelo rosto"
    else:
        method = "moldura detectada"
    print(json.dumps({"box": {"x0": x0 / W, "y0": y0 / H, "x1": x1 / W, "y1": y1 / H}, "method": method}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"box": None, "method": f"erro: {e}"}))

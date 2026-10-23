"""Encontra o PLAYER do vídeo que o streamer está assistindo (post do Instagram/Facebook, vídeo do YouTube/TikTok)
dentro da tela, para enquadrar só ele — sem a página, comentários e espaços em branco em volta.

Uso: python detect_player.py <x0> <y0> <x1> <y1> frame1.jpg frame2.jpg ...
  (x0..y1) = caixa da facecam a ignorar, em frações do quadro (use -1 -1 -1 -1 se não houver).
Saída (última linha): {"box": {"x0":..,"y0":..,"x1":..,"y1":..} | null, "score": ..}

Como funciona: o player é um retângulo de bordas FIXAS (iguais em todos os frames) e, dentro dele, a imagem muda
mais do que em volta (a página ao redor fica parada). Procura retângulos nas bordas fixas e fica com o que tem mais
movimento por dentro em relação ao entorno.
"""
import json
import sys

import cv2
import numpy as np

W, H = 320, 180


def main():
    ex = [float(v) for v in sys.argv[1:5]]
    paths = sys.argv[5:]
    frames = []
    for p in paths:
        img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
        if img is not None:
            frames.append(cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA))
    if len(frames) < 3:
        print(json.dumps({"box": None, "score": 0}))
        return
    F = np.stack(frames).astype(np.float32)
    std = F.std(axis=0)
    cam = None
    if ex[0] >= 0:
        cam = (int(ex[0] * W), int(ex[1] * H), int(np.ceil(ex[2] * W)), int(np.ceil(ex[3] * H)))
        std[max(0, cam[1] - 3):cam[3] + 3, max(0, cam[0] - 3):cam[2] + 3] = 0

    free = np.ones((H, W), bool)
    if cam:
        free[max(0, cam[1] - 3):cam[3] + 3, max(0, cam[0] - 3):cam[2] + 3] = False
    free_area = float(free.sum())
    vals = std[free]
    if vals.size == 0 or float(np.percentile(vals, 95)) < 4:
        print(json.dumps({"box": None, "score": 0}))
        return
    # Pixels que mudam de verdade (limiar relativo ao que mais muda), juntos num bloco
    thr = max(5.0, 0.22 * float(np.percentile(vals, 95)))
    moving = ((std > thr) & free).astype(np.uint8)
    moving = cv2.morphologyEx(moving, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    moving = cv2.morphologyEx(moving, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(moving, 8)
    if n <= 1:
        print(json.dumps({"box": None, "score": 0}))
        return
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, area = (int(v) for v in stats[i])
    if area < free_area * 0.05:
        print(json.dumps({"box": None, "score": 0}))
        return
    # Corta as bordas ralas (linhas/colunas com pouco movimento) para o retângulo justo do player
    comp = labels[y:y + h, x:x + w] == i
    cols = comp.mean(axis=0) > 0.25
    rows = comp.mean(axis=1) > 0.25
    if cols.any() and rows.any():
        cx = np.where(cols)[0]
        ry = np.where(rows)[0]
        x, w = x + int(cx[0]), int(cx[-1] - cx[0] + 1)
        y, h = y + int(ry[0]), int(ry[-1] - ry[0] + 1)
    # Encaixa cada lado na borda FIXA do player mais próxima (partes paradas do vídeo também são do player;
    # sobras de movimento fora dele ficam de fora)
    edges = np.mean([cv2.Canny(f, 40, 120) > 0 for f in frames], axis=0) >= 0.7
    if cam:
        edges[max(0, cam[1] - 5):cam[3] + 5, max(0, cam[0] - 5):cam[2] + 5] = False
    x0, y0, x1, y1 = x, y, x + w, y + h

    def snap_v(pos, ya, yb):
        """Borda vertical fixa mais próxima de `pos` (até 25% da largura)."""
        cands = []
        for c in range(max(1, pos - int(W * 0.25)), min(W - 1, pos + int(W * 0.25))):
            fr = float(edges[ya:yb, max(0, c - 1):c + 2].max(axis=1).mean()) if yb > ya else 0.0
            if fr >= 0.6:
                cands.append(c)
        return min(cands, key=lambda c: abs(c - pos)) if cands else pos

    def snap_h(pos, xa, xb):
        """Borda horizontal fixa mais próxima de `pos` (até 25% da altura)."""
        cands = []
        for r in range(max(1, pos - int(H * 0.25)), min(H - 1, pos + int(H * 0.25))):
            fr = float(edges[max(0, r - 1):r + 2, xa:xb].max(axis=0).mean()) if xb > xa else 0.0
            if fr >= 0.6:
                cands.append(r)
        return min(cands, key=lambda r: abs(r - pos)) if cands else pos

    for _ in range(2):
        nx0, nx1 = snap_v(x0, y0, y1), snap_v(x1, y0, y1)
        if nx1 - nx0 >= 16:
            x0, x1 = nx0, nx1
        ny0, ny1 = snap_h(y0, x0, x1), snap_h(y1, x0, x1)
        if ny1 - ny0 >= 16:
            y0, y1 = ny0, ny1
    x, y, w, h = x0, y0, x1 - x0, y1 - y0
    inside = float(std[y:y + h, x:x + w].mean())
    rest = free.copy()
    rest[y:y + h, x:x + w] = False
    around = float(std[rest].mean()) if rest.any() else 0.0
    print(json.dumps({"box": {"x0": x / W, "y0": y / H, "x1": (x + w) / W, "y1": (y + h) / H}, "score": inside / (around + 1), "fill": (w * h) / free_area}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"box": None, "score": 0, "error": str(e)}))

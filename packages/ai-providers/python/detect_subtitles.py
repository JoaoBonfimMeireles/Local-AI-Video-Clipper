"""Detecta a faixa horizontal onde há legendas "queimadas" no vídeo original (OpenCV).

Heurística: texto gera muitas bordas horizontais finas e alto contraste. Somamos a densidade
de bordas por linha na metade inferior de vários frames e procuramos a faixa contínua mais densa.
Saída (stdout): JSON {"found": bool, "y": frac, "h": frac, "confidence": float}
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", nargs="+")
    args = ap.parse_args()

    try:
        import cv2
        import numpy as np
    except ImportError:
        print(json.dumps({"found": False, "error": "opencv ausente"}))
        return

    acc = None
    used = 0
    for path in args.frames:
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        img = cv2.resize(img, (480, int(480 * img.shape[0] / img.shape[1])))
        edges = cv2.Canny(img, 100, 200)
        # Morfologia horizontal realça linhas de texto
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1))
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
        rows = edges.mean(axis=1) / 255.0
        acc = rows if acc is None else acc[: len(rows)] + rows[: len(acc)]
        used += 1

    if acc is None or used == 0:
        print(json.dumps({"found": False}))
        return

    rows = acc / used
    n = len(rows)
    lower = rows[n // 2 :]
    baseline = float(np.median(rows))
    threshold = max(baseline * 2.2, 0.06)
    mask = lower > threshold

    # Faixas contínuas acima do limiar
    runs = []
    start = None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([start, i])
            start = None

    # Uma legenda vira várias faixas finas (bordas da caixa, linhas do texto): une as próximas
    max_gap = max(2, int(n * 0.03))
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= max_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)

    best = max(merged, key=lambda r: lower[r[0] : r[1]].sum(), default=[0, 0])
    band = best[1] - best[0]
    if band < n * 0.02:
        print(json.dumps({"found": False, "confidence": 0}))
        return

    pad = int(n * 0.025)
    y0 = max(0, best[0] + n // 2 - pad)
    y1 = min(n, best[1] + n // 2 + pad)
    conf = float(min(1.0, (lower[best[0] : best[1]].mean() - baseline) / (threshold + 1e-6)))
    print(json.dumps({"found": True, "y": round(y0 / n, 4), "h": round((y1 - y0) / n, 4), "confidence": round(conf, 3)}))


if __name__ == "__main__":
    sys.exit(main())

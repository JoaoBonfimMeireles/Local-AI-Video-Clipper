"""Gráfico de "calor" de um VOD: nota ao longo da live, com os melhores momentos numerados.

Uso: python vod_chart.py <peaks.json> <saida.png>
"""
import json
import sys

import cv2
import numpy as np

W, H = 1600, 520
PAD_L, PAD_R, PAD_T, PAD_B = 60, 30, 70, 60


def hhmm(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{(t % 3600) // 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def main() -> None:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    series = data["series"]
    dur = data["meta"]["duration"]
    img = np.full((H, W, 3), (24, 20, 18), np.uint8)
    pw, ph = W - PAD_L - PAD_R, H - PAD_T - PAD_B
    x = lambda t: int(PAD_L + t / max(1, dur) * pw)  # noqa: E731
    y = lambda s: int(PAD_T + ph - min(1.0, s) * ph)  # noqa: E731

    # Grade de tempo
    step = 1800 if dur > 3 * 3600 else 600 if dur > 3600 else 300
    for t in range(0, int(dur) + 1, step):
        cv2.line(img, (x(t), PAD_T), (x(t), PAD_T + ph), (48, 42, 40), 1)
        cv2.putText(img, hhmm(t), (x(t) - 18, H - PAD_B + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (160, 160, 160), 1, cv2.LINE_AA)

    # Área de calor: cor vai de azul (calmo) a amarelo/vermelho (pico)
    for p in series:
        s = p["s"]
        c = (int(255 * (1 - s)), int(140 + 100 * s), int(60 + 195 * s)) if s < 0.5 else (30, int(255 * (1.3 - s)), 255)
        cv2.line(img, (x(p["t"]), y(0)), (x(p["t"]), y(s)), c, max(1, pw // max(1, len(series))))
    pts = np.array([[x(p["t"]), y(p["s"])] for p in series], np.int32)
    cv2.polylines(img, [pts], False, (230, 230, 230), 1, cv2.LINE_AA)

    # Momentos
    for m in data["moments"]:
        cx = x(m["peak"])
        cy = y(m["score"] / 100)
        cv2.rectangle(img, (x(m["start"]), PAD_T + ph + 4), (max(x(m["start"]) + 2, x(m["end"])), PAD_T + ph + 10), (0, 200, 255), -1)
        cv2.circle(img, (cx, cy - 14), 12, (0, 200, 255), -1, cv2.LINE_AA)
        label = str(m["rank"])
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        cv2.putText(img, label, (cx - tw // 2, cy - 14 + th // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1, cv2.LINE_AA)

    title = f"{data['meta']['channel']} - {data['meta']['title']}"[:90]
    cv2.putText(img, title.encode("ascii", "replace").decode(), (PAD_L, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (240, 240, 240), 1, cv2.LINE_AA)
    cv2.putText(img, "nota (chat relativo + reacoes + audio) ao longo da live; numeros = top momentos", (PAD_L, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".png", img)
    buf.tofile(sys.argv[2])


if __name__ == "__main__":
    main()

"""Remove legendas queimadas de uma faixa do vídeo, preenchendo com o fundo real.

Fluxo (rawvideo BGR24 por stdin/stdout, um frame por vez):
  ffmpeg (recorta a faixa) -> este script -> ffmpeg (sobrepõe a faixa limpa no vídeo original)

Para cada frame:
  1. Máscara de texto: traços claros finos (white top-hat) ou escuros finos (black top-hat, legendas
     pretas com borda clara), mais a borda/contorno ao redor (dilatação).
  2. Preenchimento temporal: cada pixel coberto por texto recebe o valor mais recente desse mesmo
     pixel quando ele NÃO estava coberto (memória de fundo). Em câmera parada fica perfeito.
  3. Pixels sem memória recente (câmera em movimento, legenda fixa) -> inpainting do OpenCV (Telea).
Frames sem texto passam intactos.
"""
import argparse
import sys

import cv2
import numpy as np


def text_mask(frame, kernel_big, kernel_dilate):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    white_top = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel_big)
    # Preenchimento típico de legenda: branco ou amarelo, bem claro, destacado do entorno
    fill = (val > 170) & ((sat < 60) | ((hue >= 15) & (hue <= 40) & (sat > 90))) & (white_top > 25)
    fill = cv2.morphologyEx(fill.astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    # Contorno escuro colado ao preenchimento (borda preta da legenda)
    near = cv2.dilate(fill, np.ones((7, 7), np.uint8)) > 0
    outline = near & (val < 80)
    mask = (fill > 0) | outline
    return cv2.dilate(mask.astype(np.uint8) * 255, kernel_dilate, iterations=2)


def inpaint_fast(img, mask):
    """Inpainting só no retângulo afetado e em meia resolução (~4-8x mais rápido); o resultado
    reamostrado substitui apenas os pixels da máscara."""
    ys, xs = np.nonzero(mask)
    pad = 10
    y0, y1 = max(0, ys.min() - pad), min(img.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(img.shape[1], xs.max() + pad + 1)
    sub = img[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    sh, sw = max(2, sub.shape[0] // 2), max(2, sub.shape[1] // 2)
    small = cv2.resize(sub, (sw, sh), interpolation=cv2.INTER_AREA)
    msmall = cv2.dilate(cv2.resize(m, (sw, sh), interpolation=cv2.INTER_NEAREST), np.ones((3, 3), np.uint8))
    filled = cv2.resize(cv2.inpaint(small, msmall, 3, cv2.INPAINT_TELEA), (sub.shape[1], sub.shape[0]), interpolation=cv2.INTER_LINEAR)
    region = m > 0
    sub[region] = filled[region]
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--max-age", type=float, default=3.0, help="segundos que a memória de fundo continua válida")
    args = ap.parse_args()

    w, h = args.width, args.height
    frame_bytes = w * h * 3
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    # Tamanho do kernel proporcional à altura da letra (~faixa/3)
    k = max(9, (h // 6) | 1)
    kernel_big = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    kernel_dilate = np.ones((3, 3), np.uint8)
    max_age = int(args.max_age * args.fps)
    min_text = int(w * h * 0.002)

    bg = None
    age = None  # frames desde a última vez que o pixel de fundo foi visto
    while True:
        buf = stdin.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
        mask = text_mask(frame, kernel_big, kernel_dilate)
        covered = mask > 0
        if bg is None:
            bg = frame.copy()
            age = np.where(covered, max_age + 1, 0).astype(np.int32)

        # Corte de câmera: a memória de fundo deixa de valer (evita colar pedaços da cena anterior)
        clear = ~covered
        if np.count_nonzero(clear) > 0:
            diff = np.abs(frame.astype(np.int16) - bg.astype(np.int16)).mean(axis=2)[clear].mean()
            if diff > 28:
                bg = frame.copy()
                age[:] = max_age + 1
        bg[clear] = frame[clear]
        age[clear] = 0
        age[covered] += 1

        if np.count_nonzero(covered) < min_text:
            stdout.write(buf)
            continue

        out = frame.copy()
        fresh = covered & (age <= max_age)
        out[fresh] = bg[fresh]
        rest = (covered & ~fresh).astype(np.uint8) * 255
        if np.count_nonzero(rest):
            out = inpaint_fast(out, rest)
        stdout.write(out.tobytes())

    stdout.flush()


if __name__ == "__main__":
    main()

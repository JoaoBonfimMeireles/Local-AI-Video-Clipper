"""Transforma a ilustração do narrador (data/narrator/apresentador.png) nos sprites do render:
tira o fundo, acha olhos e boca (YuNet) e gera m0/m1/m2 (boca fechada, meio aberta, aberta) x e0/e1 (olhos
abertos, piscando). A boca da imagem original é a "aberta"; a fechada e a meia saem de uma deformação suave (a mandíbula inteira,
com a barba, sobe como um bloco e o pescoço estica), sem pintar por cima. Sem piscar: e1 = e0. O recorte vai do peito para cima.

Uso: python narrator_from_image.py --image <arquivo> --out <pasta> [--height 640]
"""
import argparse
import json
import os

import cv2
import numpy as np

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")


def detect_face(img):
    h, w = img.shape[:2]
    det = cv2.FaceDetectorYN.create(MODEL, "", (w, h), 0.5, 0.3, 5)
    _, faces = det.detect(img)
    if faces is None or not len(faces):
        raise SystemExit("rosto não encontrado na imagem do narrador")
    f = max(faces, key=lambda r: r[2] * r[3])
    return {
        "box": f[0:4],
        "eye_r": f[4:6],
        "eye_l": f[6:8],
        "nose": f[8:10],
        "mouth_r": f[10:12],
        "mouth_l": f[12:14],
    }


def cut_background(img, face):
    """GrabCut: bordas = fundo provável, rosto = frente certa. Fundos de gradiente liso saem bem."""
    h, w = img.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_FGD, np.uint8)
    b = max(4, int(min(h, w) * 0.03))
    mask[:b, :] = cv2.GC_BGD
    mask[:, :b] = cv2.GC_BGD
    mask[:, w - b:] = cv2.GC_PR_BGD
    mask[h - b:, :] = cv2.GC_PR_FGD
    x, y, fw, fh = [int(v) for v in face["box"]]
    mask[y + fh // 6: y + fh, x + fw // 6: x + fw - fw // 6] = cv2.GC_FGD
    # Pixels muito parecidos com a cor do fundo nas bordas viram fundo provável
    border = np.concatenate([img[:b].reshape(-1, 3), img[:, :b].reshape(-1, 3), img[:, w - b:].reshape(-1, 3)]).astype(np.float32)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    blab = cv2.cvtColor(border.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    sample = blab[:: max(1, len(blab) // 60)]
    flat = lab.reshape(-1, 3)
    dist = np.empty(len(flat), np.float32)
    for i in range(0, len(flat), 100000):  # em blocos: cabe na memória
        dist[i:i + 100000] = np.min(np.linalg.norm(flat[i:i + 100000, None, :] - sample[None], axis=2), axis=1)
    dist = dist.reshape(h, w)
    mask[(dist < 10) & (mask == cv2.GC_PR_FGD)] = cv2.GC_PR_BGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(img, mask, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    # Só o maior pedaço conectado (o personagem), sem buracos
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(fg)
    if n > 1:
        big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        fg = np.where(lbl == big, 255, 0).astype(np.uint8)
    inv = cv2.bitwise_not(fg)
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(inv)
    for i in range(1, n):
        x0, y0, ww, hh, area = stats[i]
        if x0 > 0 and y0 > 0 and x0 + ww < w and y0 + hh < h:
            fg[lbl == i] = 255
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return cv2.GaussianBlur(fg, (3, 3), 0)


def ring_color(img, cx, cy, rx, ry):
    """Cor mediana numa faixa em volta da elipse (pele/barba ao redor da boca ou do olho)."""
    h, w = img.shape[:2]
    outer = np.zeros((h, w), np.uint8)
    inner = np.zeros((h, w), np.uint8)
    cv2.ellipse(outer, (int(cx), int(cy)), (int(rx * 1.45), int(ry * 1.6)), 0, 0, 360, 255, -1)
    cv2.ellipse(inner, (int(cx), int(cy)), (int(rx * 1.1), int(ry * 1.15)), 0, 0, 360, 255, -1)
    ring = (outer > 0) & (inner == 0)
    return np.median(img[ring], axis=0)


def soft_ellipse(shape, cx, cy, rx, ry, feather):
    m = np.zeros(shape[:2], np.float32)
    cv2.ellipse(m, (int(cx), int(cy)), (int(rx), int(ry)), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
    k = max(3, int(feather) | 1)
    return cv2.GaussianBlur(m, (k, k), 0)[..., None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--height", type=int, default=640)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    src = cv2.imread(a.image, cv2.IMREAD_COLOR)
    if src is None:
        raise SystemExit(f"não foi possível ler {a.image}")
    face = detect_face(src)
    alpha = cut_background(src, face)

    fx, fy, fw, fh = face["box"]
    ink = np.array([40, 30, 30], np.float32)
    (rx_, ry_), (lx, ly) = face["mouth_r"], face["mouth_l"]
    mcx, mcy = (rx_ + lx) / 2, (ry_ + ly) / 2
    mw = (lx - rx_) / 2

    # Abertura da boca na imagem: linhas (no meio da boca) com dentes, interior escuro ou língua (vermelho-arroxeado)
    hsv = cv2.cvtColor(src, cv2.COLOR_BGR2HSV).astype(np.int32)
    xa, xb = int(mcx - mw * 0.45), int(mcx + mw * 0.45)
    def frac(y, kind):
        h_, s_, v_ = hsv[y, xa:xb, 0], hsv[y, xa:xb, 1], hsv[y, xa:xb, 2]
        teeth = (v_ > 190) & (s_ < 70)
        if kind == "teeth":
            return np.mean(teeth)
        inner = ((v_ < 140) & (s_ > 60)) | ((h_ >= 160) & (s_ > 90))  # interior escuro ou língua
        return np.mean(teeth | inner)

    # Começa nos dentes e desce enquanto for "dentro da boca"; para no lábio de baixo (a barba fica de fora)
    ys_ = range(int(mcy - fw * 0.1), int(mcy + fw * 0.1))
    start = next((y for y in ys_ if frac(y, "teeth") > 0.35), None)
    if start is not None:
        while start > 0 and frac(start - 1, "inner") > 0.35:
            start -= 1
        end = start
        while end + 1 < src.shape[0] and frac(end + 1, "inner") > 0.35:
            end += 1
        y_open, gap = start, end - start + 1
    else:
        y_open, gap = int(mcy - fw * 0.03), int(fw * 0.06)
    y_chin = min(src.shape[0] - 1, int(fy + fh * 1.02))

    h, w = src.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    # Peso radial em volta da boca: lábio de baixo e centro da barba movem tudo, o queixo acompanha em parte e o
    # efeito some suave antes do contorno da mandíbula, das bochechas e do pescoço (pele esticando, não bloco rígido)
    ax = fw * 0.6
    ay = (y_chin - y_open) * 1.3
    r = np.sqrt(((xs - mcx) / ax) ** 2 + (np.maximum(ys - y_open - gap, 0) / ay) ** 2)
    t = np.clip((r - 0.35) / 0.75, 0, 1)
    wr = np.where(ys >= y_open, 1 - t * t * (3 - 2 * t), 0).astype(np.float32)

    def jaw_map(amount):
        """Fecha a boca puxando lábio de baixo e queixo para cima, com o deslocamento se dissipando na barba."""
        return (ys + gap * amount * wr).astype(np.float32)

    mouths, alphas = [], []
    for amount in (1.0, 0.55, 0.0):
        if amount == 0:
            mouths.append(src.astype(np.float32))
            alphas.append(alpha)
            continue
        my = jaw_map(amount)
        mouths.append(cv2.remap(src, xs, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32))
        alphas.append(cv2.remap(alpha, xs, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE))

    # Do peito para cima: corta logo abaixo do nó da gravata (sem braços)
    ys, xs = np.where(alpha > 20)
    top = ys.min()
    bottom = min(src.shape[0], int(fy + fh * 1.95))
    band = alpha[top:bottom]
    cols = np.where(band.max(axis=0) > 20)[0]
    left, right = cols.min(), cols.max() + 1
    scale = a.height / (bottom - top)
    size = (max(2, int((right - left) * scale)), a.height)
    for mi, mimg in enumerate(mouths):
        for e in (0, 1):
            img = mimg.clip(0, 255).astype(np.uint8)
            rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
            rgba[..., 3] = alphas[mi]
            # Base do busto some em degradê (não fica um corte reto)
            fade = int((bottom - top) * 0.12)
            ramp = np.linspace(1, 0, fade)[:, None]
            rgba[bottom - fade:bottom, :, 3] = (rgba[bottom - fade:bottom, :, 3] * ramp).astype(np.uint8)
            rgba = cv2.resize(rgba[top:bottom, left:right], size, interpolation=cv2.INTER_AREA)
            cv2.imwrite(os.path.join(a.out, f"m{mi}_e{e}.png"), rgba)
    print(json.dumps({"width": size[0], "height": size[1]}))


if __name__ == "__main__":
    main()

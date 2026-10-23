"""Prepara uma imagem baixada para virar ilustração no vídeo.

- PNG com transparência real: recorta o objeto e adiciona contorno branco + sombra (estilo figurinha).
- Foto com fundo branco liso (comum em bancos de imagem): remove o fundo e trata como recorte.
- Qualquer outra foto: vira um cartão com cantos arredondados, borda branca e sombra suave.

Uso: python prepare_illustration.py <entrada> <saida.png> [tamanho_max]
Imprime um JSON com {"style": "cutout" | "card", "width": W, "height": H}.
"""
import json
import sys

import cv2
import numpy as np


def load_rgba(path: str) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)  # suporta caminhos com acentos no Windows
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("imagem ilegível")
    if img.dtype != np.uint8:
        img = (img / 257).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def fit(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s < 1:
        img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    return img


def has_transparency(img: np.ndarray) -> bool:
    a = img[:, :, 3]
    return float((a < 20).mean()) > 0.03


def knock_out_white_background(img: np.ndarray) -> bool:
    """Fundo branco liso nas bordas → transparente (flood fill a partir das bordas)."""
    h, w = img.shape[:2]
    bgr = img[:, :, :3]
    border = np.concatenate([bgr[0], bgr[-1], bgr[:, 0], bgr[:, -1]])
    if float((border.min(axis=1) > 235).mean()) < 0.92:
        return False
    near_white = (bgr.min(axis=2) > 232).astype(np.uint8)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    filled = near_white.copy()
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if filled[y, x] == 1:
            cv2.floodFill(filled, mask, (x, y), 2)
    bg = filled == 2
    if bg.mean() < 0.08 or bg.mean() > 0.9:  # quase nada (ou quase tudo) é fundo: não é recorte
        return False
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    img[:, :, 3] = np.minimum(img[:, :, 3], alpha)
    return True


def shadow_under(rgba: np.ndarray, pad: int, offset: int, blur: int, strength: float) -> np.ndarray:
    """Coloca rgba sobre uma tela maior com sombra desfocada (deslocada para baixo)."""
    h, w = rgba.shape[:2]
    H, W = h + pad * 2, w + pad * 2
    canvas = np.zeros((H, W, 4), np.uint8)
    sh = np.zeros((H, W), np.float32)
    sh[pad + offset : pad + offset + h, pad : pad + w] = rgba[:, :, 3].astype(np.float32) / 255.0
    k = blur * 2 + 1
    sh = cv2.GaussianBlur(sh, (k, k), 0) * strength
    canvas[:, :, 3] = (sh * 255).astype(np.uint8)
    # sobrepõe o conteúdo (alpha "over")
    fg = rgba.astype(np.float32) / 255.0
    region = canvas[pad : pad + h, pad : pad + w].astype(np.float32) / 255.0
    a_fg = fg[:, :, 3:4]
    a_bg = region[:, :, 3:4]
    a_out = a_fg + a_bg * (1 - a_fg)
    rgb = (fg[:, :, :3] * a_fg + region[:, :, :3] * a_bg * (1 - a_fg)) / np.maximum(a_out, 1e-6)
    merged = np.concatenate([rgb, a_out], axis=2).clip(0, 1) * 255
    canvas[pad : pad + h, pad : pad + w] = merged.astype(np.uint8)
    return canvas


def cutout(img: np.ndarray, max_side: int) -> np.ndarray:
    ys, xs = np.where(img[:, :, 3] > 20)
    img = img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    img = fit(img, max_side)
    h, w = img.shape[:2]
    stroke = max(4, int(max(h, w) * 0.022))
    pad = stroke + 2
    big = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(0, 0, 0, 0))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (stroke * 2 + 1, stroke * 2 + 1))
    outline = cv2.dilate((big[:, :, 3] > 40).astype(np.uint8) * 255, k)
    outline = cv2.GaussianBlur(outline, (3, 3), 0)
    # Contorno branco some em logos/textos claros (ex.: logo de filme): nesses casos o contorno é escuro
    opaque = big[:, :, 3] > 128
    light = opaque.any() and float(big[:, :, :3][opaque].mean()) > 185
    edge = 25 if light else 255
    sticker = np.zeros_like(big)
    sticker[:, :, :3] = edge
    sticker[:, :, 3] = outline
    a = big[:, :, 3:4].astype(np.float32) / 255.0
    sticker[:, :, :3] = (big[:, :, :3] * a + edge * (1 - a)).astype(np.uint8)
    return shadow_under(sticker, pad=stroke * 3, offset=stroke, blur=stroke * 2, strength=0.45)


def card(img: np.ndarray, max_side: int) -> np.ndarray:
    img = fit(img, max_side)
    img[:, :, 3] = 255
    h, w = img.shape[:2]
    border = max(6, int(max(h, w) * 0.025))
    framed = cv2.copyMakeBorder(img, border, border, border, border, cv2.BORDER_CONSTANT, value=(255, 255, 255, 255))
    H, W = framed.shape[:2]
    r = max(8, int(min(H, W) * 0.07))
    mask = np.zeros((H, W), np.uint8)
    cv2.rectangle(mask, (r, 0), (W - r - 1, H - 1), 255, -1)
    cv2.rectangle(mask, (0, r), (W - 1, H - r - 1), 255, -1)
    for cx, cy in ((r, r), (W - r - 1, r), (r, H - r - 1), (W - r - 1, H - r - 1)):
        cv2.circle(mask, (cx, cy), r, 255, -1, lineType=cv2.LINE_AA)
    framed[:, :, 3] = mask
    return shadow_under(framed, pad=border * 3, offset=border, blur=border * 2, strength=0.5)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 720
    img = load_rgba(src)
    img = fit(img, 1400)  # acelera o processamento de imagens gigantes
    if has_transparency(img) or knock_out_white_background(img):
        out, style = cutout(img, max_side), "cutout"
    else:
        out, style = card(img, max_side), "card"
    ok, buf = cv2.imencode(".png", out)
    if not ok:
        raise ValueError("falha ao gravar PNG")
    buf.tofile(dst)
    print(json.dumps({"style": style, "width": int(out.shape[1]), "height": int(out.shape[0])}))


if __name__ == "__main__":
    main()

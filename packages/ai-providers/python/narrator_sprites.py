"""Desenha o narrador 2D (apresentador de terno, óculos redondos e barba) em PNG com transparência, um arquivo
por estado: boca m0 (fechada), m1 (meio aberta), m2 (aberta) x olhos e0 (abertos), e1 (piscando).
Mesmo desenho do SVG da prévia no painel (components/narrator-avatar.tsx).

Uso: python narrator_sprites.py --out <pasta>
"""
import argparse
import os

import cv2
import numpy as np

W, H = 360, 420
S = 4  # desenha em 4x e reduz: bordas suaves

# BGR
SKIN = (138, 172, 222)
SKIN_SHADE = (110, 145, 196)
HAIR = (48, 30, 22)
BEARD = (70, 85, 110)
SUIT = (92, 70, 40)
SUIT_DARK = (70, 52, 30)
SHIRT = (238, 222, 196)
TIE = (90, 40, 110)
INK = (40, 28, 24)
MOUTH = (50, 40, 110)
TEETH = (245, 245, 250)
PIN = (180, 215, 235)


def p(x, y):
    return (int(x * S), int(y * S))


def r(v):
    return max(1, int(v * S))


def poly(img, pts, c):
    cv2.fillPoly(img, [np.array([p(x, y) for x, y in pts], np.int32)], c, cv2.LINE_AA)


def outline(img, pts, c, w=3, closed=True):
    cv2.polylines(img, [np.array([p(x, y) for x, y in pts], np.int32)], closed, c, r(w), cv2.LINE_AA)


def draw(mouth, eyes):
    img = np.zeros((H * S, W * S, 4), np.uint8)
    col = lambda c: (c[0], c[1], c[2], 255)
    aa = cv2.LINE_AA
    ink = col(INK)

    # terno (ombros largos)
    suit = [(20, 420), (30, 330), (70, 292), (145, 270), (215, 270), (290, 292), (330, 330), (340, 420)]
    poly(img, suit, col(SUIT))
    outline(img, suit, ink, 3, False)
    # camisa e gravata no V
    poly(img, [(148, 270), (212, 270), (198, 360), (180, 380), (162, 360)], col(SHIRT))
    poly(img, [(172, 292), (188, 292), (194, 370), (180, 388), (166, 370)], col(TIE))
    poly(img, [(170, 278), (190, 278), (188, 294), (172, 294)], col(TIE))
    # lapelas
    for a, b in (((148, 270), (122, 300)), ((212, 270), (238, 300))):
        x0, y0 = a
        x1, _ = b
        poly(img, [(x0, y0), (x1, 300), (x0 + (x1 - x0) * 0.4, 318), (x0 + (180 - x0) * 0.6, 380)], col(SUIT_DARK))
    outline(img, [(148, 270), (122, 300), (158, 320), (166, 380)], ink, 2.5, False)
    outline(img, [(212, 270), (238, 300), (202, 320), (194, 380)], ink, 2.5, False)
    # broche de bússola
    cv2.circle(img, p(238, 330), r(8), col(PIN), r(2), aa)
    poly(img, [(238, 323), (241, 330), (238, 337), (235, 330)], col(PIN))
    # braços cruzados
    poly(img, [(40, 380), (300, 372), (320, 400), (60, 412)], col(SUIT_DARK))
    outline(img, [(40, 380), (300, 372), (320, 400), (60, 412)], ink, 2.5)
    cv2.ellipse(img, p(300, 386), (r(18), r(12)), -8, 0, 360, col(SKIN), -1, aa)
    cv2.ellipse(img, p(300, 386), (r(18), r(12)), -8, 0, 360, ink, r(2), aa)
    # pescoço
    poly(img, [(160, 225), (200, 225), (204, 275), (180, 286), (156, 275)], col(SKIN_SHADE))
    # orelhas
    for ex in (106, 254):
        cv2.ellipse(img, p(ex, 158), (r(12), r(20)), 0, 0, 360, col(SKIN), -1, aa)
    # rosto (mais anguloso)
    face = [(110, 120), (250, 120), (252, 190), (232, 238), (200, 262), (160, 262), (128, 238), (108, 190)]
    poly(img, face, col(SKIN))
    # barba curta
    beard = [(110, 185), (128, 236), (160, 262), (200, 262), (232, 236), (250, 185), (242, 222), (215, 240), (180, 246), (145, 240), (118, 222)]
    poly(img, beard, col(BEARD))
    cv2.ellipse(img, p(180, 222), (r(34), r(9)), 0, 0, 360, col(BEARD), -1, aa)  # bigode/contorno da boca
    outline(img, face, ink, 3)
    # cabelo penteado para trás
    hair = [(104, 140), (100, 90), (125, 55), (175, 40), (230, 48), (262, 82), (258, 140), (246, 108), (215, 92), (165, 96), (124, 112)]
    poly(img, hair, col(HAIR))
    # sobrancelhas
    lift = 3 if mouth == 2 else 0
    cv2.line(img, p(128, 138 - lift), p(164, 134 - lift), col(HAIR), r(6), aa)
    cv2.line(img, p(196, 134 - lift), p(232, 138 - lift), col(HAIR), r(6), aa)
    # olhos
    for ex in (147, 213):
        if eyes == 0:
            cv2.ellipse(img, p(ex, 160), (r(10), r(7)), 0, 0, 360, col((245, 245, 245)), -1, aa)
            cv2.circle(img, p(ex, 160), r(5.5), ink, -1, aa)
            cv2.circle(img, p(ex + 2, 158), r(1.6), col((255, 255, 255)), -1, aa)
        else:
            cv2.line(img, p(ex - 10, 161), p(ex + 10, 161), ink, r(3), aa)
    # óculos redondos finos
    for ex in (147, 213):
        cv2.circle(img, p(ex, 160), r(23), ink, r(3.5), aa)
    cv2.line(img, p(170, 158), p(190, 158), ink, r(3), aa)
    cv2.line(img, p(124, 156), p(108, 150), ink, r(3), aa)
    cv2.line(img, p(236, 156), p(252, 150), ink, r(3), aa)
    # nariz
    outline(img, [(180, 168), (174, 196), (184, 198)], col(SKIN_SHADE), 3, False)
    # boca
    if mouth == 0:
        cv2.ellipse(img, p(180, 224), (r(20), r(5)), 0, 10, 170, ink, r(3.5), aa)
    else:
        oh = 7 if mouth == 1 else 13
        cv2.ellipse(img, p(180, 226), (r(22), r(oh)), 0, 0, 360, col(MOUTH), -1, aa)
        cv2.ellipse(img, p(180, 226 - oh * 0.45), (r(18), r(oh * 0.45)), 0, 180, 360, col(TEETH), -1, aa)
        cv2.ellipse(img, p(180, 226), (r(22), r(oh)), 0, 0, 360, ink, r(3), aa)
    return cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for m in range(3):
        for e in range(2):
            cv2.imwrite(os.path.join(a.out, f'm{m}_e{e}.png'), draw(m, e))
    print('ok')


if __name__ == '__main__':
    main()

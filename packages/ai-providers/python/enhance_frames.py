"""Melhora quadros (PNG) 100% local: aumenta 4x com o Real-ESRGAN realista (realesr-general-x4v3, torch na GPU) e,
opcionalmente, restaura os rostos com o GFPGAN 1.4 (ONNX), alinhados pelo detector YuNet do OpenCV.

Uso: enhance_frames.py --in <pasta|arquivo.png> --out <pasta|arquivo.png> --models <pasta> [--faces] [--scale 4]
Pastas: processa todos os .png (mesmo nome na saída; quadro já pronto é pulado). Uma linha "done N/T" por quadro no stderr.
Modelos (tools/enhance): realesr-general-x4v3.pth e gfpgan_1.4.onnx; YuNet em packages/ai-providers/python/models.
"""
import argparse
import os
import sys

import cv2
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
YUNET = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")
# Pontos do rosto no quadro 512x512 do GFPGAN (olhos, nariz, cantos da boca), o mesmo molde do treino (FFHQ)
FFHQ_5 = np.array([[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]], np.float32)


class SRVGGNetCompact(nn.Module):
    """Arquitetura do realesr-general-x4v3 (Real-ESRGAN): convoluções + PReLU e pixel shuffle, somando o vizinho mais próximo."""

    def __init__(self, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList([nn.Conv2d(3, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)])
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        return self.upsampler(out) + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


class Upscaler:
    def __init__(self, models):
        self.dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.half = self.dev.type == "cuda"
        net = SRVGGNetCompact()
        state = torch.load(os.path.join(models, "realesr-general-x4v3.pth"), map_location="cpu", weights_only=True)
        net.load_state_dict(state.get("params", state), strict=True)
        net.eval().to(self.dev)
        self.net = net.half() if self.half else net

    @torch.no_grad()
    def _run(self, rgb):
        t = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).to(self.dev)
        t = (t.half() if self.half else t.float()) / 255.0
        out = self.net(t).clamp_(0, 1)
        return (out[0].permute(1, 2, 0).float().cpu().numpy() * 255.0).round().astype(np.uint8)

    def __call__(self, bgr):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        tile, pad = 384, 12
        if h * w <= tile * tile:
            out = self._run(rgb)
        else:
            # Em pedaços (com sobra nas bordas) para caber nos 4 GB da placa
            out = np.zeros((h * 4, w * 4, 3), np.uint8)
            for y in range(0, h, tile):
                for x in range(0, w, tile):
                    y0, x0 = max(0, y - pad), max(0, x - pad)
                    y1, x1 = min(h, y + tile + pad), min(w, x + tile + pad)
                    part = self._run(np.ascontiguousarray(rgb[y0:y1, x0:x1]))
                    ty, tx = (y - y0) * 4, (x - x0) * 4
                    th, tw = (min(h, y + tile) - y) * 4, (min(w, x + tile) - x) * 4
                    out[y * 4 : y * 4 + th, x * 4 : x * 4 + tw] = part[ty : ty + th, tx : tx + tw]
        return cv2.cvtColor(out, cv2.COLOR_RGB2BGR)


class FaceRestorer:
    def __init__(self, models):
        import onnxruntime as ort

        wanted = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
        providers = [p for p in wanted if p in ort.get_available_providers()]
        self.sess = ort.InferenceSession(os.path.join(models, "gfpgan_1.4.onnx"), providers=providers)
        self.inp = self.sess.get_inputs()[0].name
        self.detector = cv2.FaceDetectorYN.create(YUNET, "", (320, 320), 0.6, 0.3, 50)

    def faces(self, bgr):
        h, w = bgr.shape[:2]
        # Detecta numa cópia de até 1280 px (rápido) e volta os pontos para o tamanho real
        k = min(1.0, 1280 / max(h, w))
        small = cv2.resize(bgr, (round(w * k), round(h * k))) if k < 1 else bgr
        self.detector.setInputSize((small.shape[1], small.shape[0]))
        _, found = self.detector.detect(small)
        if found is None:
            return []
        # Só rostos que valem a pena (>= 64 px no quadro aumentado), no máximo os 4 maiores: cada rosto custa uma passada
        # do GFPGAN, e miniaturas/rostos minúsculos ao fundo não ganham nada visível
        big = sorted((f for f in found if min(f[2], f[3]) / k >= 64), key=lambda f: -f[2] * f[3])[:4]
        return [np.array(f[4:14], np.float32).reshape(5, 2) / k for f in big]

    def __call__(self, bgr):
        out = bgr.astype(np.float32)
        h, w = bgr.shape[:2]
        for pts in self.faces(bgr):
            M, _ = cv2.estimateAffinePartial2D(pts, FFHQ_5, method=cv2.LMEDS)
            if M is None:
                continue
            crop = cv2.warpAffine(bgr, M, (512, 512), borderMode=cv2.BORDER_REPLICATE)
            x = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 127.5 - 1.0
            y = self.sess.run(None, {self.inp: x.transpose(2, 0, 1)[None]})[0][0]
            restored = cv2.cvtColor(((y.transpose(1, 2, 0).clip(-1, 1) + 1) * 127.5).astype(np.uint8), cv2.COLOR_RGB2BGR)
            # Volta para o quadro com uma máscara de bordas suaves (sem "recorte" visível em volta do rosto)
            inv = cv2.invertAffineTransform(M)
            back = cv2.warpAffine(restored, inv, (w, h), flags=cv2.INTER_LINEAR)
            mask = np.zeros((512, 512), np.float32)
            cv2.rectangle(mask, (40, 40), (472, 472), 1.0, -1)
            mask = cv2.GaussianBlur(mask, (0, 0), 24)
            m = cv2.warpAffine(mask, inv, (w, h))[..., None] * 0.9  # 10% do original: mantém a pessoa parecida
            out = out * (1 - m) + back.astype(np.float32) * m
        return out.clip(0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--faces", action="store_true")
    ap.add_argument("--no-upscale", action="store_true")
    # Prévia (um arquivo): grava a versão só aumentada em --out e a com rostos restaurados aqui, numa passada só
    ap.add_argument("--faces-out")
    # Prévia: restaura os rostos de outras imagens já aumentadas (ex.: a do detalhado), aproveitando os modelos já carregados
    ap.add_argument("--faces-also", nargs=2, action="append", default=[], metavar=("SRC", "DST"))
    args = ap.parse_args()

    up = None if args.no_upscale else Upscaler(args.models)
    fr = FaceRestorer(args.models) if args.faces or args.faces_out else None
    if args.faces_out:
        img = cv2.imread(args.src, cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"Quadro ilegível: {args.src}")
        if up:
            img = up(img)
        cv2.imwrite(args.out, img)
        cv2.imwrite(args.faces_out, fr(img))
        for a, b in args.faces_also:
            extra = cv2.imread(a, cv2.IMREAD_COLOR)
            if extra is not None:
                cv2.imwrite(b, fr(extra))
        return
    if os.path.isdir(args.src):
        os.makedirs(args.out, exist_ok=True)
        names = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".png"))
        pairs = [(os.path.join(args.src, n), os.path.join(args.out, n)) for n in names]
    else:
        pairs = [(args.src, args.out)]
    total = len(pairs)
    for i, (a, b) in enumerate(pairs, 1):
        if not os.path.exists(b):
            img = cv2.imread(a, cv2.IMREAD_COLOR)
            if img is None:
                raise SystemExit(f"Quadro ilegível: {a}")
            if up:
                img = up(img)
            if fr:
                img = fr(img)
            # Grava num temporário (sem .png) e renomeia: quem conta os quadros prontos nunca vê um arquivo pela metade
            ok, buf = cv2.imencode(".png", img)
            if not ok:
                raise SystemExit(f"Falha ao gravar {b}")
            tmp = b + ".part"
            with open(tmp, "wb") as fh:
                fh.write(buf.tobytes())
            os.replace(tmp, b)
        print(f"done {i}/{total}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()

"""Detecta rostos (YuNet / OpenCV) em uma lista de imagens.

Saída (stdout): JSON [{"faces": [{"x": cx, "y": cy, "w": w, "h": h, "score": s}]}] — coordenadas
normalizadas (0-1) do centro do rosto, na mesma ordem das imagens recebidas.
"""
import json
import os
import sys

import cv2

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "face_detection_yunet_2023mar.onnx")


def main():
    paths = sys.argv[1:]
    if not os.path.exists(MODEL):
        print(json.dumps({"error": "modelo YuNet ausente (rode npm run setup:python)"}))
        return
    detector = cv2.FaceDetectorYN.create(MODEL, "", (320, 320), 0.75, 0.3, 50)
    out = []
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            out.append({"faces": []})
            continue
        h, w = img.shape[:2]
        detector.setInputSize((w, h))
        _, found = detector.detect(img)
        faces = []
        for f in [] if found is None else found:
            x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
            faces.append({"x": round((x + fw / 2) / w, 3), "y": round((y + fh / 2) / h, 3), "w": round(fw / w, 3), "h": round(fh / h, 3), "score": round(score, 2)})
        out.append({"faces": sorted(faces, key=lambda r: -r["w"])})
    print(json.dumps(out))


if __name__ == "__main__":
    main()

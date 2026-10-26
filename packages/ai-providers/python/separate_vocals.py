"""Separa a voz da música (Demucs htdemucs, local, GPU se houver).

Uso: separate_vocals.py entrada.wav saida_voz.wav [--device cuda|cpu]
Lê/grava WAV com soundfile (sem depender dos backends do torchaudio). Processa em blocos
(split=True) para caber em GPUs de 4 GB. Progresso no stderr (barra do tqdm: " 42%|").
"""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--music", help="grava também o fundo (tudo menos a voz) neste WAV")
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    model = get_model(args.model)
    model.eval()

    data, sr = sf.read(args.input, dtype="float32", always_2d=True)
    if sr != model.samplerate:
        print(f"aviso: taxa {sr} != {model.samplerate}; extraia o WAV em {model.samplerate} Hz", file=sys.stderr)
    wav = torch.from_numpy(data.T.copy())
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    wav = wav[:2]
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = ((wav - mean) / std).unsqueeze(0)

    print(f"Demucs {args.model} em {device}", file=sys.stderr, flush=True)

    def run(dev):
        with torch.no_grad():
            return apply_model(model, x, device=dev, split=True, overlap=0.25, shifts=0, progress=True, num_workers=0)[0]

    try:
        out = run(device)
    except RuntimeError as e:  # falta de memória na GPU -> CPU
        if device == "cpu":
            raise
        print(f"GPU falhou ({e}); tentando na CPU", file=sys.stderr, flush=True)
        torch.cuda.empty_cache()
        out = run("cpu")

    vi = model.sources.index("vocals")

    def save(t, path):
        a = (t * std + mean).cpu().numpy().T
        peak = float(np.abs(a).max()) or 1.0
        if peak > 0.99:
            a = a / peak * 0.99
        sf.write(path, a, model.samplerate, subtype="PCM_16")

    save(out[vi], args.output)
    if args.music:
        save(sum(out[i] for i in range(len(model.sources)) if i != vi), args.music)
    print("PROGRESS 1.0", file=sys.stderr, flush=True)


if __name__ == "__main__":
    import faulthandler

    faulthandler.enable()
    try:
        main()
    except BaseException:
        import traceback

        traceback.print_exc()
        raise

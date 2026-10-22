"""Transcrição local com faster-whisper, timestamps por palavra.

Protocolo com o Node (stderr, uma linha por evento):
  PROGRESS <0..1>
  LOG <mensagem>
Resultado: JSON gravado em --out (UTF-8).

Ordem de tentativa: CUDA (se --device auto/cuda) -> CPU int8.
"""
import argparse
import json
import os
import sys
import time


def emit(kind, msg):
    sys.stderr.write(f"{kind} {msg}\n")
    sys.stderr.flush()


def disable_power_throttling():
    """Windows 11 pode herdar o modo de eficiência (EcoQoS) do processo pai (ex.: app desktop em
    segundo plano). Isso derruba o clock da thread que alimenta a GPU e torna a transcrição ~5-10x
    mais lenta. Aqui o processo opta explicitamente por desempenho normal."""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        class PowerThrottlingState(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

        process_power_throttling = 4
        execution_speed, ignore_timer_resolution = 0x1, 0x4
        state = PowerThrottlingState(1, execution_speed | ignore_timer_resolution, 0)
        k32 = ctypes.windll.kernel32
        k32.SetProcessInformation(k32.GetCurrentProcess(), process_power_throttling, ctypes.byref(state), ctypes.sizeof(state))
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception as e:  # noqa: BLE001 - otimização opcional
        emit("LOG", f"não foi possível desativar o power throttling: {e}")


def add_cuda_dll_paths():
    """No Windows, as DLLs de cuBLAS/cuDNN instaladas via pip ficam em site-packages/nvidia/*/bin."""
    if os.name != "nt":
        return
    import importlib.util

    for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc", "nvidia.cuda_runtime"):
        try:
            spec = importlib.util.find_spec(pkg)
        except (ImportError, ValueError):
            spec = None
        if not spec or not spec.submodule_search_locations:
            continue
        for base in spec.submodule_search_locations:
            bin_dir = os.path.join(base, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def load_wav_16k(path):
    """Lê o WAV PCM 16 kHz mono gerado pelo FFmpeg. Evita o decodificador PyAV do faster-whisper
    (versões novas do PyAV quebram a chamada av.open(..., metadata_errors=...))."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getsampwidth() != 2:
            raise ValueError("esperado WAV PCM 16-bit 16 kHz (extraia com ffmpeg -ac 1 -ar 16000)")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
    return data.astype(np.float32) / 32768.0


def run(model_name, device, compute_type, args):
    from faster_whisper import WhisperModel

    t0 = time.time()
    audio = load_wav_16k(args.audio) if args.audio.lower().endswith(".wav") else args.audio
    emit("LOG", f"carregando modelo '{model_name}' em {device} ({compute_type})")
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=args.threads,
        download_root=args.models_dir or None,
    )
    segments, info = model.transcribe(
        audio,
        language=None if args.language in (None, "", "auto") else args.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=args.beam_size,
        condition_on_previous_text=False,
    )
    emit("LOG", f"idioma detectado: {info.language} ({info.language_probability:.2f}); duração {info.duration:.1f}s")
    duration = info.duration or 1.0
    out_segments = []
    last_emit = 0.0
    for seg in segments:  # gerador preguiçoso: erros de CUDA aparecem aqui
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word, "probability": round(w.probability, 3)}
            for w in (seg.words or [])
        ]
        out_segments.append(
            {"id": len(out_segments), "start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": words}
        )
        p = min(0.999, seg.end / duration)
        if p - last_emit >= 0.01:
            emit("PROGRESS", f"{p:.4f}")
            last_emit = p
    emit("LOG", f"transcrição concluída em {time.time() - t0:.1f}s ({len(out_segments)} segmentos)")
    return {
        "language": info.language,
        "languageProbability": round(info.language_probability, 4),
        "duration": round(duration, 3),
        "device": device,
        "model": model_name,
        "segments": out_segments,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="small")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--compute-type", default="")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--models-dir", default="")
    args = ap.parse_args()
    disable_power_throttling()

    attempts = []
    if args.device in ("auto", "cuda"):
        add_cuda_dll_paths()
        try:
            import ctranslate2

            has_cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_cuda = False
        if has_cuda:
            # int8_float16 cabe em GPUs de 4 GB (ex.: GTX 1650) até o modelo medium.
            attempts.append(("cuda", args.compute_type or "int8_float16"))
        elif args.device == "cuda":
            emit("LOG", "CUDA solicitado mas indisponível; usando CPU")
    attempts.append(("cpu", "int8" if not args.compute_type or args.device != "cpu" else args.compute_type))

    result = None
    last_err = None
    for device, ctype in attempts:
        try:
            result = run(args.model, device, ctype, args)
            break
        except Exception as e:  # noqa: BLE001 - qualquer falha de GPU cai para CPU
            last_err = e
            emit("LOG", f"falha em {device}: {type(e).__name__}: {e}")
            emit("PROGRESS", "0")
    if result is None:
        emit("LOG", f"transcrição falhou: {last_err}")
        sys.exit(2)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    emit("PROGRESS", "1")


if __name__ == "__main__":
    main()

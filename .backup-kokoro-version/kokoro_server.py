#!/usr/bin/env python3
"""Kokoro TTS server — OpenAI-compatible /v1/audio/speech endpoint on port 8880."""

import io
import os
import sys
import wave
import urllib.request

import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# ── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
MODEL_FILE  = os.path.join(SCRIPT_DIR, "kokoro-v1.0.int8.onnx")
VOICES_FILE = os.path.join(SCRIPT_DIR, "voices-v1.0.bin")

MODEL_URLS = {
    MODEL_FILE:  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
    VOICES_FILE: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

# ── Model download ────────────────────────────────────────────────────────────

def _download(url: str, dest: str) -> None:
    size_mb = {"kokoro-v1.0.int8.onnx": 88, "voices-v1.0.bin": 26}.get(os.path.basename(dest), "?")
    print(f"  Downloading {os.path.basename(dest)} (~{size_mb} MB) ...", flush=True)
    tmp = dest + ".tmp"
    try:
        def _progress(count, block, total):
            if total > 0:
                pct = min(count * block / total * 100, 100)
                bar = "=" * int(pct / 2)
                print(f"\r  [{bar:<50}] {pct:5.1f}%", end="", flush=True)

        urllib.request.urlretrieve(url, tmp, _progress)
        print(flush=True)
        os.replace(tmp, dest)
    except Exception as exc:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(f"Failed to download {os.path.basename(dest)}: {exc}") from exc


def ensure_models() -> None:
    missing = [(path, url) for path, url in MODEL_URLS.items() if not os.path.exists(path)]
    if not missing:
        return
    print("", flush=True)
    print("  Model files not found — downloading now (one-time setup):", flush=True)
    for path, url in missing:
        _download(url, path)
    print("  Download complete.", flush=True)
    print("", flush=True)


# ── Kokoro loader ─────────────────────────────────────────────────────────────

_pipeline = None


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro_onnx import Kokoro
        _pipeline = Kokoro(MODEL_FILE, VOICES_FILE)
    return _pipeline


def synthesise(text: str, voice: str, speed: float) -> tuple:
    pipeline = get_pipeline()
    # Try with lang kwarg (v0.4.x), fall back without it (v0.5.x+)
    try:
        return pipeline.create(text, voice=voice, speed=speed, lang="en-us")
    except TypeError:
        return pipeline.create(text, voice=voice, speed=speed)


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="Kokoro TTS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "af_heart"
    speed: float = 1.0
    response_format: str = "wav"


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    if not req.input.strip():
        return JSONResponse(status_code=400, content={"error": "Empty input"})
    try:
        samples, sample_rate = synthesise(req.input.strip(), req.voice, req.speed)

        # Encode as 16-bit mono PCM WAV (no extra deps needed)
        pcm = (
            np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767
        ).astype(np.int16)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm.tobytes())
        buf.seek(0)
        return StreamingResponse(buf, media_type="audio/wav")

    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("", flush=True)
    print("  Kokoro TTS Server", flush=True)
    print("  ─────────────────────────────────────────", flush=True)
    ensure_models()
    print("  Loading Kokoro model...", flush=True)
    get_pipeline()
    print("  Ready on http://127.0.0.1:8880", flush=True)
    print("", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=8880, log_level="warning")

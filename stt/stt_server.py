#!/usr/bin/env python3
"""Local speech-to-text for DanGPT voice conversations.

faster-whisper on the GPU. POST /transcribe takes raw 16 kHz mono signed 16-bit PCM (what the
browser's microphone capture sends) and answers {"text": ...}. Silero VAD (bundled with
faster-whisper) drops clips that hold no speech, and a short blocklist catches Whisper's
favourite hallucinations on noise ("Thanks for watching!").

POST /youtube {"video": <id>} transcribes a whole YouTube video in the background (audio fetched
with yt-dlp), for videos that have no captions; GET /youtube/<id> gives progress and the result.

Environment:
  STT_MODEL     faster-whisper model name or path (default large-v3-turbo)
  STT_LANGUAGE  language code, or "auto" (default en)
  STT_DEVICE    cuda or cpu (default cuda)
  STT_PORT      port (default 8890)
"""

import os
import re
import sys
import threading
import time

# ── CUDA libraries (Windows) ──────────────────────────────────────────────────
# CTranslate2 needs cuBLAS and cuDNN. They're installed as pip wheels (nvidia-cublas-cu12,
# nvidia-cudnn-cu12); put their DLL folders on the search path before importing it.
# STT_CUDA_DLL_DIRS (";"-separated) can point at other folders holding them, e.g. a PyTorch
# install's torch\lib.
if sys.platform == "win32":
    import site

    dll_dirs = [d for d in os.environ.get("STT_CUDA_DLL_DIRS", "").split(";") if d]
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        for lib in ("cublas", "cudnn", "cuda_nvrtc"):
            dll_dirs.append(os.path.join(base, "nvidia", lib, "bin"))
    for bin_dir in dll_dirs:
        if os.path.isdir(bin_dir):
            os.add_dll_directory(bin_dir)
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")

# Transcripts can hold any characters; don't let a cp1252 console crash the server.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MODEL_NAME = os.environ.get("STT_MODEL", "large-v3-turbo")
LANGUAGE = os.environ.get("STT_LANGUAGE", "en")
DEVICE = os.environ.get("STT_DEVICE", "cuda")
PORT = int(os.environ.get("STT_PORT", "8890"))
SAMPLE_RATE = 16000
MAX_SECONDS = 60

# Whisper invents these on silence, breathing and keyboard noise.
HALLUCINATIONS = re.compile(
    r"^(thanks?( you)? for watching|please subscribe|subtitles? by|transcribed by|"
    r"(see you|bye)[ ,.!]*(next time|in the next video)|\[?(music|silence|blank_audio|applause)\]?|"
    r"♪+|\.+|you)[.!? ]*$",
    re.IGNORECASE,
)

model = None
load_error = None
lock = threading.Lock()  # one transcription at a time on the GPU


def load_model():
    global model, load_error
    try:
        from faster_whisper import WhisperModel

        t0 = time.time()
        print(f"  Loading Whisper '{MODEL_NAME}' on {DEVICE} (first run downloads it)...", flush=True)
        compute = "float16" if DEVICE == "cuda" else "int8"
        m = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=compute)
        # Warm up the exact decode path real requests use (beam search, and the Silero VAD), so
        # one-time kernel setup (CUDA JIT on new GPUs can take ~30 s) happens now, not mid-conversation.
        t = np.arange(SAMPLE_RATE * 2) / SAMPLE_RATE
        tone = (0.1 * np.sin(2 * np.pi * 220 * t) * (1 + np.sin(2 * np.pi * 3 * t))).astype(np.float32)
        for vad in (False, True):
            segs, _ = m.transcribe(tone, language="en", beam_size=5, temperature=0.0, without_timestamps=True,
                                   condition_on_previous_text=False, vad_filter=vad)
            list(segs)  # segments are generated lazily
        model = m
        print(f"  Whisper ready in {time.time() - t0:.1f}s on http://127.0.0.1:{PORT}", flush=True)
    except Exception as exc:  # surfaced through /health
        load_error = str(exc)
        print(f"  ERROR loading Whisper: {exc}", flush=True)


app = FastAPI(title="DanGPT STT")


@app.get("/health")
def health():
    if model is not None:
        return {"status": "ok", "model": MODEL_NAME}
    if load_error:
        return JSONResponse({"status": "error", "error": load_error}, status_code=500)
    return JSONResponse({"status": "loading"}, status_code=503)


@app.post("/transcribe")
async def transcribe(request: Request):
    if model is None:
        return JSONResponse({"error": "Whisper is still loading"}, status_code=503)

    raw = await request.body()
    if raw[:4] == b"RIFF":  # accept a WAV too: skip its 44-byte header
        raw = raw[44:]
    pcm = np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2")
    if pcm.size < SAMPLE_RATE // 10:
        return {"text": "", "duration": 0, "ms": 0}
    audio = pcm[: SAMPLE_RATE * MAX_SECONDS].astype(np.float32) / 32768.0

    lang = request.query_params.get("language") or LANGUAGE
    lang = None if lang == "auto" else lang
    prompt = request.query_params.get("prompt") or None  # e.g. recent context, to spell names right

    def run():
        with lock:
            t0 = time.time()
            segments, info = model.transcribe(
                audio,
                language=lang,
                beam_size=5,
                temperature=0.0,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 200},
                initial_prompt=prompt,
            )
            kept = []
            for seg in segments:
                if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                    continue
                kept.append(seg.text.strip())
            text = " ".join(t for t in kept if t).strip()
            if HALLUCINATIONS.match(text):
                text = ""
            return text, info, (time.time() - t0) * 1000

    import asyncio

    text, info, ms = await asyncio.get_running_loop().run_in_executor(None, run)
    dur = len(audio) / SAMPLE_RATE
    print(f"  [stt] {dur:4.1f}s audio -> {ms:4.0f} ms: {text[:80]!r}", flush=True)
    return {"text": text, "language": info.language, "duration": round(dur, 2), "ms": round(ms)}


# ── YouTube videos without captions ───────────────────────────────────────────
# POST /youtube {"video": id} downloads the audio (yt-dlp) and transcribes it in the background;
# GET /youtube/<id> reports progress, and the timestamped segments once it's done. The GPU lock is
# taken for one stretch of decoding at a time, so voice-mode requests still get through quickly.

YT_DIR = os.path.join(os.environ.get("TEMP") or os.environ.get("TMPDIR") or "/tmp", "dangpt-youtube")
CHUNK_SECONDS = 600  # decode and transcribe 10 minutes at a time (a 5-hour stream would be ~1 GB in one go)
jobs = {}
jobs_lock = threading.Lock()


def _audio_chunks(path, seconds):
    """16 kHz mono float32 audio, in pieces of `seconds`, with each piece's start time."""
    import av

    with av.open(path) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        buf, start, have = [], 0.0, 0
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                a = out.to_ndarray().reshape(-1)
                buf.append(a)
                have += a.size
                if have >= SAMPLE_RATE * seconds:
                    pcm = np.concatenate(buf)
                    yield start, pcm.astype(np.float32) / 32768.0
                    start += pcm.size / SAMPLE_RATE
                    buf, have = [], 0
        for out in resampler.resample(None):
            buf.append(out.to_ndarray().reshape(-1))
        if buf:
            pcm = np.concatenate(buf)
            if pcm.size:
                yield start, pcm.astype(np.float32) / 32768.0


def _youtube_job(job):
    vid = job["video"]
    try:
        import yt_dlp

        os.makedirs(YT_DIR, exist_ok=True)
        job["status"] = "downloading"

        def hook(d):
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if d.get("status") == "downloading" and total:
                job["download"] = round(100 * (d.get("downloaded_bytes") or 0) / total)

        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(YT_DIR, "%(id)s.%(ext)s"),
            "noplaylist": True, "quiet": True, "no_warnings": True, "noprogress": True,
            "fixup": "never", "progress_hooks": [hook],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
            path = ydl.prepare_filename(info)
        if info.get("is_live"):
            raise RuntimeError("it's live right now; it can be transcribed once the stream has finished")
        job.update(title=info.get("title"), duration=info.get("duration") or 0, status="transcribing", done_seconds=0)
        print(f"  [youtube] {vid}: transcribing {round(job['duration'] / 60)} min of audio", flush=True)

        from faster_whisper import BatchedInferencePipeline

        pipe = BatchedInferencePipeline(model=model)
        t0 = time.time()
        for offset, audio in _audio_chunks(path, CHUNK_SECONDS):
            segments, _ = pipe.transcribe(audio, language=job.get("language"), batch_size=8, beam_size=5,
                                          vad_filter=True, condition_on_previous_text=False)
            it = iter(segments)
            while True:
                with lock:  # one batch on the GPU at a time; voice requests slot in between
                    seg = next(it, None)
                if seg is None:
                    break
                text = seg.text.strip()
                if text and not HALLUCINATIONS.match(text):
                    job["segments"].append({"start": round(offset + seg.start, 1), "end": round(offset + seg.end, 1), "text": text})
                job["done_seconds"] = offset + seg.end
            job["done_seconds"] = offset + len(audio) / SAMPLE_RATE
        job["status"] = "done"
        print(f"  [youtube] {vid}: done in {time.time() - t0:.0f}s, {len(job['segments'])} segments", flush=True)
        try:
            os.remove(path)
        except OSError:
            pass
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc).replace("ERROR: ", "")[:300]
        print(f"  [youtube] {vid}: failed: {job['error']}", flush=True)


def _job_view(job, with_segments):
    keep = ("video", "status", "title", "duration", "done_seconds", "download", "error", "started")
    out = {k: job.get(k) for k in keep}
    if with_segments and job["status"] == "done":
        out["segments"] = job["segments"]
    return out


@app.post("/youtube")
async def youtube_start(request: Request):
    if model is None:
        return JSONResponse({"error": "Whisper is still loading"}, status_code=503)
    body = await request.json()
    vid = str(body.get("video") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
        return JSONResponse({"error": "bad video id"}, status_code=400)
    with jobs_lock:
        job = jobs.get(vid)
        if not job or job["status"] == "error":
            lang = body.get("language") or LANGUAGE
            job = jobs[vid] = {"video": vid, "status": "queued", "segments": [], "started": time.time(),
                               "language": None if lang == "auto" else lang}
            threading.Thread(target=_youtube_job, args=(job,), daemon=True).start()
    return _job_view(job, False)


@app.get("/youtube/{vid}")
def youtube_status(vid: str):
    job = jobs.get(vid)
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    return _job_view(job, True)


# ── Google Keep (keep_bridge.py) ──────────────────────────────────────────────
# For DanGPT's server only (this listens on 127.0.0.1): it signs in, makes notes and lists, and
# searches them. The sign-in token stays in ../data/keep.json.

async def _keep_call(fn, *args):
    import asyncio

    try:
        result = await asyncio.get_running_loop().run_in_executor(None, fn, *args)
        return result if result is not None else {"ok": True}
    except ImportError:
        return JSONResponse({"error": "gkeepapi isn't installed: restart DanGPT with launch.bat"}, status_code=500)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        print(f"  [keep] {exc}", flush=True)
        return JSONResponse({"error": str(exc)[:300]}, status_code=502)


@app.get("/keep/status")
def keep_status():
    import keep_bridge

    return keep_bridge.status()


@app.post("/keep/{action}")
async def keep_action(action: str, request: Request):
    import keep_bridge

    body = await request.json() if (await request.body()) else {}
    calls = {
        "connect": lambda: keep_bridge.connect(body.get("email"), body.get("token")),
        "disconnect": keep_bridge.disconnect,
        "note": lambda: keep_bridge.add_note(body.get("title"), body.get("text")),
        "list": lambda: keep_bridge.add_to_list(body.get("list"), body.get("items")),
        "tick": lambda: keep_bridge.tick(body.get("list"), body.get("items")),
        "find": lambda: keep_bridge.find(body.get("query")),
    }
    if action not in calls:
        return JSONResponse({"error": "no such action"}, status_code=404)
    return await _keep_call(calls[action])


if __name__ == "__main__":
    print("", flush=True)
    print("  DanGPT Speech-to-Text (faster-whisper)", flush=True)
    print("  -----------------------------------------", flush=True)
    threading.Thread(target=load_model, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

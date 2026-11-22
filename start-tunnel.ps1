# DanGPT voice chat launcher.
#
# Starts (if not already running):
#   Ollama            LLM                       :11434
#   Breeze TTS 2      voice                     :7860   ~9 GB VRAM (~16 GB with -BreezeFastAll), ~1-2 min warm-up
#   Whisper STT       speech recognition        :8890   ~2.5 GB VRAM
#   DanGPT server     the app + API             :8788
#   Cloudflare tunnel public https URL -> :8788 (optional: pass -NoTunnel to use it on this PC only)
#
# Options: -NoTunnel, -NoBrowser (with -NoTunnel: don't open a browser tab), -Model <ollama model>,
#          -BreezeFastAll (Breeze's full --fast-all: ~100 ms quicker to first audio, ~7 GB more VRAM;
#          only worth it on a 24 GB+ card)
#
# Breeze is reused if it's already up, so re-running this script doesn't pay the warm-up again.

param(
    [switch]$NoTunnel,
    [switch]$NoBrowser,
    [switch]$BreezeFastAll,
    [string]$Model = "llama3.2"   # pulled on first run if missing
)

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot

function Test-Url($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        return $r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Stop-Port($port, $name) {
    $conn = netstat -ano | Select-String ":$port " | Select-String "LISTENING"
    foreach ($c in $conn) {
        $procId = ($c -split '\s+')[-1].Trim()
        if ($procId -match '^\d+$' -and $procId -ne '0') {
            taskkill /F /PID $procId 2>$null | Out-Null
            Write-Host "Stopped old $name (PID $procId)"
        }
    }
}

# ---------- Prerequisites ---------------------------------------------------

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed. Get the LTS version from https://nodejs.org" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command "python" -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Python 3 is not installed. Get it from https://python.org" -ForegroundColor Red
    exit 1
}
$cloudflared = Join-Path $root "cloudflared-windows-amd64.exe"
if (-not $NoTunnel -and -not (Test-Path $cloudflared)) {
    Write-Host "cloudflared-windows-amd64.exe not found: running without a tunnel (this PC only)." -ForegroundColor Yellow
    $NoTunnel = $true
}

# ---------- Ollama ----------------------------------------------------------

if ((Test-Url "http://127.0.0.1:11434/api/version") -ne 200) {
    Write-Host "Starting Ollama..."
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Minimized
    Start-Sleep -Seconds 3
} else {
    Write-Host "Ollama is already running."
}
$haveModel = (& ollama list 2>$null | Select-String -SimpleMatch $Model)
if (-not $haveModel) {
    Write-Host "Pulling $Model..."
    & ollama pull $Model
}

# ---------- Breeze TTS 2 -----------------------------------------------------
#
# By default only the per-token stages run as CUDA graphs (backbone decode, depth decoder, codec).
# Those set the real-time speed. --fast-all adds ~54 text-encoder/prefill graphs, which only shave
# ~100 ms off the first audio of each sentence but hold ~7 GB of VRAM. On a 16 GB card that pushes
# Breeze, Whisper and Ollama into shared system memory, which is far slower than staying in VRAM.
# Measured on Windows (RTX 5090): --fast-all 16.0 GB, 3.4x real time, 106 ms to first audio;
# default 9.2 GB, 3.2x real time, ~220 ms to first audio.

$breezeDir = if ($env:BREEZE_DIR) { $env:BREEZE_DIR } else { Join-Path $root "..\..\breeze-tts" }
$breezeDir = [System.IO.Path]::GetFullPath($breezeDir)
$breezePy  = Join-Path $breezeDir ".venv\Scripts\python.exe"
$breezeStatus = Test-Url "http://127.0.0.1:7860/health"

if ($breezeStatus -eq 200) {
    Write-Host "Breeze TTS is already running (warm)."
} elseif ($breezeStatus -eq 503) {
    Write-Host "Breeze TTS is already starting up (still warming up)."
} elseif (Test-Path $breezePy) {
    $breezeFlags = if ($BreezeFastAll) { @("--fast-all") } else { @("--fast-backbone-decode", "--fast-depth-decoder", "--fast-codec") }
    Write-Host ""
    Write-Host "Starting Breeze TTS ($($breezeFlags -join ' '); warms up for ~1-2 minutes)..." -ForegroundColor Cyan
    Write-Host "  The browser voice stands in until it's ready."
    # Inductor's static CUDA launcher overflows a 32-bit C long on Windows, so it's switched off.
    $env:TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER = "0"
    Start-Process $breezePy `
        -ArgumentList (@("-m", "breeze_infer.api", "BreezeBlue/breeze-tts-2", "--host", "127.0.0.1", "--port", "7860") + $breezeFlags) `
        -WorkingDirectory $breezeDir -WindowStyle Minimized
} else {
    Write-Host "Breeze TTS not found at $breezeDir (set BREEZE_DIR to its folder). Using the browser voice." -ForegroundColor Yellow
}

# ---------- Whisper speech-to-text ------------------------------------------

$sttDir    = Join-Path $root "stt"
$sttPy     = Join-Path $sttDir ".venv\Scripts\python.exe"
$sttScript = Join-Path $sttDir "stt_server.py"

Stop-Port 8890 "Whisper STT"

if (-not (Test-Path $sttPy)) {
    Write-Host ""
    Write-Host "Creating the speech-recognition environment (one-time)..." -ForegroundColor Cyan
    python -m venv (Join-Path $sttDir ".venv")
}
& $sttPy -c "import faster_whisper, yt_dlp, gkeepapi" 2>$null
if ($LASTEXITCODE -ne 0) {
    & $sttPy -m pip install --upgrade pip --quiet
    & $sttPy -m pip install -r (Join-Path $sttDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install speech-recognition dependencies." -ForegroundColor Red
        exit 1
    }
} else {
    # yt-dlp (for transcribing YouTube videos that have no captions) stops working when YouTube
    # changes things, and new versions follow quickly: keep it current. Not fatal if offline.
    & $sttPy -m pip install --upgrade --quiet --disable-pip-version-check yt-dlp gkeepapi 2>$null
}
# CTranslate2 needs cuBLAS 12 + cuDNN 9: borrow them from Breeze's PyTorch if it's there,
# otherwise install them as NVIDIA's pip wheels (~1 GB).
$torchLib = Join-Path $breezeDir ".venv\Lib\site-packages\torch\lib"
if (Test-Path (Join-Path $torchLib "cudnn64_9.dll")) {
    $env:STT_CUDA_DLL_DIRS = $torchLib
} elseif (-not (Test-Path (Join-Path $sttDir ".venv\Lib\site-packages\nvidia\cudnn"))) {
    Write-Host "Installing CUDA libraries for speech recognition (~1 GB, one-time)..." -ForegroundColor Cyan
    & $sttPy -m pip install -r (Join-Path $sttDir "requirements-cuda.txt")
}
Write-Host "Starting Whisper speech recognition (first run downloads the model, ~1.6 GB)..."
Start-Process $sttPy -ArgumentList "`"$sttScript`"" -WorkingDirectory $sttDir -WindowStyle Minimized

# ---------- DanGPT server ---------------------------------------------------

Stop-Port 8788 "DanGPT server"
Write-Host "Starting the DanGPT server..."
Start-Process "node" -ArgumentList "`"$(Join-Path $root 'server.js')`"" -WorkingDirectory $root -WindowStyle Minimized
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "------------------------------------------------------------" -ForegroundColor Green
Write-Host " On this PC: http://localhost:8788" -ForegroundColor Green
if ($NoTunnel) {
    Write-Host "------------------------------------------------------------" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process "http://localhost:8788" }
    exit 0
}
Write-Host " Anywhere else: open the trycloudflare.com URL shown below."
Write-Host " (Or paste it into Settings > Server URL in a copy hosted elsewhere.)"
Write-Host "------------------------------------------------------------" -ForegroundColor Green
Write-Host ""

& $cloudflared tunnel --url http://127.0.0.1:8788

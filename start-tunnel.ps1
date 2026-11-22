# DanGPT voice chat launcher.
#
# Starts (if not already running):
#   Ollama            LLM                       :11434
#   Breeze TTS 2      voice (Breeze-TTS-2.cpp)  :7860   ~4 GB VRAM, ~5 s start-up
#   Whisper STT       speech recognition        :8890   on the CPU (small.en)
#   DanGPT server     the app + API             :8788
#   Cloudflare tunnel public https URL -> :8788 (optional: pass -NoTunnel to use it on this PC only)
#
# Options: -NoTunnel, -NoBrowser (with -NoTunnel: don't open a browser tab), -Model <ollama model>,
#          -BreezePyTorch  use the official PyTorch Breeze instead of Breeze-TTS-2.cpp (~9 GB VRAM)
#          -BreezeFastAll  with -BreezePyTorch: its full --fast-all (~16 GB VRAM, 24 GB+ cards only)
#          -WhisperOnGpu   run Whisper large-v3-turbo on the GPU (~2.5 GB VRAM) instead of the CPU
#
# Breeze is reused if it's already up, so re-running this script doesn't pay the warm-up again.

param(
    [switch]$NoTunnel,
    [switch]$NoBrowser,
    [switch]$BreezePyTorch,
    [switch]$BreezeFastAll,
    [switch]$WhisperOnGpu,
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
# Default: Breeze-TTS-2.cpp (github.com/HoppouAI/Breeze-TTS-2.cpp) built with CUDA, Q8_0 weights.
# It serves the same /v1/audio/speech API as the official server. Measured on Windows (RTX 5090):
#   Breeze-TTS-2.cpp, CUDA, Q8_0         4.1 GB   4.0x real time    ~90 ms to first audio
#   PyTorch, per-token CUDA graphs       9.2 GB   3.2x real time   ~220 ms
#   PyTorch --fast-all                  16.0 GB   3.4x real time   ~105 ms
# Use the CUDA build: the project's prebuilt Vulkan release ran at only 0.7-1.0x real time on an
# RTX 50-series card. BREEZE_CPP_DIR is a folder holding cuda-bin\ (breeze-server.exe and its DLLs)
# and models\. The model is downloaded on first run.
#
# The PyTorch server (-BreezePyTorch) runs only the per-token stages as CUDA graphs by default.
# --fast-all adds ~54 text-encoder/prefill graphs that hold ~7 GB of VRAM for ~100 ms less delay.

$breezeDir = if ($env:BREEZE_DIR) { $env:BREEZE_DIR } else { Join-Path $root "..\..\breeze-tts" }
$breezeDir = [System.IO.Path]::GetFullPath($breezeDir)
$pyBreezeDir = $breezeDir
$breezePy  = Join-Path $breezeDir ".venv\Scripts\python.exe"
$cppDir    = if ($env:BREEZE_CPP_DIR) { $env:BREEZE_CPP_DIR } else { Join-Path $root "..\..\breeze-tts-cpp" }
$cppDir    = [System.IO.Path]::GetFullPath($cppDir)
$cppServer = Join-Path $cppDir "cuda-bin\breeze-server.exe"
$cppModel  = Join-Path $cppDir "models\breeze-tts-2-q8_0.gguf"
$cppModelUrl    = "https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf"
$cppModelSha256 = "a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879"
$useCpp = (-not $BreezePyTorch) -and (Test-Path $cppServer)
if (-not $BreezePyTorch -and -not $useCpp) {
    Write-Host "Breeze-TTS-2.cpp not found at $cppServer (set BREEZE_CPP_DIR). Falling back to PyTorch Breeze." -ForegroundColor Yellow
}
$breezeStatus = Test-Url "http://127.0.0.1:7860/health"

if ($breezeStatus -eq 200) {
    Write-Host "Breeze TTS is already running (warm)."
} elseif ($breezeStatus -eq 503) {
    Write-Host "Breeze TTS is already starting up (still warming up)."
} elseif ($useCpp -and (Get-Process breeze-server -ErrorAction SilentlyContinue)) {
    # breeze-server doesn't answer until its model is loaded, so a starting one looks like nothing.
    Write-Host "Breeze-TTS-2.cpp is already starting up."
} elseif ($useCpp) {
    if (-not (Test-Path $cppModel)) {
        Write-Host ""
        Write-Host "Downloading the Breeze-TTS-2.cpp Q8_0 model (~3.6 GB, one-time)..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force (Split-Path $cppModel) | Out-Null
        & curl.exe -L --fail -o "$cppModel.part" $cppModelUrl
        $hash = if (Test-Path "$cppModel.part") { (Get-FileHash "$cppModel.part" -Algorithm SHA256).Hash.ToLower() } else { "" }
        if ($hash -eq $cppModelSha256) {
            Move-Item "$cppModel.part" $cppModel
        } else {
            Remove-Item "$cppModel.part" -ErrorAction SilentlyContinue
            Write-Host "ERROR: the Breeze model download failed or didn't match its checksum. Using the browser voice." -ForegroundColor Red
        }
    }
    if (Test-Path $cppModel) {
        Write-Host ""
        Write-Host "Starting Breeze-TTS-2.cpp (CUDA, Q8_0)..." -ForegroundColor Cyan
        # --ws-port -1: its WebSocket API isn't used, and it would otherwise take port 7861.
        Start-Process $cppServer `
            -ArgumentList "`"$cppModel`"", "--host", "127.0.0.1", "--port", "7860", "--ws-port", "-1" `
            -WorkingDirectory $cppDir -WindowStyle Minimized
    }
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
# Whisper runs on the CPU by default so the GPU is left for Breeze and Ollama. large-v3-turbo
# takes ~5.5 s per utterance on a CPU, but small.en takes ~1.7 s (Ryzen 5900X). -WhisperOnGpu puts
# it back on the GPU with large-v3-turbo (~2.5 GB VRAM, ~0.2 s). STT_DEVICE / STT_MODEL override both.
if (-not $env:STT_DEVICE) { $env:STT_DEVICE = if ($WhisperOnGpu) { "cuda" } else { "cpu" } }
if (-not $env:STT_MODEL)  { $env:STT_MODEL  = if ($env:STT_DEVICE -eq "cpu") { "small.en" } else { "large-v3-turbo" } }
if ($env:STT_DEVICE -ne "cpu") {
    # CTranslate2 needs cuBLAS 12 + cuDNN 9: borrow them from Breeze's PyTorch if it's there,
    # otherwise install them as NVIDIA's pip wheels (~1 GB).
    $torchLib = Join-Path $pyBreezeDir ".venv\Lib\site-packages\torch\lib"
    if (Test-Path (Join-Path $torchLib "cudnn64_9.dll")) {
        $env:STT_CUDA_DLL_DIRS = $torchLib
    } elseif (-not (Test-Path (Join-Path $sttDir ".venv\Lib\site-packages\nvidia\cudnn"))) {
        Write-Host "Installing CUDA libraries for speech recognition (~1 GB, one-time)..." -ForegroundColor Cyan
        & $sttPy -m pip install -r (Join-Path $sttDir "requirements-cuda.txt")
    }
}
Write-Host "Starting Whisper speech recognition ($env:STT_MODEL on $env:STT_DEVICE; first run downloads the model)..."
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

# Starts Kokoro TTS, the chat server, and opens a Cloudflare tunnel.
# Ollama must already be running (or run the calorie logger's start-tunnel.ps1 first).

$model = "llama3.2"   # Change to match the model you want to use

# ---------- Prerequisites ---------------------------------------------------

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: Node.js is not installed." -ForegroundColor Red
    Write-Host "Download it from https://nodejs.org (LTS version)" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command "python" -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: Python 3 is not installed." -ForegroundColor Red
    Write-Host "Download it from https://python.org" -ForegroundColor Red
    exit 1
}

$cloudflared = Join-Path $PSScriptRoot "cloudflared-windows-amd64.exe"
if (-not (Test-Path $cloudflared)) {
    Write-Host ""
    Write-Host "ERROR: cloudflared-windows-amd64.exe not found in this folder." -ForegroundColor Red
    Write-Host "Copy it from the calorie logger folder, or download it from:" -ForegroundColor Red
    Write-Host "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" -ForegroundColor Red
    exit 1
}

# ---------- Ollama ----------------------------------------------------------

$conn = netstat -ano | Select-String "8788" | Select-String "LISTENING"
if ($conn) {
    $oldPid = ($conn -split '\s+')[-1].Trim()
    if ($oldPid -match '^\d+$') {
        taskkill /F /PID $oldPid 2>$null | Out-Null
        Write-Host "Stopped old chat server (PID $oldPid)"
    }
}

$ollamaRunning = Get-Process "ollama" -ErrorAction SilentlyContinue
if (-not $ollamaRunning) {
    Write-Host "Starting Ollama..."
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Minimized -Environment @{ OLLAMA_ORIGINS = "*" }
    Start-Sleep -Seconds 3
    & ollama pull $model
} else {
    Write-Host "Ollama is already running."
}

# ---------- Kokoro TTS ------------------------------------------------------

$ttsDir       = Join-Path $PSScriptRoot "tts"
$venvDir      = Join-Path $ttsDir "venv"
$venvPython   = Join-Path $venvDir "Scripts\python.exe"
$venvPip      = Join-Path $venvDir "Scripts\pip.exe"
$venvUvicorn  = Join-Path $venvDir "Scripts\uvicorn.exe"
$kokoroScript = Join-Path $ttsDir "kokoro_server.py"
$requirements = Join-Path $ttsDir "requirements.txt"

$kConn = netstat -ano | Select-String ":8880 " | Select-String "LISTENING"
if ($kConn) {
    $kPid = ($kConn -split '\s+')[-1].Trim()
    if ($kPid -match '^\d+$') {
        taskkill /F /PID $kPid 2>$null | Out-Null
        Write-Host "Stopped old Kokoro server (PID $kPid)"
    }
}

if (-not (Test-Path $venvPython)) {
    Write-Host ""
    Write-Host "Creating Kokoro virtual environment (one-time setup)..." -ForegroundColor Cyan
    python -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to create Python venv." -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path $venvUvicorn)) {
    Write-Host ""
    Write-Host "Installing Kokoro dependencies - this may take a minute..." -ForegroundColor Cyan
    & $venvPip install --upgrade pip --quiet
    & $venvPip install -r $requirements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install Kokoro dependencies." -ForegroundColor Red
        exit 1
    }
    Write-Host "Dependencies installed." -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting Kokoro TTS server..."
Write-Host "(On first run it downloads ~114 MB of model files - check the Kokoro window for progress)"
Start-Process $venvPython -ArgumentList $kokoroScript -WorkingDirectory $ttsDir -WindowStyle Minimized
Start-Sleep -Seconds 4

# ---------- Chat server -----------------------------------------------------

Write-Host ""
Write-Host "Starting chat server..."
$serverScript = Join-Path $PSScriptRoot "server.js"
Start-Process "node" -ArgumentList $serverScript -WindowStyle Minimized
Start-Sleep -Seconds 2

# ---------- Cloudflare tunnel -----------------------------------------------

Write-Host ""
Write-Host "Opening Cloudflare tunnel..."
Write-Host "------------------------------------------------------------"
Write-Host "When the URL appears below, copy it and paste it into"
Write-Host "the app Settings (gear icon) as the Cloudflare Tunnel URL."
Write-Host "------------------------------------------------------------"
Write-Host ""

& $cloudflared tunnel --url http://localhost:8788

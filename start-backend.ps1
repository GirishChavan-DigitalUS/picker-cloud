# Picker backend — start script for Windows
# Requires Python 3.11 at C:\Users\WA0G74\AppData\Local\Programs\Python\Python311\python.exe
# Adjust PYTHON path if yours differs

$PYTHON = "C:\Users\WA0G74\AppData\Local\Programs\Python\Python311\python.exe"
$BACKEND = "$PSScriptRoot\backend"

# ---------------------------------------------------------------------------
# LLM Commentary (optional)
# Set LLM_PROVIDER to one of: gemini | openai | anthropic | ollama | disabled
#
# Gemini Flash (free, no credit card):
#   Get key at https://aistudio.google.com → "Get API key"
#
# Uncomment and fill in the provider + key you want to use:
# ---------------------------------------------------------------------------

$env:LLM_PROVIDER = "gemini"      # change to "gemini", "openai", "anthropic", or "ollama"
$env:LLM_API_KEY  = ""              # paste your API key here (leave blank for ollama/disabled)
# $env:LLM_MODEL  = ""              # optional: override default model for the chosen provider
# $env:OLLAMA_BASE_URL = "http://localhost:11434"  # only needed if Ollama runs on a different port

# ---------------------------------------------------------------------------
# Authentication (cookie-based login)
# ---------------------------------------------------------------------------
# For local dev you can use a simple plaintext fallback instead of an htpasswd
# file. Either set DEV_USER/DEV_PASS here, OR point PICKER_HTPASSWD_PATH at a
# file you created with `htpasswd -B`.
$env:PICKER_DEV_USER       = "admin"
$env:PICKER_DEV_PASS       = "admin"           # change this!
$env:PICKER_COOKIE_SECURE  = "0"               # local dev runs over HTTP
$env:PICKER_AUTH_SECRET    = "dev-only-secret-change-in-prod-please-32+chars"
# $env:PICKER_HTPASSWD_PATH = "$PSScriptRoot\deploy\.htpasswd-picker.local"

# ---------------------------------------------------------------------------
# Other optional overrides
# ---------------------------------------------------------------------------
# $env:FETCH_INTERVAL = "60"        # scheduler interval in seconds (default 60 = 1 min)
# $env:DB_PATH = ""                 # custom path to picker.db

Set-Location $BACKEND

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    & $PYTHON -m venv .venv
    & ".venv\Scripts\pip.exe" install -r requirements.txt
}

Write-Host "Starting FastAPI backend on http://localhost:8000 ..." -ForegroundColor Green
if ($env:LLM_PROVIDER -ne "disabled" -and $env:LLM_PROVIDER -ne "") {
    Write-Host "LLM commentary enabled  provider=$($env:LLM_PROVIDER)" -ForegroundColor Cyan
} else {
    Write-Host "LLM commentary disabled (set LLM_PROVIDER in this script to enable)" -ForegroundColor DarkGray
}
& ".venv\Scripts\uvicorn.exe" main:app --host 0.0.0.0 --port 8000

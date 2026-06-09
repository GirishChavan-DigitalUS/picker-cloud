param(
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$RecreateVenv
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[setup] $Message" -ForegroundColor Cyan
}

function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @("py", "-3.11")
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @("python")
    }
    throw "Python not found. Install Python 3.11+ and retry."
}

function Ensure-Pnpm {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        return
    }

    Write-Step "pnpm not found. Attempting to enable via corepack..."
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
        throw "pnpm not found and corepack is unavailable. Install pnpm manually and retry."
    }

    & corepack enable
    & corepack prepare pnpm@latest --activate

    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        throw "pnpm setup failed. Install pnpm manually and retry."
    }
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"
$VenvDir = Join-Path $BackendDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

Write-Step "Repository root: $RepoRoot"

if (-not $SkipBackend) {
    Write-Step "Setting up backend..."

    if ($RecreateVenv -and (Test-Path $VenvDir)) {
        Write-Step "Removing existing backend virtual environment..."
        Remove-Item -Recurse -Force $VenvDir
    }

    if (-not (Test-Path $VenvPython)) {
        Write-Step "Creating backend virtual environment..."
        $pyCmd = Get-PythonCommand
        if ($pyCmd.Length -eq 2) {
            & $pyCmd[0] $pyCmd[1] -m venv $VenvDir
        } else {
            & $pyCmd[0] -m venv $VenvDir
        }
    }

    Write-Step "Installing backend requirements..."
    & $VenvPython -m pip install --upgrade pip
    & $VenvPython -m pip install -r (Join-Path $BackendDir "requirements.txt")
}

if (-not $SkipFrontend) {
    Write-Step "Setting up frontend..."
    Ensure-Pnpm
    Push-Location $FrontendDir
    try {
        & pnpm install
    } finally {
        Pop-Location
    }
}

Write-Host "";
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1) Start backend: .\start-backend.ps1"
Write-Host "  2) Start frontend: .\start-frontend.bat"

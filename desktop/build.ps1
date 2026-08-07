# Builds the distributable .exe.
#
#   cd desktop
#   ./build.ps1
#
# Output: desktop/dist/IMECO Price Tracker.exe — a single file needing no Python install on
# the machine it runs on.
#
# No secrets are baked in. The app collects the Supabase URL and service_role key on first
# launch and stores them in Windows Credential Manager, so this .exe is safe to copy to
# another staff PC.

# "Continue", not "Stop", and that is deliberate. Under Windows PowerShell 5.1 anything a
# native .exe writes to stderr is re-raised as a NativeCommandError, so with "Stop" a single
# PyInstaller WARNING (it emits one about conda-meta on every venv build) aborts a build that
# was about to succeed. Every native call below is checked on $LASTEXITCODE instead, which is
# the only signal that actually means failure.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

# ── Why an isolated environment, and not just the interpreter on PATH ────────────────────
#
# PyInstaller bundles what it can reach. Built from the conda base environment this produced a
# 223 MB executable: numpy, matplotlib, PyQt6, IPython, jedi, zmq, lxml, sqlite and the whole
# MKL stack came along, because they were installed, not because anything here imports them.
#
# A throwaway venv holding only requirements.txt is the fix, and it is also the only way the
# build is reproducible — otherwise the size and contents of the .exe depend on whatever the
# person building it happens to have installed.
$venv = Join-Path $PSScriptRoot ".buildenv"
$py = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $py)) {
  Write-Host "Creating an isolated build environment..." -ForegroundColor Cyan
  python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "could not create the build venv" }
}

Write-Host "Installing build dependencies..." -ForegroundColor Cyan
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet --upgrade -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }

# The real pricing sheet is deliberately NOT in git — this repo is public and that file is
# IMECO's pricing strategy. A fresh clone therefore has only the example, which is enough to
# produce a working .exe: it starts up, and the operator points it at the real sheet through
# the Spreadsheet button. Building against the real sheet, when present, just saves them a step.
$sheet = Join-Path $PSScriptRoot "..\Docs\pricing link.xlsx"
if (-not (Test-Path $sheet)) {
  $sheet = Join-Path $PSScriptRoot "..\Docs\pricing link.example.xlsx"
  Write-Host "No Docs/pricing link.xlsx - bundling the example sheet instead." -ForegroundColor Yellow
  Write-Host "The operator supplies the real one via the app's Spreadsheet button." -ForegroundColor Gray
}
if (-not (Test-Path $sheet)) { throw "no workbook to bundle: $sheet" }

Write-Host "Building..." -ForegroundColor Cyan

# --windowed suppresses the console; the GUI is the interface. The scheduled task runs the
# same binary with --silent, which takes the headless path in app.py.
#
# The workbook is bundled as the STARTING sheet, not the only one: a fresh .exe works on a
# machine that has never seen the spreadsheet, and the operator can then swap in a newer one
# through the Spreadsheet button, which stores it in %LOCALAPPDATA% and takes precedence from
# the next run onward. So editing the sheet no longer requires a rebuild — see
# catalogue.active_workbook().
#
# The excludes are belt-and-braces for the venv above. If someone builds with the system
# interpreter anyway, these keep the worst offenders out.
& $py -m PyInstaller `
  --onefile `
  --windowed `
  --clean `
  --noconfirm `
  --name "IMECO Price Tracker" `
  --add-data "$sheet;Docs" `
  --hidden-import "keyring.backends.Windows" `
  --exclude-module numpy `
  --exclude-module matplotlib `
  --exclude-module PyQt5 `
  --exclude-module PyQt6 `
  --exclude-module PySide6 `
  --exclude-module IPython `
  --exclude-module jedi `
  --exclude-module zmq `
  --exclude-module lxml `
  --exclude-module PIL `
  --exclude-module pandas `
  --exclude-module scipy `
  --exclude-module pytest `
  desktop_entry.py

if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $PSScriptRoot "dist\IMECO Price Tracker.exe"
$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "`nBuilt: $exe ($size MB)" -ForegroundColor Green
Write-Host "First launch will prompt for the Supabase URL and service_role key." -ForegroundColor Gray

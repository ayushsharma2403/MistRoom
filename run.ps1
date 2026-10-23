#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

Write-Host "[MistRoom] Starting server..." -ForegroundColor Cyan
try {
    python -m backend.server
} catch {
    Write-Host "[MistRoom] Retrying with dependency installation..." -ForegroundColor Yellow
    pip install -r requirements.txt
    python -m backend.server
}

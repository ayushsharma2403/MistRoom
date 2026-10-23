@echo off
setlocal
cd /d "%~dp0"

echo [MistRoom] Starting server...
python -m backend.server

if %ERRORLEVEL% neq 0 (
    echo [MistRoom] Python failed to start. Ensuring dependencies are installed...
    pip install -r requirements.txt
    python -m backend.server
)

pause

@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Training environment missing. Follow README.md setup first.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8765 in your browser after the server starts.
".venv\Scripts\python.exe" scripts\launch_sumo_ui.py
pause

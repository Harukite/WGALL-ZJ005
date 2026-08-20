@echo off
setlocal EnableExtensions
set "GRIDBOT_EXIT=1"

cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot enter the program directory.
  goto failure
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found.
  goto failure
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-launcher.ps1"
set "GRIDBOT_EXIT=%ERRORLEVEL%"
if not "%GRIDBOT_EXIT%"=="0" goto failure
goto done

:failure
echo.
echo [ERROR] Grid Bot launcher failed. Exit code: %GRIDBOT_EXIT%
echo The detailed error is shown above. Please take a screenshot of this window.
echo See the FAQ document in the docs directory.
echo.
pause

:done
endlocal & exit /b %GRIDBOT_EXIT%

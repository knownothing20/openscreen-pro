@echo off
REM OpenScreen - launch the dev build, rebuilding first when the source has moved.
REM
REM Wraps OpenScreen-Dev.ps1 so it can be double-clicked or used as a shortcut target.
REM The desktop shortcut currently points straight at electron.exe, which runs whatever
REM dist\ + dist-electron\ hold from the last build - silently stale after any code change.
REM
REM Point the shortcut here instead, or copy this file to the desktop.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0OpenScreen-Dev.ps1" %*

REM Keep the window open on failure so the reason is readable when launched by double-click.
if errorlevel 1 (
    echo.
    echo Build or launch failed - see the messages above.
    pause
)

@echo off
cd /d "%~dp0"
if exist "%~dp0dist\electron\win-unpacked\Orbit.exe" (
    start "" "%~dp0dist\electron\win-unpacked\Orbit.exe"
) else (
    call npx electron .
)

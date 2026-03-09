@echo off
chcp 65001 >nul 2>&1
title ESP32 Web Tester - TCP/UDP Relay
color 0A

echo.
echo   ====================================================
echo    ESP32 Web Tester - TCP/UDP Relay Launcher
echo   ====================================================
echo.

:: --- Check if Node.js is available ---
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [OK] Node.js detecte.
    goto :run_relay
)

:: --- Check portable node in this folder ---
if exist "%~dp0node\node.exe" (
    echo   [OK] Node.js portable detecte.
    set "PATH=%~dp0node;%PATH%"
    goto :run_relay
)

:: --- Node.js not found - download portable version ---
echo   [!!] Node.js non trouve.
echo.
echo   Telechargement de Node.js portable...
echo.

if not exist "%~dp0node" mkdir "%~dp0node"

set "NODE_URL=https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"
set "NODE_ZIP=%~dp0node\node.zip"
set "NODE_DIR=%~dp0node"

powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing"

if not exist "%NODE_ZIP%" (
    echo.
    echo   [ERREUR] Echec du telechargement.
    echo   Installez Node.js manuellement : https://nodejs.org
    pause
    exit /b 1
)

echo   Extraction...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%NODE_DIR%' -Force"

for /d %%D in ("%NODE_DIR%\node-v*") do (
    xcopy "%%D\*" "%NODE_DIR%\" /E /Y /Q >nul 2>&1
    rmdir "%%D" /S /Q >nul 2>&1
)

del "%NODE_ZIP%" >nul 2>&1

if not exist "%NODE_DIR%\node.exe" (
    echo   [ERREUR] Extraction echouee.
    pause
    exit /b 1
)

echo   [OK] Node.js portable installe.
set "PATH=%NODE_DIR%;%PATH%"

:run_relay
echo.
node --version
echo.
echo   Demarrage du relay TCP/UDP...
echo   Gardez cette fenetre ouverte.
echo   Ctrl+C pour arreter.
echo.

cd /d "%~dp0"
node relay.js

echo.
echo   Relay arrete.
pause

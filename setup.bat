@echo off
chcp 65001 >nul 2>&1
title ESP32 Web Tester - Setup
color 0B

echo.
echo   ====================================================
echo    ESP32 Web Tester - Setup Electron App
echo   ====================================================
echo.

:: --- Check Node.js ---
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   [OK] Node.js detecte.
    goto :check_npm
)

if exist "%~dp0node\node.exe" (
    echo   [OK] Node.js portable detecte.
    set "PATH=%~dp0node;%PATH%"
    goto :check_npm
)

echo   [!!] Node.js non trouve. Telechargement...
if not exist "%~dp0node" mkdir "%~dp0node"
set "NODE_URL=https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"
set "NODE_ZIP=%~dp0node\node.zip"
set "NODE_DIR=%~dp0node"

powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing"

if not exist "%NODE_ZIP%" (
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
set "PATH=%NODE_DIR%;%PATH%"
echo   [OK] Node.js installe.

:check_npm
echo.
cd /d "%~dp0"

if exist "node_modules" goto :deps_ok

echo   Installation des dependances npm...
echo   Cela peut prendre quelques minutes la premiere fois.
echo.
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo   [ERREUR] npm install a echoue.
    pause
    exit /b 1
)
echo.
echo   [OK] Dependances installees.
goto :menu

:deps_ok
echo   [OK] Dependances deja presentes.

:menu
echo.
echo   ====================================================
echo    Que voulez-vous faire ?
echo.
echo    1 - Lancer l'app en mode dev
echo    2 - Compiler l'exe installable
echo    3 - Compiler + publier sur GitHub
echo   ====================================================
echo.
set /p CHOICE="  Votre choix [1/2/3] : "

if "%CHOICE%"=="1" goto :run_dev
if "%CHOICE%"=="2" goto :build_exe
if "%CHOICE%"=="3" goto :publish
goto :run_dev

:run_dev
echo.
:: --- Auto-update from git ---
where git >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    if exist "%~dp0.git" (
        echo   Verification des mises a jour...
        cd /d "%~dp0"
        git pull --ff-only origin main >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            echo   [OK] Application a jour.
        ) else (
            echo   [--] Pas de mise a jour ou hors-ligne.
        )
        :: Reinstall deps if package.json changed
        git diff --name-only HEAD@{1} HEAD 2>nul | findstr "package.json" >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            echo   Mise a jour des dependances...
            call npm install
        )
        echo.
    )
)
echo   Lancement de l'application...
call npx electron .
goto :end

:build_exe
echo.
echo   Compilation en cours...
call npx electron-builder --win
echo.
echo   [OK] L'exe se trouve dans le dossier .\dist\
explorer "dist"
goto :end

:publish
echo.
echo   IMPORTANT: Configurez d'abord package.json
echo     build.publish.owner = votre username GitHub
echo     build.publish.repo  = nom du repo
echo   Et definissez la variable GH_TOKEN :
echo     set GH_TOKEN=votre_token_github
echo.
set /p CONFIRM="  Continuer ? [o/n] : "
if /i not "%CONFIRM%"=="o" goto :end
echo.
echo   Build + publication sur GitHub...
call npx electron-builder --win --publish always
echo.
echo   [OK] Publication terminee.

:end
echo.
pause

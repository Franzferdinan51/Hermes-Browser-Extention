@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ENVFILE=%USERPROFILE%\.hermes\.env"

if not exist "%ENVFILE%" (
  echo Could not find %ENVFILE%
  echo Hermes Browser Extension needs API_SERVER_KEY from your Hermes .env file.
  pause
  exit /b 1
)

set "KEY="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "API_SERVER_KEY=" "%ENVFILE%"`) do set "KEY=%%B"

if not defined KEY (
  echo API_SERVER_KEY was not found in %ENVFILE%
  echo Run Hermes gateway/API setup first, then try again.
  pause
  exit /b 1
)

<nul set /p "=!KEY!" | clip
echo Hermes Browser Extension API key copied to clipboard.
echo Paste it into the extension settings API key field, then click Test connection.
pause

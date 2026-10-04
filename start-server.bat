@echo off
title FB Ad Lead Finder - Server
cd /d "%~dp0server"
if not exist node_modules (
  echo Installing packages for the first time...
  call npm install
)
if not exist "..\dashboard\dist\index.html" (
  echo Building dashboard for the first time...
  pushd "..\dashboard"
  if not exist node_modules call npm install
  call npm run build
  popd
)
echo.
echo  Dashboard: http://localhost:4000
echo  To stop the server, press Ctrl+C in this window (or close it)
echo.
start "" http://localhost:4000
node src/index.js
pause

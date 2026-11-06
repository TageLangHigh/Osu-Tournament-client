@echo off
title Matchdeck
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js fehlt. Bitte Node 22 oder neuer installieren. & pause & exit /b 1)
start "" "http://127.0.0.1:7270/"
node server/index.js
pause

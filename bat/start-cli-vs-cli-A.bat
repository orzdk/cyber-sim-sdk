@echo off

cd /d %~dp0..

set SERVER_URL=%1
if "%SERVER_URL%"=="" set SERVER_URL=https://punksim.net

set MY_DECK=%2
if "%MY_DECK%"=="" set MY_DECK=RRG_Arasaka_Onslaught

set PAIR_KEY=%3
if "%PAIR_KEY%"=="" set PAIR_KEY=123456-cli-pair

echo Starting CLI bot A (cli-vs-cli)
echo   server   = %SERVER_URL%
echo   my deck  = %MY_DECK%
echo   pair key = %PAIR_KEY%
echo.
echo Waiting for peer to connect with the same --key...
echo.

node server-ai-mybot-v2.js ^
  --server %SERVER_URL% ^
  --name CliA ^
  --deck %MY_DECK% ^
  --clivscli ^
  --key %PAIR_KEY% ^
  --human

pause

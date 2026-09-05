@echo off

cd /d %~dp0..

set SERVER_URL=%1
if "%SERVER_URL%"=="" set SERVER_URL=https://punksim.net

set MY_DECK=%2
if "%MY_DECK%"=="" set MY_DECK=RRG_Arasaka_Onslaught

set OPP_BOT=%3
if "%OPP_BOT%"=="" set OPP_BOT=punkbot-simple-plus

set OPP_DECK=%4
if "%OPP_DECK%"=="" set OPP_DECK=BBY_Voodoo_Programs

echo Starting CLI bot vs server bot
echo   server      = %SERVER_URL%
echo   my deck     = %MY_DECK%
echo   opponent    = %OPP_BOT% (deck %OPP_DECK%)
echo.

node server-ai-mybot-v2.js ^
  --server %SERVER_URL% ^
  --name CliPlayer ^
  --deck %MY_DECK% ^
  --bot-vs %OPP_BOT% ^
  --opp-deck %OPP_DECK% ^

pause

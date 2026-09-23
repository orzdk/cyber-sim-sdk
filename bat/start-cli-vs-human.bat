cd /d %~dp0..

set SERVER_URL=%1
if "%SERVER_URL%"=="" set SERVER_URL=https://punksim.net

set MY_DECK=%2
if "%MY_DECK%"=="" set MY_DECK=RRG_Arasaka_Onslaught

echo Starting CLI bot (vs human, PVB host mode)
echo   server  = %SERVER_URL%
echo   my deck = %MY_DECK%
echo.
echo Waiting for a human to join from the web client...
echo.

node server-ai-mybot-v2.js ^
  --server %SERVER_URL% ^
  --name CliBot ^
  --deck %MY_DECK% ^
  --vs-human ^
  --human

pause

@echo off
REM Run earnings_summary.mjs -> site_generator.mjs, then publish to GitHub Pages.
REM Used for scheduled execution (e.g. Windows Task Scheduler). Logs to run_all.log.
setlocal
cd /d "%~dp0"
set LOGFILE=%~dp0run_all.log
set RESULT=0

echo ==== %date% %time% : run_all.bat start ==== >> "%LOGFILE%"

where node >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] node not found in PATH >> "%LOGFILE%"
    set RESULT=1
    goto :finish
)

node earnings_summary.mjs --json >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] earnings_summary.mjs failed >> "%LOGFILE%"
    set RESULT=1
    goto :finish
)

node site_generator.mjs >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] site_generator.mjs failed >> "%LOGFILE%"
    set RESULT=1
    goto :finish
)

git add -A >> "%LOGFILE%" 2>&1
git commit -m "Automated update %date% %time%" >> "%LOGFILE%" 2>&1
git push origin main >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [WARN] git push failed - site not published this run >> "%LOGFILE%"
) else (
    echo [INFO] published to GitHub Pages >> "%LOGFILE%"
)

echo ==== %date% %time% : run_all.bat completed ==== >> "%LOGFILE%"

:finish
if not "%RESULT%"=="0" (
    echo ==== %date% %time% : run_all.bat FAILED ==== >> "%LOGFILE%"
)
exit /b %RESULT%

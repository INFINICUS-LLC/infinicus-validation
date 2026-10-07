@echo off
cd /d "C:\Users\katoh\OneDrive\Desktop\CLAUDE COWORK"
echo Clearing all git lock files...
del /f /q ".git\AUTO_MERGE.lock" 2>NUL
del /f /q ".git\index.lock" 2>NUL
del /f /q ".git\MERGE_HEAD.lock" 2>NUL
del /f /q ".git\HEAD.lock" 2>NUL
del /f /q ".git\REBASE_HEAD" 2>NUL
rmdir /s /q ".git\rebase-merge" 2>NUL
rmdir /s /q ".git\rebase-apply" 2>NUL
git merge --abort 2>NUL
echo Fetching latest remote state...
git fetch origin
echo Switching to main...
git checkout main
echo Staging all changes...
git add -A
echo Committing...
git commit -m "feat: 6-layer platform flow — Data Acquisition/Operations/Intel/Twin/Simulation/AI Decisions — sw.js v25 + dal.html Layer 1 (17 blocks) complete"
echo Pushing...
git push origin main
echo.
echo === DONE === Press any key to close.
pause

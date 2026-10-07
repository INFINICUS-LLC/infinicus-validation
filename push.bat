@echo off
setlocal EnableExtensions
:: push.bat - safe commit-and-push helper for the INFINICUS repository.
::
:: Usage:  push.bat "commit message"
::
:: What it does:
::   * runs against the repository that contains this script (no hardcoded path)
::   * refuses to run if that folder is not a git work tree root, or its
::     origin remote does not look like the infinicus-validation repository
::   * refuses detached HEAD; pushes the CURRENT branch (never switches branch)
::   * stages TRACKED files only (git add -u). New files are never staged
::     automatically: they are listed so you can "git add <file>" deliberately
::   * refuses to commit if any staged path looks like a secret
::   * never force-pushes, never deletes lock files, never aborts merges

if "%~1"=="" (
  echo Usage: push.bat "commit message"
  exit /b 1
)

cd /d "%~dp0" || exit /b 1

for /f "delims=" %%T in ('git rev-parse --show-toplevel 2^>nul') do set "TOP=%%T"
if not defined TOP (
  echo ERROR: %~dp0 is not inside a git repository.
  exit /b 1
)
set "TOP=%TOP:/=\%"
if /i not "%TOP%\"=="%~dp0" (
  echo ERROR: this script must live at the repository root.
  echo        repository root : %TOP%
  echo        script location : %~dp0
  exit /b 1
)

for /f "delims=" %%U in ('git remote get-url origin 2^>nul') do set "ORIGIN=%%U"
echo %ORIGIN% | findstr /i /c:"infinicus-validation" >nul
if errorlevel 1 (
  echo ERROR: origin remote "%ORIGIN%" is not the infinicus-validation repository.
  exit /b 1
)

for /f "delims=" %%B in ('git symbolic-ref --short -q HEAD') do set "BRANCH=%%B"
if not defined BRANCH (
  echo ERROR: detached HEAD. Check out a branch first.
  exit /b 1
)

if exist ".git\index.lock" (
  echo ERROR: .git\index.lock exists. Another git process may be running.
  echo        Close it, or remove the file yourself if you are sure it is stale.
  exit /b 1
)

echo Repository : %TOP%
echo Branch     : %BRANCH%
echo.

echo Staging modified and deleted tracked files...
git add -u || exit /b 1

echo.
echo Untracked files (NOT staged; run "git add <file>" for any you want):
git ls-files --others --exclude-standard
echo.

:: Secret guard: block commonly sensitive file names among staged paths.
git diff --cached --name-only | findstr /i /r /c:"\.env$" /c:"\.env\." /c:"\.pem$" /c:"\.key$" /c:"\.p12$" /c:"\.pfx$" /c:"id_rsa" /c:"\.dev\.vars" /c:"secrets\." /c:"credentials" >nul
if not errorlevel 1 (
  echo ERROR: a staged path looks like a secret. Unstage it with:
  echo        git restore --staged ^<path^>
  git diff --cached --name-only | findstr /i /r /c:"\.env$" /c:"\.env\." /c:"\.pem$" /c:"\.key$" /c:"\.p12$" /c:"\.pfx$" /c:"id_rsa" /c:"\.dev\.vars" /c:"secrets\." /c:"credentials"
  exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing staged. Nothing to commit.
  exit /b 0
)

echo Staged changes:
git diff --cached --stat
echo.

git commit -m "%~1" || exit /b 1

echo Pushing %BRANCH% to origin...
git push origin "%BRANCH%" || exit /b 1

echo.
echo === DONE ===
endlocal

# Deploy from this PC: push committed work to GitHub, then pull/build/restart on the server.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
# Server settings live in .env.deploy (git-ignored):
#   GRIDBOT_HOST=ubuntu@1.2.3.4
#   GRIDBOT_KEY=C:\path\to\key.pem
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$config = @{}
if (Test-Path ".env.deploy") {
  Get-Content ".env.deploy" | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$' } | ForEach-Object { $config[$Matches[1]] = $Matches[2] }
}
$target = $config["GRIDBOT_HOST"]
$key = $config["GRIDBOT_KEY"]
if (-not $target -or -not $key) { throw "Set GRIDBOT_HOST and GRIDBOT_KEY in .env.deploy" }
if (-not (Test-Path $key)) { throw "SSH key not found: $key" }

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "$env:ProgramFiles\Git\cmd\git.exe" }

$dirty = & $git status --porcelain
if ($dirty) { throw "Uncommitted changes - commit them before deploying:`n$dirty" }
$branch = & $git rev-parse --abbrev-ref HEAD
if ($branch -ne "main") { throw "Deploys run from main (current: $branch)" }

Write-Host "-> Pushing to GitHub"
& $git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

Write-Host "-> Deploying on $target"
ssh -i $key -o BatchMode=yes $target "cd ~/gridbot && git pull --ff-only -q origin main && bash scripts/server-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "Server deploy failed" }
Write-Host "Done. Dashboard: https://$($target.Split('@')[-1])"

param(
    [ValidateSet('dev', 'test', 'typecheck', 'build', 'start')]
    [string]$Task = 'dev'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localNodeDirectory = Join-Path $projectRoot '.tools\node-v24.21.0-win-x64'
if (Test-Path -LiteralPath (Join-Path $localNodeDirectory 'node.exe')) {
    $env:PATH = $localNodeDirectory + ';' + $env:PATH
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or later, then run this script again.'
}
Push-Location -LiteralPath $projectRoot
try {
    & npm.cmd run $Task
    $taskExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $taskExitCode

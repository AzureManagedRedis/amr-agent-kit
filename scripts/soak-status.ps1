[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'packages\amr-agent-soak\dist\src\cli\main.js'
if (-not (Test-Path $cliPath)) {
    throw "Soak runner is not built. Run npm run soak:build first."
}
& (Get-Command node).Source $cliPath status --run-dir ([System.IO.Path]::GetFullPath($RunDir))

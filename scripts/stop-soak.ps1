[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,
    [string]$Reason = 'operator request',
    [int]$GraceSeconds = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'packages\amr-agent-soak\dist\src\cli\main.js'
if (-not (Test-Path $cliPath)) {
    throw "Soak runner is not built. Run npm run soak:build first."
}
$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
$pidPath = Join-Path $resolvedRunDir 'pids.json'
if (-not (Test-Path $pidPath)) {
    throw "PID record not found: $pidPath"
}
$pids = Get-Content -Raw $pidPath | ConvertFrom-Json

& (Get-Command node).Source $cliPath stop --run-dir $resolvedRunDir --reason $Reason
if ($LASTEXITCODE -ne 0) {
    throw "Failed to request graceful stop for $resolvedRunDir."
}
for ($attempt = 0; $attempt -lt $GraceSeconds; $attempt++) {
    if (-not (Get-Process -Id $pids.controllerPid -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Seconds 1
}

foreach ($processId in @($pids.controllerPid, $pids.janitorPid)) {
    if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $processId -Force
    }
}

@{
    runDir = $resolvedRunDir
    stoppedAt = [DateTime]::UtcNow.ToString('o')
    controllerPid = $pids.controllerPid
    janitorPid = $pids.janitorPid
} | ConvertTo-Json

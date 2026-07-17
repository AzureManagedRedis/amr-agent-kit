[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,
    [string]$Reason = 'operator request',
    [int]$GraceSeconds = 30
)

$ErrorActionPreference = 'Stop'
function Test-ProcessIdentity($Identity) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($Identity.pid)" -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }
    $startedAt = $process.CreationDate.ToUniversalTime().ToString('o')
    return (($startedAt -eq [string]$Identity.startedAt) -and
        ([string]$process.Name -ieq [string]$Identity.name) -and
        ((-not $Identity.executablePath) -or
            ([string]$process.ExecutablePath -ieq [string]$Identity.executablePath)))
}

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
    if (-not (Test-ProcessIdentity $pids.controller)) {
        break
    }
    Start-Sleep -Seconds 1
}

if ((Test-ProcessIdentity $pids.controller) -or (Test-ProcessIdentity $pids.janitor)) {
    & (Get-Command node).Source $cliPath terminate --run-dir $resolvedRunDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to terminate verified process trees for $resolvedRunDir."
    }
}

@{
    runDir = $resolvedRunDir
    stoppedAt = [DateTime]::UtcNow.ToString('o')
    controller = $pids.controller
    janitor = $pids.janitor
} | ConvertTo-Json

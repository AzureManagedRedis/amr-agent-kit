[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'packages\amr-agent-soak\dist\src\cli\main.js'
if (-not (Test-Path $cliPath)) {
    throw "Soak runner is not built. Run npm run soak:build first."
}

$resolvedConfig = (Resolve-Path $ConfigPath).Path
$config = Get-Content -Raw $resolvedConfig | ConvertFrom-Json
if (-not $config.runId) {
    throw 'Config must include runId.'
}
$outputRoot = if ($config.outputRoot) {
    if ([System.IO.Path]::IsPathRooted($config.outputRoot)) {
        [System.IO.Path]::GetFullPath($config.outputRoot)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $repoRoot $config.outputRoot))
    }
} else {
    Join-Path $repoRoot 'eval-runs'
}
$runDir = Join-Path $outputRoot $config.runId
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$controllerOut = Join-Path $runDir 'controller.stdout.log'
$controllerErr = Join-Path $runDir 'controller.stderr.log'
$janitorOut = Join-Path $runDir 'janitor.stdout.log'
$janitorErr = Join-Path $runDir 'janitor.stderr.log'
$controller = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @("`"$cliPath`"", 'controller', '--config', "`"$resolvedConfig`"") `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $controllerOut -RedirectStandardError $controllerErr
$janitor = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @("`"$cliPath`"", 'janitor', '--run-dir', "`"$runDir`"", '--controller-pid', $controller.Id) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $janitorOut -RedirectStandardError $janitorErr

$pidRecord = @{
    schemaVersion = 1
    runId = $config.runId
    runDir = $runDir
    startedAt = [DateTime]::UtcNow.ToString('o')
    controllerPid = $controller.Id
    janitorPid = $janitor.Id
}
$pidPath = Join-Path $runDir 'pids.json'
$pidTemp = "$pidPath.$PID.tmp"
$pidRecord | ConvertTo-Json | Set-Content -Encoding utf8 $pidTemp
Move-Item -Force $pidTemp $pidPath

$responsive = $false
$exitedProcess = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $controller.Refresh()
    $janitor.Refresh()
    if ($controller.HasExited) {
        $exitedProcess = 'controller'
        break
    }
    if ($janitor.HasExited) {
        $exitedProcess = 'janitor'
        break
    }
    $heartbeatPath = Join-Path $runDir 'heartbeat.json'
    if (Test-Path $heartbeatPath) {
        $heartbeat = Get-Content -Raw $heartbeatPath | ConvertFrom-Json
        if ($heartbeat.controllerPid -eq $controller.Id) {
            $responsive = $true
            break
        }
    }
    Start-Sleep -Seconds 1
}

if (-not $responsive) {
    foreach ($processId in @($controller.Id, $janitor.Id)) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            Stop-Process -Id $processId -Force
        }
    }
    $errorLog = if ($exitedProcess -eq 'janitor') { $janitorErr } else { $controllerErr }
    $subject = if ($exitedProcess) { $exitedProcess } else { 'controller' }
    throw "Soak $subject did not become responsive. Inspect $errorLog"
}

$pidRecord | ConvertTo-Json

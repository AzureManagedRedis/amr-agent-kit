[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$scratchRoot = Join-Path $root ".offline-output"
$exitCode = 0

function New-WritableScratchDirectory {
    param([string]$Path)

    try {
        Remove-Item -Recurse -Force $Path -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        $probe = Join-Path $Path ".write-probe"
        [System.IO.File]::WriteAllText($probe, "ok")
        Remove-Item -Force $probe
    } catch {
        throw "Offline scratch preflight failed for '$Path'. Verify that the worktree is writable and remove any process locking the directory. $($_.Exception.Message)"
    }
}

function Assert-Result {
    param(
        [string]$Json,
        [string]$Library
    )

    $result = $Json | ConvertFrom-Json
    if ($result.library -ne $Library -or $result.mode -ne "dry-run" -or $result.status -ne "ok") {
        throw "Unexpected dry-run result for $Library."
    }
    foreach ($property in @("library", "mode", "scenario", "status", "keyNamespace", "runId", "probeKey", "teardownKey", "ttlSeconds", "metrics")) {
        if ($result.PSObject.Properties.Name -notcontains $property) {
            throw "Result contract uses a missing or incorrectly cased '$property' property for $Library."
        }
    }
    foreach ($property in @("attempted", "succeeded", "failed", "latencyMs")) {
        if ($result.metrics.PSObject.Properties.Name -notcontains $property) {
            throw "Metric contract uses a missing or incorrectly cased '$property' property for $Library."
        }
    }
    if ($result.probeKey -notlike "$($result.keyNamespace):$($result.runId):$($result.scenario):probe") {
        throw "Result key is not namespaced for $Library."
    }
    if ($result.teardownKey -notlike "$($result.keyNamespace):$($result.runId):$($result.scenario):teardown" -or $result.ttlSeconds -lt 1) {
        throw "Result teardown or TTL contract is invalid for $Library."
    }
}

try {
    New-WritableScratchDirectory -Path $scratchRoot
    $env:SOAK_MODE = "dry-run"
    $env:PYTHONDONTWRITEBYTECODE = "1"

    $dotnetProject = Join-Path $root "dotnet\SoakClient.csproj"
    $dotnetObj = "$scratchRoot\dotnet\obj\"
    $dotnetBin = "$scratchRoot\dotnet\bin\"
    & dotnet restore $dotnetProject --ignore-failed-sources --nologo "-p:BaseIntermediateOutputPath=$dotnetObj" "-p:BaseOutputPath=$dotnetBin"
    $dotnet = & dotnet run --project $dotnetProject --no-restore --nologo --verbosity quiet `
        "-p:BaseIntermediateOutputPath=$dotnetObj" "-p:BaseOutputPath=$dotnetBin"
    Assert-Result -Json ($dotnet | Select-Object -Last 1) -Library "StackExchange.Redis"

    $python = & python (Join-Path $root "python\client.py")
    Assert-Result -Json ($python | Select-Object -Last 1) -Library "redis-py"

    Push-Location (Join-Path $root "go")
    try {
        $go = & go run .
    } finally {
        Pop-Location
    }
    Assert-Result -Json ($go | Select-Object -Last 1) -Library "go-redis"

    $env:CARGO_TARGET_DIR = Join-Path $scratchRoot "cargo-target"
    New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
    $rust = & cargo run --manifest-path (Join-Path $root "rust\Cargo.toml") --offline --quiet
    Assert-Result -Json ($rust | Select-Object -Last 1) -Library "redis-rs"

    $node = & node (Join-Path $root "node\client.js")
    Assert-Result -Json ($node | Select-Object -Last 1) -Library "node-redis"

    & python -m unittest discover -s (Join-Path $root "tests") -p "test_*.py"
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item -Force (Join-Path $root "rust\Cargo.lock") -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratchRoot -ErrorAction SilentlyContinue
}

exit $exitCode

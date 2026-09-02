param([switch] $NoLaunch)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$kitRoot = Split-Path -Parent $PSCommandPath
$logDir = Join-Path $kitRoot 'kit-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("launch-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

function Write-Both([string] $line) {
    Write-Host $line
    Add-Content -Path $log -Value $line
}

Write-Both "=== Mercury field kit launcher ==="
Write-Both ("kit root: " + $kitRoot)
Write-Both ("windows: " + [System.Environment]::OSVersion.VersionString)
Write-Both ("pwsh:    " + $PSVersionTable.PSVersion)
Write-Both ("terminal: " + ($env:WT_SESSION ? 'Windows Terminal' : ($env:TERM_PROGRAM ?? 'unknown')))

$mercury = Get-Command mercury -ErrorAction SilentlyContinue
if (-not $mercury) {
    Write-Both "mercury is not on PATH — install it first, then re-run this launcher."
    exit 1
}
$version = (& mercury --version) 2>&1 | Out-String
Write-Both ("mercury: " + $version.Trim())

$work = Join-Path $kitRoot ("work-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -Recurse -Path (Join-Path $kitRoot 'task') -Destination $work
Write-Both ("working folder: " + $work)
Write-Both ""
Write-Both "Starting Mercury in the working folder. Suggested first instruction:"
Write-Both '  Read TASK.md and fix the ledger bug it describes.'
Write-Both "Follow CHECKLIST.md from here. Happy testing!"
Write-Both ""

if ($NoLaunch) {
    Write-Both "(preflight only — -NoLaunch set; Mercury not started)"
    exit 0
}

Set-Location $work
& mercury

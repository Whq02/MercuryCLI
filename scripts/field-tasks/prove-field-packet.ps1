# ============================================================================
#  scripts/field-tasks/prove-field-packet.ps1 — the §7/ PowerShell-7 proof
#  of the Windows field packet, run on hosted windows-latest (the
#  windows-functional leg) or any Windows box.
#
#  Proves the PACKET's mechanics under real PS7: launcher preflight
#  (-NoLaunch), fresh-working-copy law, collector preview → manifest →
#  REPORT.md → zip with recomputing checksums. Mercury itself is proven by
#  the product lanes — here a NAMED SHIM answers `mercury --version` so the
#  scripts' own behaviour is what this leg measures (the receipt says so).
#
#  Usage: pwsh -File scripts/field-tasks/prove-field-packet.ps1 -KitDir <generated kit>
# ============================================================================
#Requires -Version 7.0
param([Parameter(Mandatory)] [string] $KitDir)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$failures = 0
function Assert-True([string] $name, [bool] $pass, [string] $detail = '') {
    if ($pass) { Write-Host ("  ok   " + $name) }
    else { Write-Host ("  FAIL " + $name + ($detail ? " — $detail" : '')); $script:failures = 1 }
}

$kit = Resolve-Path $KitDir
Write-Host "=== field packet PS7 proof — kit: $kit ==="

# ── a NAMED mercury shim on PATH (this leg proves the kit, not the product) ─
$shimDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mercury-shim-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
Set-Content -Path (Join-Path $shimDir 'mercury.ps1') -Value @'
"mercury 0.0.0-fieldkit-ps7-shim (proof leg; not the product)"
'@
$env:PATH = $shimDir + [System.IO.Path]::PathSeparator + $env:PATH
Assert-True 'shim resolves as mercury' ($null -ne (Get-Command mercury -ErrorAction SilentlyContinue))

# ── 1 · launcher preflight (-NoLaunch) ──────────────────────────────────────
& pwsh -File (Join-Path $kit 'Run-FieldKit.ps1') -NoLaunch
Assert-True 'launcher preflight exits 0' ($LASTEXITCODE -eq 0)
$launchLogs = Get-ChildItem -Path (Join-Path $kit 'kit-logs') -Filter 'launch-*.log' -ErrorAction SilentlyContinue
Assert-True 'launcher wrote its log' ($null -ne $launchLogs -and @($launchLogs).Count -ge 1)
$work = Get-ChildItem -Path $kit -Directory -Filter 'work-*' | Select-Object -First 1
Assert-True 'fresh working copy of the task exists' ($null -ne $work -and (Test-Path (Join-Path $work.FullName 'TASK.md')))
Assert-True 'working copy carries the suite' ($null -ne $work -and (Test-Path (Join-Path $work.FullName 'test/ledger.test.mjs')))

# ── 2 · seed tester notes, then collect with -All ───────────────────────────
Add-Content -Path (Join-Path $kit 'CHECKLIST.md') -Value "`n> notes: first paint clean (proof-leg seeded note)"
Set-Content -Path (Join-Path $kit 'issue-proofleg.md') -Value "# Issue note`nseeded by the PS7 proof leg."
& pwsh -File (Join-Path $kit 'Collect-Report.ps1') -All
Assert-True 'collector exits 0' ($LASTEXITCODE -eq 0)
$zip = Get-ChildItem -Path $kit -Filter 'field-report-*.zip' | Select-Object -First 1
Assert-True 'field-report zip written' ($null -ne $zip)

# ── 3 · unpack + verify manifest, checksums, REPORT.md ──────────────────────
$unpack = Join-Path ([System.IO.Path]::GetTempPath()) ("field-report-proof-" + (Get-Date -Format 'yyyyMMddHHmmss'))
Expand-Archive -Path $zip.FullName -DestinationPath $unpack
$manifest = Get-Content -Raw (Join-Path $unpack 'manifest.json') | ConvertFrom-Json
Assert-True 'manifest kind + platform stamps' ($manifest.kind -eq 'mercury-field-report' -and $manifest.powershell -match '^7\.' -and $manifest.windowsBuild.Length -gt 0)
Assert-True 'manifest names the shim version (proof leg identity is honest)' ($manifest.mercuryVersion -match 'fieldkit-ps7-shim')
Assert-True 'REPORT.md present + human-readable' ((Test-Path (Join-Path $unpack 'REPORT.md')) -and ((Get-Content -Raw (Join-Path $unpack 'REPORT.md')) -match 'Included items'))
Assert-True 'checklist + issue note collected' ((Test-Path (Join-Path $unpack 'CHECKLIST.md')) -and (Test-Path (Join-Path $unpack 'issue-proofleg.md')))
$badSums = @()
foreach ($item in $manifest.items) {
    $path = Join-Path $unpack $item.name
    if (-not (Test-Path $path)) { $badSums += ($item.name + ' missing'); continue }
    $sha = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
    if ($sha -ne $item.sha256) { $badSums += $item.name }
}
Assert-True 'every manifest sha256 recomputes from the bundle' ($badSums.Count -eq 0) ($badSums -join ', ')

# ── 4 · packet manifest integrity (generation-side checksums) ───────────────
$packet = Get-Content -Raw (Join-Path $kit 'packet-manifest.json') | ConvertFrom-Json
$badKit = @()
foreach ($file in $packet.files) {
    # Skip files the proof itself mutated (checklist note; collector zips live beside them).
    if ($file.path -eq 'CHECKLIST.md') { continue }
    $path = Join-Path $kit ($file.path -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $sha = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
    if ($sha -ne $file.sha256) { $badKit += $file.path }
}
Assert-True 'packet-manifest sha256s hold for unmutated kit files' ($badKit.Count -eq 0) ($badKit -join ', ')

if ($failures -ne 0) { Write-Host 'prove-field-packet: RED'; exit 1 }
Write-Host 'prove-field-packet: green (PS7 mechanics proven; product identity rides the product lanes)'
exit 0

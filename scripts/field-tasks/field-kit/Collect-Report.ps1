# Mercury field kit — the collector. Shows every candidate item and lets the
# tester drop any of them BEFORE anything is written. Collects ONLY kit-owned
# material: checklist notes, issue notes, kit logs, version stamps. Never
# project files, never anything outside the kit folder.
# -All keeps every candidate without prompting — the hosted PS7 proof leg
# uses it; testers get the per-item preview.
#Requires -Version 7.0
param([switch] $All)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$kitRoot = Split-Path -Parent $PSCommandPath
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path $kitRoot ("report-staging-" + $stamp)

# ── gather candidates (kit-owned only) ──────────────────────────────────────
$candidates = @()
foreach ($name in @('CHECKLIST.md', 'ISSUE-TEMPLATE.md')) {
    $path = Join-Path $kitRoot $name
    if (Test-Path $path) { $candidates += Get-Item $path }
}
$issueNotes = Get-ChildItem -Path $kitRoot -Filter 'issue-*.md' -ErrorAction SilentlyContinue
if ($issueNotes) { $candidates += $issueNotes }
$logDir = Join-Path $kitRoot 'kit-logs'
if (Test-Path $logDir) { $candidates += Get-ChildItem -Path $logDir -File }
$shots = Get-ChildItem -Path $kitRoot -Include '*.png', '*.jpg' -File -ErrorAction SilentlyContinue
if ($shots) { $candidates += $shots }

if (-not $candidates) {
    Write-Host "Nothing to collect yet — fill in CHECKLIST.md first."
    exit 0
}

# ── preview + per-item consent ──────────────────────────────────────────────
Write-Host "=== Field report preview — say n to drop any item ==="
$kept = @()
foreach ($item in $candidates) {
    $size = '{0:n1} KB' -f ($item.Length / 1KB)
    if ($All) {
        Write-Host ("include " + $item.Name + " (" + $size + ") — kept (-All)")
        $kept += $item
        continue
    }
    $answer = Read-Host ("include " + $item.Name + " (" + $size + ")? [Y/n]")
    if ($answer -eq '' -or $answer -match '^[Yy]') { $kept += $item }
    else { Write-Host ("  dropped " + $item.Name) }
}
if (-not $kept) {
    Write-Host "Everything dropped — no report written."
    exit 0
}

# ── manifest + bundle ───────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $staging | Out-Null
foreach ($item in $kept) { Copy-Item -Path $item.FullName -Destination $staging }

$mercuryVersion = try { ((& mercury --version) 2>&1 | Out-String).Trim() } catch { 'unavailable' }
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')
$terminal = ($env:WT_SESSION ? 'windows-terminal' : ($env:TERM_PROGRAM ?? 'unknown'))
$manifest = [ordered]@{
    schema          = 1
    kind            = 'mercury-field-report'
    collectedAtUtc  = $collectedAt
    mercuryVersion  = $mercuryVersion
    windowsBuild    = [System.Environment]::OSVersion.VersionString
    powershell      = $PSVersionTable.PSVersion.ToString()
    terminal        = $terminal
    items           = @($kept | ForEach-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
        $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
        [ordered]@{
            name   = $_.Name
            bytes  = $_.Length
            sha256 = ([System.BitConverter]::ToString($sha) -replace '-', '').ToLowerInvariant()
        }
    })
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $staging 'manifest.json')

# Human-readable twin of the manifest, for whoever opens the zip first.
$report = @()
$report += "# Mercury field report — " + $collectedAt
$report += ""
$report += "- mercury: " + $mercuryVersion
$report += "- windows: " + [System.Environment]::OSVersion.VersionString
$report += "- powershell: " + $PSVersionTable.PSVersion.ToString()
$report += "- terminal: " + $terminal
$report += ""
$report += "Included items (" + $kept.Count + "; sha256 per item in manifest.json):"
foreach ($item in $kept) {
    $report += ("- " + $item.Name + " (" + ('{0:n1} KB' -f ($item.Length / 1KB)) + ")")
}
$report -join "`n" | Set-Content -Path (Join-Path $staging 'REPORT.md')

$zip = Join-Path $kitRoot ("field-report-" + $stamp + '.zip')
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
Remove-Item -Recurse -Force $staging

Write-Host ""
Write-Host ("Report written: " + $zip)
Write-Host ("Items: " + $kept.Count + " + manifest.json + REPORT.md (sha256 per item inside)")
Write-Host "Send that zip back — and thank you."

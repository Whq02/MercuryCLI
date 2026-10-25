import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

const WINDOWS_OWNER_ONLY = "$ErrorActionPreference='Stop';$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$ok=@($me,'S-1-5-18','S-1-5-32-544');$shared=@((Get-Acl -LiteralPath $env:OWNER_ONLY_PATH).Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Where-Object { $ok -notcontains $_ });if($shared.Count){'shared ' + ($shared -join ',')}else{'owner-only'}"

export function ownerOnlyFile(path: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return (statSync(path).mode & 0o777) === 0o600
  const { PSModulePath: _modules, ...env } = process.env
  const verdict = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OWNER_ONLY], { encoding: 'utf8', env: { ...env, OWNER_ONLY_PATH: path }, windowsHide: true, timeout: 30_000 }).trim()
  return verdict === 'owner-only'
}

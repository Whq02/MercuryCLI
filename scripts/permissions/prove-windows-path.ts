import { getPlatform } from '../../src/platform/environment/platform.js'
import { suspiciousWindowsPattern, containsWindowsDevicePath } from '../../src/permissions/rules/windowsPath.js'

let failed = 0
const forms = [
  ['C:/file:stream', 'NTFS alternate data stream'],
  ['C:/PROGRA~1/file', '8.3 short name'],
  [String.raw`\\?\relative`, 'long-path or device prefix'],
  [String.raw`\\.\relative`, 'long-path or device prefix'],
  ['//?/relative', 'long-path or device prefix'],
  ['//./relative', 'long-path or device prefix'],
  ['file.', 'trailing dot or whitespace'],
  ['file ', 'trailing dot or whitespace'],
  ['file.NUL', 'DOS device name'],
  ['CON', 'DOS device name'],
  ['PRN', 'DOS device name'],
  ['AUX', 'DOS device name'],
  ['a/.../b', 'consecutive dots as a path component'],
  ...Array.from({ length: 9 }, (_, i) => [`COM${i + 1}`, 'DOS device name']),
  ...Array.from({ length: 9 }, (_, i) => [`LPT${i + 1}`, 'DOS device name']),
] as const
for (const platform of ['windows', 'wsl', 'macos', 'linux'] as const) {
  getPlatform.cache.set(undefined, platform)
  for (const [path, expected] of forms) {
    const label = expected === 'NTFS alternate data stream' && platform !== 'windows' && platform !== 'wsl' ? null : expected
    const ok = suspiciousWindowsPattern(path) === label
    console.log(`${ok ? 'PASS' : 'FAIL'} ${platform} ${path}: ${label}`)
    if (!ok) {
      console.log(`  suspiciousWindowsPattern(${JSON.stringify(path)}) on ${platform} returned ${JSON.stringify(suspiciousWindowsPattern(path))}, expected ${JSON.stringify(label)}; change suspiciousWindowsPattern in src/permissions/rules/windowsPath.ts`)
      failed++
    }
  }
  for (const path of ['C:/project/file.txt', '/usr/local/file', 'a..b', 'normal', '.', '..', './x', '../x', 'a/.', 'a/..']) if (suspiciousWindowsPattern(path) !== null) {
    console.log(`FAIL ${platform} ordinary path ${JSON.stringify(path)} was flagged as ${JSON.stringify(suspiciousWindowsPattern(path))}; suspiciousWindowsPattern in src/permissions/rules/windowsPath.ts must return null for it`)
    failed++
  }
  for (const path of [String.raw`cat '\\?\C:\project\file'`, String.raw`Get-Content '\\.\C:\project\file'`, String.raw`dir \\.`, String.raw`\\??\share`]) if (containsWindowsDevicePath(path) !== (platform === 'windows')) {
    console.log(`FAIL ${platform} containsWindowsDevicePath(${JSON.stringify(path)}) must be ${platform === 'windows'}; change containsWindowsDevicePath in src/permissions/rules/windowsPath.ts`)
    failed++
  }
}
getPlatform.cache.delete(undefined)
console.log(`windows-path: ${failed ? 'FAIL' : 'PASS'} (${failed} failures)`)
process.exit(failed ? 1 : 0)

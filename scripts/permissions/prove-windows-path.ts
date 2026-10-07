import { getPlatform } from '../../src/utils/platform.js'
import { suspiciousWindowsPattern, containsWindowsDevicePath } from '../../src/utils/permissions/windowsPath.js'

let failed = 0
const forms = [
  ['C:/file:stream', 'NTFS alternate data stream'], ['C:/PROGRA~1/file', '8.3 short name'],
  [String.raw`\\?\relative`, 'long-path or device prefix'], [String.raw`\\.\relative`, 'long-path or device prefix'],
  ['//?/relative', 'long-path or device prefix'], ['//./relative', 'long-path or device prefix'],
  ['file.', 'trailing dot or whitespace'], ['file ', 'trailing dot or whitespace'],
  ['file.NUL', 'DOS device name'], ['CON', 'DOS device name'], ['PRN', 'DOS device name'], ['AUX', 'DOS device name'],
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
    if (!ok) failed++
  }
  for (const path of ['C:/project/file.txt', '/usr/local/file', 'a..b', 'normal']) if (suspiciousWindowsPattern(path) !== null) failed++
  for (const path of [String.raw`cat '\\?\C:\project\file'`, String.raw`Get-Content '\\.\C:\project\file'`]) if (containsWindowsDevicePath(path) !== (platform === 'windows')) failed++
}
getPlatform.cache.clear()
console.log(`windows-path: ${failed ? 'FAIL' : 'PASS'} (${failed} failures)`)
process.exit(failed ? 1 : 0)

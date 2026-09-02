#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { uriToPath } = await import('../../src/tools/LSPTool/formatters.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

check(
  'the percent-encoded drive colon decodes to an openable path (FC-052)',
  uriToPath('file:///c%3A/Users/me/proj/app.py') === 'c:/Users/me/proj/app.py',
  uriToPath('file:///c%3A/Users/me/proj/app.py'),
)
check(
  'the unencoded spelling still strips the drive slash',
  uriToPath('file:///c:/Users/me/proj/app.py') === 'c:/Users/me/proj/app.py',
  uriToPath('file:///c:/Users/me/proj/app.py'),
)
check(
  'a POSIX uri is untouched',
  uriToPath('file:///Users/me/app.py') === '/Users/me/app.py',
  uriToPath('file:///Users/me/app.py'),
)
check(
  'percent-encoded spaces decode everywhere',
  uriToPath('file:///Users/me/my%20project/app.py') === '/Users/me/my project/app.py',
)

if (failures > 0) {
  console.error(`\nprove-uri-to-path-order: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-uri-to-path-order: all green')

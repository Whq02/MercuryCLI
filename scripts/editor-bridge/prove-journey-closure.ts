#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}


{
  let code = 0
  let out = ''
  try {
    out = execFileSync('bash', ['scripts/vscode/host-test/run.sh'], { encoding: 'utf8', timeout: 300_000, stdio: 'pipe' })
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string }
    code = err.status ?? 1
    out = String(err.stderr ?? '')
  }
  check(
    'j17 runner: green or NAMED skip (never silent)',
    code === 0 || (code === 3 && out.includes('SKIP')),
    `exit ${code}`,
  )
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ journey closure map green (partials + machine gates NAMED, never silent)')

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const root = resolve(import.meta.dir, '..', '..')
const EARLY_MS = 10
const SIZE = '178x51'
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}

console.log(`the crew composer roads under timers that land ${EARLY_MS}ms early: the first click after the focus-in must still open the row`)
const started = Date.now()
const result = spawnSync(process.execPath, [
  '--preload', join(root, 'scripts/ui/lib/earlyTimersPreload.ts'),
  '--preload', join(root, 'scripts/lib/proofHomePreload.ts'),
  join(root, 'scripts/ui/prove-crew-composer-roads.ts'), '--size', SIZE,
], { cwd: root, encoding: 'utf8', env: { ...process.env, PROOF_TIMER_EARLY_MS: String(EARLY_MS) }, timeout: 280_000, maxBuffer: 64 * 1024 * 1024 })
const out = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
const lines = out.split('\n').map(line => line.trimEnd())
const fails = lines.filter(line => line.startsWith('[FAIL]'))
const summary = lines.find(line => /^crew-composer-roads: \d+ checks, \d+ failed$/.test(line)) ?? '(no summary line)'
console.log(`the road's verdict after ${Math.round((Date.now() - started) / 1000)}s: ${summary} · rc=${String(result.status)}${result.error ? ` · ${result.error.message}` : ''}`)
check('the early-timers preload was live in the child (its mark is in the output)', /early-timers preload: every timer of \d+ms or more lands \d+ms early/.test(out), lines.filter(line => line !== '').slice(0, 6).join(' | '))
check(`the first click on the atlas row opened it in the view at ${SIZE}`, lines.includes('[PASS] one click on the atlas row opens it in the view'), lines.filter(line => line.includes('one click on the atlas row')).join(' | ') || '(the check never printed)')
check('the roads proof is green under the early timers', result.status === 0 && fails.length === 0, `rc=${String(result.status)}\n${fails.slice(0, 9).join('\n')}`)
console.log(`\ncrew-composer-click-after-focus: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-halt.ts
//  PROOF (#35 hard-stop / manual break): /halt kills every in-process running
//  agent + the scheduler daemon and its hosted workers (Implementer + fleet) in
//  one gesture, and reports honestly. The side-effectful haltAll (daemon RPC +
//  stopTask) is exercised live via prove-supervise's real daemon; here we prove
//  the pure decision/format helpers + the command wiring.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-halt.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

// The pure core is split into haltDecide.js (haltAll.js itself imports the daemon
// RPC + stopTask → the feature()-macro'd voice chain → unloadable under bare bun).
const h = (await import('../../src/utils/haltDecide.js')) as typeof import('../../src/utils/haltDecide.js')

console.log('============================================================')
console.log(' Hard-stop / manual break (/halt, #35) — proof')
console.log('============================================================')

section('runningTaskIds (pure) — kill exactly the RUNNING in-process agents')
const tasks = { a: { id: 'a', status: 'running' }, b: { id: 'b', status: 'completed' }, c: { id: 'c', status: 'running' }, d: { id: 'd', status: 'pending' } }
check('selects only running ids', JSON.stringify(h.runningTaskIds(tasks).sort()) === JSON.stringify(['a', 'c']))
check('undefined tasks ⇒ []', h.runningTaskIds(undefined).length === 0)
check('no running ⇒ []', h.runningTaskIds({ b: { id: 'b', status: 'completed' } }).length === 0)

section('summarizeHalt (pure) — honest one-line outcome')
check('daemon halted + 2 agents stopped', /stopped 2 in-process agent\(s\)[\s\S]*daemon halted \(reaped 3 workers\)/.test(h.summarizeHalt({ tasksStopped: ['a', 'b'], tasksFailed: [], daemon: { ok: true, reaped: 3 } })))
check('no daemon running is honest (not a failure-y word)', /no in-process agents running[\s\S]*daemon: no daemon running/.test(h.summarizeHalt({ tasksStopped: [], tasksFailed: [], daemon: { ok: false, reason: 'no daemon running' } })))
check('1 worker reaped ⇒ singular', /reaped 1 worker\)/.test(h.summarizeHalt({ tasksStopped: [], tasksFailed: [], daemon: { ok: true, reaped: 1 } })))
check('stubborn tasks surfaced', /would not stop/.test(h.summarizeHalt({ tasksStopped: ['a'], tasksFailed: ['b'], daemon: { ok: true, reaped: 0 } })))

section('wiring — /halt command shuts the daemon (reapWorkers) + stops in-process tasks')
const halt = src('commands', 'halt', 'halt.ts')
// intent (calls haltAll with context), robust to a type-only cast on the arg
check('/halt calls haltAll', /haltAll\(\s*context\b/.test(halt) && /summarizeHalt/.test(halt))
const haltSrc = src('utils', 'haltAll.ts')
check('haltAll shuts the daemon with reapWorkers:true', /op: 'shutdown', reapWorkers: true/.test(haltSrc))
check('haltAll stops in-process running tasks via stopTask', /stopTask\(id/.test(haltSrc) && /runningTaskIds/.test(haltSrc))
check('haltAll never throws (no-daemon is a success, not a raise)', /no daemon running/.test(haltSrc))
const cmds = src('commands.ts')
check('/halt registered in the command list', /import halt from '\.\/commands\/halt\/index\.js'/.test(cmds) && /\n\s+halt,\n/.test(cmds))
const idx = src('commands', 'halt', 'index.ts')
check("command name is 'halt', supportsNonInteractive", /name: 'halt'/.test(idx) && /supportsNonInteractive: true/.test(idx))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL HALT PROOFS PASS')
else console.log(`❌ ${failures} HALT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

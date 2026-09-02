#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-py-'))

const {
  _resetPythonProbeForTesting,
  probePythonInterpreter,
  pythonGeneration,
  resetPythonRuntime,
  runPythonCell,
} = await import('../../src/services/workshop/pythonRuntime.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — python workshop proof exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'vanguard-py-work-'))
const owner = makeOwnerKey({
  workspace: workDir,
  sessionId: 'py-session',
  lane: 'main',
} as never)

const noBridge = {
  inspect: async () => 'inspect-unused',
  tool: async () => 'tool-unused',
  agent: async () => 'agent-unused',
}

function run(code: string, extras: Record<string, unknown> = {}) {
  return runPythonCell({
    owner,
    cwd: workDir,
    cell: { language: 'py', code, ...extras } as never,
    bridge: (extras.bridge as typeof noBridge) ?? noBridge,
    signal: extras.signal as AbortSignal | undefined,
  })
}

section('V. interpreter availability honesty')
{
  const realPath = process.env.PATH
  process.env.PATH = '/nonexistent-vanguard'
  _resetPythonProbeForTesting()
  const sabotaged = probePythonInterpreter()
  check('V1 an unresolvable python3 reads honest-unavailable',
    'unavailable' in sabotaged && /install Python 3/.test(sabotaged.unavailable))
  const refused = await run('1 + 1')
  check('V2 a cell against the unavailable lane refuses (no kernel spawns)',
    refused.state === 'failed' && /install Python 3/.test(refused.error ?? ''))
  process.env.PATH = realPath
  _resetPythonProbeForTesting()
}

const probe = probePythonInterpreter()
if ('unavailable' in probe) {
  console.log('\n▲ python3 is NOT on this machine — kernel laws SKIPPED (availability laws ran).')
  console.log('═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ python workshop: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('✅ python workshop: availability laws hold (kernel laws need python3)')
  process.exit(0)
}
console.log(`\n(interpreter: ${probe.version})`)

section('P. state persistence')
{
  const p1 = await run('x = 41\ndef bump(n):\n    return n + 1\nx')
  check('P1 first cell runs with the value', p1.state === 'succeeded' && p1.valuePreview === '41')
  const p2 = await run('bump(x)')
  check('P2 state persists to the next call', p2.state === 'succeeded' && p2.valuePreview === '42')
}

section('T. top-level await on one persistent loop')
{
  const t1 = await run('import asyncio\ny = await asyncio.sleep(0, result=41)\ny')
  check('T1 TLA runs', t1.state === 'succeeded' && t1.valuePreview === '41')
  const t2 = await run('y + 1')
  check('T2 TLA bindings persist', t2.state === 'succeeded' && t2.valuePreview === '42')
}

section('E. last-expression value')
{
  const e1 = await run("data = {'a': 1}\nlen(data)")
  check('E1 the last bare expression is the value', e1.valuePreview === '1')
  const e2 = await run('z = 5')
  check('E2 a statement-only cell has no value', e2.state === 'succeeded' && e2.valuePreview === '')
}

section('S. interactive stdin')
{
  const s = await run('input()')
  check('S1 input() raises with a clear error',
    s.state === 'failed' && /interactive stdin is not available/.test(s.error ?? ''))
}

section('M. imports fail honestly')
{
  const m = await run('import definitely_not_a_real_package_vanguard')
  check('M1 a missing package is a ModuleNotFoundError (no install attempt)',
    m.state === 'failed' && /ModuleNotFoundError/.test(m.error ?? ''))
}

section('B. the mercury bridge from Python')
{
  const bridge = {
    ...noBridge,
    tool: async (name: string) => `bridged:${name}`,
    inspect: async (ref: string) => `inspected:${ref}`,
  }
  const b = await run(
    "r1 = mercury.tool('Read', {'file_path': '/tmp/x'})\nr2 = mercury.inspect('mercury://run/current')\nmercury.display({'answer': 42})\nf'{r1}|{r2}'",
    { bridge },
  )
  check('B1 tool + inspect round-trip', b.valuePreview === "'bridged:Read|inspected:mercury://run/current'", JSON.stringify(b))
  check('B2 display detects json', b.displays.some(d => d.kind === 'json' && d.value.includes('42')))
  check('B3 nested calls counted', b.nestedCalls === 2)
}

section('C. cancellation interrupts — state retained')
{
  const genBefore = pythonGeneration(owner)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 400)
  const c = await run('import time\nmarker = 7\nwhile True:\n    time.sleep(0.05)', {
    timeoutMs: 30_000,
    signal: ac.signal,
  })
  check('C1 the interrupt lands as KeyboardInterrupt — state RETAINED',
    c.state === 'cancelled' && !c.runtimeKilled && /state is RETAINED/.test(c.error ?? ''),
    JSON.stringify({ state: c.state, killed: c.runtimeKilled, err: c.error?.slice(0, 80) }))
  check('C2 the generation did NOT bump', pythonGeneration(owner) === genBefore)
  const after = await run('marker')
  check('C3 the session still holds pre-interrupt state', after.valuePreview === '7')
}

section('K. an interrupt-ignoring cell escalates to SIGKILL')
{
  const genBefore = pythonGeneration(owner)
  const k = await run(
    'import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True:\n    time.sleep(0.05)',
    { timeoutMs: 600 },
  )
  check('K1 escalation kills and REPORTS state loss',
    k.state === 'timed-out' && k.runtimeKilled && /retained state lost/i.test(k.error ?? ''),
    JSON.stringify({ state: k.state, killed: k.runtimeKilled }))
  check('K2 the generation bumped', pythonGeneration(owner) === genBefore + 1)
}

section('D. a dead kernel fails the cell; the next restarts fresh')
{
  const genBefore = pythonGeneration(owner)
  const d1 = await run('import os\nos._exit(7)')
  check('D1 the dying cell FAILS with the loss named',
    d1.state === 'failed' && d1.runtimeKilled && /died mid-cell/.test(d1.error ?? ''))
  const d2 = await run('fresh = True\nfresh')
  check('D2 the next cell runs on a fresh kernel (no replay)',
    d2.state === 'succeeded' && d2.valuePreview === 'True' && d2.generation === genBefore + 1)
}

section('R. explicit reset')
{
  await run('keepme = 1')
  const genBefore = pythonGeneration(owner)
  await resetPythonRuntime(owner)
  check('R1 reset bumps the generation', pythonGeneration(owner) === genBefore + 1)
  const r = await run("'keepme' in globals()")
  check('R2 globals cleared in place', r.valuePreview === 'False')
}

section('O. output spill')
{
  const o = await run("for i in range(300):\n    print('line', i)\n'done'")
  check('O1 tail bounded + artifact spilled',
    o.outputTail.length <= 60 && o.artifactRef?.startsWith('mercury://artifact/workshop/') === true)
}

disposeOwner(owner)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ python workshop: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ python workshop: every law holds')
process.exit(0)

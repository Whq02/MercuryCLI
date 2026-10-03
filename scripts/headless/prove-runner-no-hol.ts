#!/usr/bin/env bun
// gate-watch: src/cli/print.ts src/runner/wire/* src/cli/headless/runnerMethods.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'
import { LineReader, controlRequestFrame, isControlResponse, isTurnWaiting, userRow, type Frame } from '../lib/rows.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at !== -1 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') !== undefined ? resolve(argAfter('--dist')!) : join(ROOT, 'dist', 'mercury.mjs')
const DOOR = argAfter('--door') === 'rows' ? 'rows' : 'wire'
const HOLD_MS = 3_000
const BOUND_MS = 500

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
console.log(`no head-of-line blocking — ${DIST} through the ${DOOR} door; the first facts answer is held ${HOLD_MS} ms (MERCURY_SESSION_FACTS_HOLD_MS)`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const api = await startFixtureApi([{ kind: 'hang', deltas: ['hanging…'] }])
const scratch = scratchHome('runner-no-hol-')
const env = { ...scratch.env, PATH: `/usr/bin:/bin:${dirname(node)}`, MERCURY_SESSION_FACTS_HOLD_MS: String(HOLD_MS), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }

if (DOOR === 'wire') {
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env, argv: ['--model', 'claude-opus-4-8'] })
  const exitedEarly = host.exited.then(code => {
    throw new Error(`the runner exited ${code} before the proof ended: ${host.stderr().slice(0, 300)}`)
  })
  try {
    await Promise.race([host.initialize({}, 90_000), exitedEarly])
    await Promise.race([host.prompt('hang'), exitedEarly])
    await Promise.race([host.waitFor('the turn streams', row => row.type === 'wait' && row.state === 'done', 60_000), exitedEarly])
    const factsAsked = Date.now()
    const facts = host.request('session/facts', {}, 30_000)
    const interruptAsked = Date.now()
    const interrupted = await Promise.race([host.request('turn/interrupt', {}, 10_000), exitedEarly])
    const interruptMs = Date.now() - interruptAsked
    check(`turn/interrupt is answered in ${interruptMs} ms while the facts answer is held`, interrupted.interrupted === true && interruptMs < BOUND_MS, j(interrupted))
    await facts
    const factsMs = Date.now() - factsAsked
    check(`the facts answer arrives after its hold (${factsMs} ms ≥ ${HOLD_MS})`, factsMs >= HOLD_MS - 50)
    const outcome = await host.waitFor('the interrupted outcome', row => row.type === 'outcome', 60_000)
    check('the interrupted outcome follows', outcome.status === 'interrupted', j(outcome.status))
  } catch (error) {
    check('the runner door served the proof', false, error instanceof Error ? error.message : String(error))
  }
  await host.stop()
} else {
  const child = spawn(node, [DIST, 'run', '--format', 'rows', '--input', 'rows', '--model', 'claude-opus-4-8'], { cwd: scratch.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Frame[] = []
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  const reader = new LineReader()
  child.stdout.on('data', chunk => {
    for (const frame of reader.feed(String(chunk))) {
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
    }
  })
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += String(chunk)))
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const waitFor = (pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const hit = frames.find(pred)
      if (hit) return resolve(hit)
      const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs} ms; frames=${j(frames.map(f => `${String(f.type)}:${String(f.subtype ?? f.state ?? '')}`))} stderr=${stderr.slice(0, 300)}`)), timeoutMs)
      waiters.push({ pred, resolve: f => { clearTimeout(timer); resolve(f) } })
    })
  const send = (frame: Frame): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  try {
    send(userRow('hang'))
    await waitFor(isTurnWaiting, 60_000).catch(() => waitFor(f => f.type === 'wait' && f.state === 'done', 60_000))
    send(controlRequestFrame('facts-1', { subtype: 'session_facts' }))
    const interruptAsked = Date.now()
    send(controlRequestFrame('interrupt-1', { subtype: 'interrupt' }))
    await waitFor(f => isControlResponse(f, 'interrupt-1'), 30_000)
    const interruptMs = Date.now() - interruptAsked
    check(`the interrupt is answered in ${interruptMs} ms while the facts answer is held`, interruptMs < BOUND_MS, `the interrupt must not wait behind the facts answer`)
  } catch (error) {
    check('the rows door served the proof', false, error instanceof Error ? error.message : String(error))
  }
  child.stdin.end()
  const killer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await exited
  clearTimeout(killer)
}
await api.close()
rmSync(scratch.home, { recursive: true, force: true })
rmSync(scratch.cwd, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log(`❌ runner no-hol: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ runner no-hol: the interrupt never waits behind a slow answer')

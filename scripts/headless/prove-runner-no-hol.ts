#!/usr/bin/env bun
// gate-watch: src/daemon/runner/runHeadless.ts src/daemon/runner-wire/* src/daemon/runner/runnerMethods.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at !== -1 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') !== undefined ? resolve(argAfter('--dist')!) : join(ROOT, 'dist', 'mercury.mjs')
const HOLD_MS = 3_000
const BOUND_MS = 500

let failures = 0
const NO_HOL_FAIL_HINT = 'to fix, make the wire peer dispatch (dispatch in src/daemon/runner-wire/peer.ts) run turn/interrupt without waiting behind the held session/facts answer (answerSessionFacts in src/daemon/runner/sessionFactsArm.ts); this proof runs the built bundle, so rebuild it with bun run build.ts after the change'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${NO_HOL_FAIL_HINT}` : ''}`)
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
console.log(`no head-of-line blocking — ${DIST} through the runner door; the first facts answer is held ${HOLD_MS} ms (MERCURY_SESSION_FACTS_HOLD_MS)`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the proof exceeded 180s; the runner never streamed, answered the interrupt or reported its outcome, look at src/daemon/runner-wire/peer.ts (dispatch) and src/daemon/runner/sessionFactsArm.ts (answerSessionFacts)')
  process.exit(1)
}, 180_000)
guard.unref?.()

const api = await startFixtureApi([{ kind: 'hang', deltas: ['hanging…'] }])
const scratch = scratchHome('runner-no-hol-')
const env = { ...scratch.env, PATH: `/usr/bin:/bin:${dirname(node)}`, MERCURY_SESSION_FACTS_HOLD_MS: String(HOLD_MS), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }

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
await api.close()
rmSync(scratch.home, { recursive: true, force: true })
rmSync(scratch.cwd, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log(`❌ runner no-hol: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ runner no-hol: the interrupt never waits behind a slow answer')

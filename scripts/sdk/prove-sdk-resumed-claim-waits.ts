#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
import { METHODS } from '../../sdk/src/wire.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { describeSeat, seatRuntime } from '../lib/seatLauncher.ts'
import { PYTHON } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const HOOK_SECONDS = 12
const SEED_WORDS = 'remember the first turn'
const PROMPT_WORDS = 'say the word'
const PYTHON_PROMPT_WORDS = 'say the word again'
const REPLY = 'THE WORD AFTER THE LOAD.'
const guard = setTimeout(() => { console.error('FAIL prove-sdk-resumed-claim-waits timed out'); process.exit(1) }, 300_000)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-resumed-claim-')))
const cwd = join(home, 'project')
mkdirSync(cwd)
seedFirstRun(home, [cwd])
const seat = seatRuntime(home)
const mercury = [seat.exe, seat.script]
const api = await startFixtureApi([
  { kind: 'text', text: 'Seeded.', whenSaid: SEED_WORDS },
  { kind: 'text', text: REPLY, whenSaid: PROMPT_WORDS },
  { kind: 'text', text: REPLY, whenSaid: PYTHON_PROMPT_WORDS },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])
const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_PARTY: '0', MERCURY_TERMINAL_TITLE: '0', ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
const queueAddDeadlineMs = METHODS['queue/add'].deadlineMs

console.log('============================================================')
console.log(' the SDK\'s resumed claim waits for the load: claim({ resume: true }) resolves once the runner\'s facts answer, so the first prompt never meets the queue/add deadline')
console.log(` the runner holds queue/add until the claimed session is loaded; the table gives queue/add ${queueAddDeadlineMs} ms; the resumed session carries a ${HOOK_SECONDS}s session.start hook`)
console.log(` red on the base: claim() resolved at the binding and the prompt sent right after it rejected with "queue/add: no answer within ${queueAddDeadlineMs} ms"`)
console.log(` the runner: ${describeSeat(seat)}`)
console.log('============================================================')

try {
  section('§1 seed a session with one turn, then make its resume slow')
  const seeded = sdk.run({ mercury, cwd, env, prompt: SEED_WORDS })
  const seededOutcome = await seeded.outcome
  check('the seed turn completes', seededOutcome.status === 'completed', j(seededOutcome))
  const sid = (await seeded.session).session_id
  check('the seed session has an id', typeof sid === 'string' && sid.length > 0, j(sid))
  writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ events: { hooks: { 'session.start': [{ name: 'slow-start', run: `sleep ${HOOK_SECONDS}` }] } } })}\n`)

  section(`§2 TypeScript: claim({ resume: true }) then prompt() at once — the prompt runs after the ${HOOK_SECONDS}s load`)
  const warm = await sdk.connect({ mercury, cwd, env, warm: true, timeoutMs: 60_000 })
  try {
    check('the warm runner is unclaimed', warm.sessionId === null)
    const claimAt = Date.now()
    const receipt = await warm.claim({ session_id: sid, resume: true })
    const claimMs = Date.now() - claimAt
    check('the claim names the resumed session and the identity follows it', receipt.session_id === sid && warm.sessionId === sid, j({ receipt, sessionId: warm.sessionId }))
    check(`the claim resolved after the load (${claimMs} ms ≥ ${HOOK_SECONDS}s): the facts answer is its readiness`, claimMs >= HOOK_SECONDS * 1000, `${claimMs} ms`)
    const promptAt = Date.now()
    let outcome: sdk.OutcomeRow | null = null
    let promptError: unknown = null
    try { outcome = await warm.prompt(PROMPT_WORDS, { timeoutMs: 60_000 }) } catch (error) { promptError = error }
    check(`the first prompt is accepted and completes — no "${queueAddDeadlineMs} ms" queue/add deadline`, promptError === null && outcome?.status === 'completed', promptError instanceof Error ? promptError.message : j(outcome))
    check('the reply is the fixture\'s word for the resumed turn', outcome?.answer === REPLY, j(outcome?.answer))
    check('the prompt itself was not what waited for the load', Date.now() - promptAt < HOOK_SECONDS * 1000, `${Date.now() - promptAt} ms`)
    const requests = api.messageRequests()
    const last = requests[requests.length - 1]
    const lastBody = JSON.stringify(last?.body ?? null)
    check('the resumed turn carried the seeded conversation (the load finished before the prompt ran)', lastBody.includes(SEED_WORDS) && lastBody.includes(PROMPT_WORDS), `${requests.length} message request(s)`)
    const facts = await warm.facts()
    const usedTokens = (facts.usage as { context?: { used_tokens?: number | null } }).context?.used_tokens
    check('the facts after the claim carry the loaded context', typeof usedTokens === 'number' && usedTokens > 0, j(facts.usage))
  } finally { await warm.close() }

  section('§3 Python: the same road')
  const child = spawn(PYTHON, [join(root, 'scripts/sdk/python-resumed-claim.py'), JSON.stringify(mercury), cwd, sid, String(HOOK_SECONDS), PYTHON_PROMPT_WORDS, REPLY], { cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  check('the Python resumed claim resolves after the load and its first prompt completes', code === 0, `exit ${code}`)

  section('§4 source pins: the waiting road in both packages')
  const ts = readFileSync(join(root, 'sdk/src/runner.ts'), 'utf8')
  const tsClaim = ts.slice(ts.indexOf('  async claim(params'), ts.indexOf('  async prompt<'))
  check('the TypeScript claim awaits session/facts with no deadline when resume is true, before it takes the identity', tsClaim.includes("if (params.resume === true) await this.request('session/facts', {}, { deadlineMs: null })") && tsClaim.indexOf("'session/facts'") < tsClaim.indexOf('this.initialized.session_id = receipt.session_id'))
  const py = readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/runner.py'), 'utf8')
  const pyClaim = py.slice(py.indexOf('    async def claim('), py.indexOf('    def clear_rows('))
  check('the Python claim awaits session/facts with no timeout when resume is True, before it takes the identity', pyClaim.includes("if resume is True: await self.request('session/facts', timeout=None)") && pyClaim.indexOf("'session/facts'") < pyClaim.indexOf("self.initialized['session_id'] = receipt['session_id']"))
  const run = readFileSync(join(root, 'src/cli/run.ts'), 'utf8')
  check('the runner holds queue/add until the claim settles and answers session/facts only then', run.includes("peer.holdScope('queue')") && run.includes('releaseQueueUntilClaimed?.()') && /'session\/facts': async \(\) => \{\s*\n\s*if \(claimSettling !== null\) await claimSettling/.test(run))
  check(`the method table gives queue/add a ${queueAddDeadlineMs} ms deadline (the number the base's red named)`, queueAddDeadlineMs === 5_000, j(queueAddDeadlineMs))
} catch (error) {
  failures++
  console.log(`  [FAIL] the proof threw — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  clearTimeout(guard)
  await api.close()
}

if (failures !== 0) console.log(`[forensics] world kept: ${home}`)
else {
  try { removeScratch(home) } catch (error) { console.log(`  scratch kept: ${home} (${error instanceof Error ? error.message : String(error)})`) }
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-sdk-resumed-claim-waits: ALL LAWS HOLD' : `prove-sdk-resumed-claim-waits: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

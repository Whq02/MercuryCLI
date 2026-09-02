#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'effort-chain-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(join(scratch, 'daemon'), { recursive: true })
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' effort chain of custody — asked tier in, honest words out')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

section('§1 — the daemon admit door: normalize, else refuse typed naming the ladder')
{
  const sup = await import('../../src/daemon/concourseSupervisor.ts')
  const admit = sup.makeConcourseAdmitHandler({ roster: () => undefined, dir: join(scratch, 'daemon') })
  const junk = await admit({ workspaceDir: scratch, effort: 'ultra mega' })
  check('junk effort refuses', junk.ok === false, JSON.stringify(junk))
  check(
    '…typed, naming the whole ladder',
    junk.ok === false && /low \| medium \| high \| xhigh \| max/.test(junk.error ?? ''),
    junk.ok === false ? junk.error : '',
  )
  const spoken = await admit({ workspaceDir: scratch, effort: 'max effort' })
  check(
    "'max effort' passes the effort gate (whatever refuses next, it is not the ladder)",
    spoken.ok === false && !/not on the shared ladder/.test(spoken.error ?? ''),
    JSON.stringify(spoken),
  )
}

section('§2 — the set-effort verb door: same normalizer, same typed refusal')
{
  const seat = await import('../../src/daemon/sessionSeat.ts')
  const roster = { has: () => ({ present: false, alive: false }), control: () => false } as never
  const junk = seat.setSessionEffort('00000000-0000-0000-0000-000000000000', 'turbo', roster, join(scratch, 'daemon'))
  check('junk effort refuses at the door', junk.outcome === 'refused' && /the levels are/.test(junk.detail ?? ''), JSON.stringify(junk))
  const spoken = seat.setSessionEffort('00000000-0000-0000-0000-000000000000', 'x high', roster, join(scratch, 'daemon'))
  check(
    "'x high' normalizes and walks on to the session lookup",
    spoken.outcome === 'refused' && /unknown-session/.test(spoken.detail ?? ''),
    JSON.stringify(spoken),
  )
}

section('§3 — the launch receipt names the effort the session started at')
const tools = await import('../../src/services/concourse/coordinatorTools.ts')
const defs = tools.coordinatorToolSet()
const launch = defs.find(d => d.name === 'launch_session')!
{
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => ({
      ok: true,
      state: 'starting',
      sessionId: 'sess-effort-1',
      runnerId: 'w-1',
      modelId: 'claude-opus-5',
      modelDisplayName: 'Opus 5',
      effort: 'max',
    }),
    readWorkers: async () => ({}) as never,
  })
  const out = await launch.run({ task: 'deep refactor', effort: 'max effort' }, ctx)
  const body = JSON.parse(out.content) as Record<string, unknown>
  check('the launch reported ok', body.ok === true, out.content)
  check('the tool answer carries the started effort', body.effort === 'max', out.content)
  const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
  check('…and the receipt says @ max effort', /@ max effort/.test(String(receipt?.detail)), String(receipt?.detail))
  check('…with no default-disclaimer (a tier WAS asked)', !/no tier was asked/.test(String(receipt?.detail)), String(receipt?.detail))
}
{
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => ({
      ok: true,
      state: 'starting',
      sessionId: 'sess-effort-2',
      runnerId: 'w-2',
      modelId: 'claude-opus-5',
      modelDisplayName: 'Opus 5',
      effort: 'high',
    }),
    readWorkers: async () => ({}) as never,
  })
  const out = await launch.run({ task: 'small fix' }, ctx)
  const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
  check('an unasked launch names the default it landed on', /@ high effort \(the default — no tier was asked\)/.test(String(receipt?.detail)), String(receipt?.detail))
}
{
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => ({
      ok: true,
      state: 'starting',
      sessionId: 'sess-effort-3',
      runnerId: 'w-3',
      modelId: 'claude-opus-4-6',
      modelDisplayName: 'Opus 4.6',
      effort: 'xhigh',
    }),
    readWorkers: async () => ({}) as never,
  })
  const out = await launch.run({ task: 'hard bug', effort: 'x high' }, ctx)
  const body = JSON.parse(out.content) as Record<string, unknown>
  const receipt = (out.receipts ?? []).find(r => r.verb === 'session.launch')
  check('the receipt speaks asked-vs-runs', /asked xhigh; this model's ladder tops at high/.test(String(receipt?.detail)), String(receipt?.detail))
  check('the tool answer carries both facts', body.effort === 'xhigh' && body.effortRuns === 'high', out.content)
}

section('§4 — junk refuses BEFORE any birth: the rpc never fires')
{
  let rpcCalls = 0
  const ctx = tools.createCoordinatorToolContext({
    workspaceRoot: scratch,
    by: 'coordinator-seat',
    rpc: async () => {
      rpcCalls += 1
      return { ok: true }
    },
    readWorkers: async () => ({}) as never,
  })
  const out = await launch.run({ task: 'anything', effort: 'ludicrous' }, ctx)
  const body = JSON.parse(out.content) as Record<string, unknown>
  check('the tool refused', body.ok === false, out.content)
  check('…naming the ladder with max as the top tier', /low \| medium \| high \| xhigh \| max/.test(String(body.refused ?? body.error ?? out.content)), out.content)
  check('…and NO session was started (zero rpc calls)', rpcCalls === 0, String(rpcCalls))
}

section('§5 — the tool contract: the ladder named, the relay duty carried')
{
  const schemaText = JSON.stringify(launch.inputJSONSchema)
  check('the effort field names the whole ladder', /low \| medium \| high \| xhigh \| max/.test(schemaText), schemaText.slice(0, 200))
  check('…and says plain spellings resolve', /max effort/.test(schemaText) && /x high/.test(schemaText))
  check('the tool description carries the asked-vs-runs relay duty', /lower tier than asked/.test(launch.description))
  check('…and states max is the real top tier', /max IS the top tier/.test(launch.description))
}

console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ EFFORT-CHAIN-CUSTODY RED' : '✅ EFFORT-CHAIN-CUSTODY GREEN')
process.exit(failures)

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let doorSource = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  const doorHint = ok ? '' : 'change the effort check in ' + doorSource
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${doorHint ? ` — ${doorHint}` : ''}`)
}
const section = (t: string): void => {
  doorSource = t.startsWith('§1') ? 'src/daemon/concourse-workers/admit.ts (makeConcourseAdmitHandler)' : 'src/daemon/session-seat/effort.ts (setSessionEffort)'
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'effort-chain-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'MERCURY_EFFORT_LEVEL']) {
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

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

section('§1 — the daemon admit door: normalize, else refuse typed naming the ladder')
{
  const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
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
    spoken.ok === false && !/not a valid level/.test(spoken.error ?? ''),
    JSON.stringify(spoken),
  )
}

section('§2 — the set-effort verb door: same normalizer, same typed refusal')
{
  const seat = await import('../../src/daemon/session-seat/sessionSeat.ts')
  const roster = { has: () => ({ present: false, alive: false }), door: () => undefined } as never
  const junk = await seat.setSessionEffort('00000000-0000-0000-0000-000000000000', 'turbo', roster, join(scratch, 'daemon'))
  check('junk effort refuses at the door', junk.outcome === 'refused' && /the levels are/.test(junk.detail ?? ''), JSON.stringify(junk))
  const spoken = await seat.setSessionEffort('00000000-0000-0000-0000-000000000000', 'x high', roster, join(scratch, 'daemon'))
  check(
    "'x high' normalizes and walks on to the session lookup",
    spoken.outcome === 'refused' && /unknown-session/.test(spoken.detail ?? ''),
    JSON.stringify(spoken),
  )
}

console.log('\n' + '═'.repeat(60))
console.log(failures ? '❌ EFFORT-CHAIN-CUSTODY RED' : '✅ EFFORT-CHAIN-CUSTODY GREEN')
process.exit(failures)

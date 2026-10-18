#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const at = process.argv.indexOf('--dist')
const DIST = resolve(at < 0 ? join(process.cwd(), 'dist', 'mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'seat-wait-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const wsA = join(SCRATCH, 'ws-a')
const wsB = join(SCRATCH, 'ws-b')
for (const d of [home, daemonDir, work, wsA, wsB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(250)
  }
}

console.log('§1 the refusal names who holds the seats and what frees one (the pure admission)')
{
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  const live = [
    { workspaceId: '/scratch/a', title: 'fix the failing tests' },
    { workspaceId: '/scratch/b', title: 'docs pass' },
    { workspaceId: '/scratch/c', title: 'a title long enough to be cut at thirty-two characters for the sentence' },
    { workspaceId: '/scratch/d' },
  ]
  const refused = sup.evaluateConcourseAdmission(live, { workspaceId: '/scratch/e' }, 4)
  const reason = refused.admit ? '' : refused.reason
  check('the sentence counts the holders against the seats', reason.includes('4 live sessions hold the 4 seats'), reason)
  check('…names up to three of them by title, the long one cut, and counts the rest', reason.includes('“fix the failing tests”, “docs pass”, “a title long enough to be cut a…” and 1 more'), reason)
  check("…and still spells the machine's reading", reason.includes("this machine's reading: 4 seats"), reason)
  const moves = refused.admit ? [] : (refused.moves ?? [])
  check('the moves say what frees a seat: stop or park a live session, or raise the ceiling with /seats N', moves.some(m => m.verb === 'pause-holder' && /stop or park a live session/.test(m.label)) && moves.some(m => /\/seats N/.test(m.label)), JSON.stringify(moves))
  const one = sup.evaluateConcourseAdmission([{ workspaceId: '/scratch/a' }], { workspaceId: '/scratch/b' }, 1)
  check('one holder, one seat: the singular sentence, no title list', !one.admit && one.reason.startsWith('every seat is taken: 1 live session holds the 1 seat (') && !one.reason.includes('“'), one.admit ? '' : one.reason)
  check('a sentence without titles names only the count', sup.seatHoldersWords([{ workspaceId: '/x' }, { workspaceId: '/y' }], 2) === '2 live sessions hold the 2 seats')
}

console.log('§2 the live daemon: a one-seat world refuses the second birth with the words and its moves on the wire, and a birth that asks to wait lands when the seat frees')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work, wsA, wsB])
{
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: 0, allowed: true, recommendedSeats: 1 }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
}
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([{ kind: 'text', text: 'seat wait turn' }])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { WARM_BOOT_ALLOWANCE_MS } = await import('../../src/daemon/warmRunner.ts')
const ADMISSION_ANSWER_MS = Math.max(WARM_BOOT_ALLOWANCE_MS, 60_000)

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    HOME: SCRATCH,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const daemonExited = new Promise<void>(r => daemon.once('exit', () => r()))
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the seat-wait proof exceeded 240 s')
  process.exit(1)
}, 240_000)
guard.unref?.()

type AdmitReply = { ok: boolean; code?: string; runnerId?: string; workerId?: string; sessionId?: string; pid?: number; error?: string; refusal?: string; moves?: Array<{ verb: string; label: string }> }
const admit = (workspaceDir: string, extra: Record<string, unknown> = {}, timeoutMs = ADMISSION_ANSWER_MS): Promise<AdmitReply> =>
  daemonControlRpc({ op: 'sessionAdmit', workspaceDir, isolation: 'shared', bornBlank: true, ...extra } as never, { timeoutMs }) as Promise<AdmitReply>

try {
  check('the daemon answers ping on its control socket', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const first = await admit(wsA, { title: 'the first chat' })
  check('the first birth takes the one seat', first.ok === true && typeof first.sessionId === 'string', JSON.stringify(first))
  const refused = await admit(wsB, { title: 'the second chat' })
  check('the second birth is refused on the seat', refused.ok === false && refused.refusal === 'runtime-ceiling', JSON.stringify(refused))
  check('…the sentence names the holder by title and the seat count', /1 live session holds the 1 seat \(“the first chat”\)/.test(refused.error ?? ''), refused.error ?? '')
  check('…and the moves ride the wire: stop or park a live session, or /seats N', Array.isArray(refused.moves) && refused.moves.some(m => /stop or park a live session/.test(m.label)) && refused.moves.some(m => /\/seats N/.test(m.label)), JSON.stringify(refused.moves))

  const t0 = Date.now()
  const waiting = admit(wsB, { title: 'the second chat', waitForSeatMs: 30_000 }, 90_000)
  await wait(2_500)
  const runnerId = first.runnerId ?? first.workerId
  const released = (await daemonControlRpc({ op: 'sessionRelease', runnerId } as never)) as { ok: boolean; settled?: boolean }
  check('the first session is released (its seat frees)', released.ok === true, JSON.stringify(released))
  const landed = await waiting
  const waitedMs = Date.now() - t0
  check(`a birth that asked to wait landed when the seat freed (${waitedMs} ms after it asked; no retry pressed)`, landed.ok === true && typeof landed.sessionId === 'string' && waitedMs < 25_000, JSON.stringify(landed))

  const t1 = Date.now()
  const expired = await admit(wsA, { title: 'the third chat', waitForSeatMs: 3_000 }, 60_000)
  const waited = Date.now() - t1
  check('a birth whose wait ends with every seat still taken is refused, saying how long it waited and what frees a seat', expired.ok === false && expired.refusal === 'runtime-ceiling' && /no seat freed in 3 s/.test(expired.error ?? '') && waited >= 2_500 && Array.isArray(expired.moves) && expired.moves.some(m => /\/seats N/.test(m.label)), `${waited} ms · ${JSON.stringify(expired)}`)
  if (landed.ok) await daemonControlRpc({ op: 'sessionRelease', runnerId: landed.runnerId ?? landed.workerId } as never)
} finally {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never).catch(() => {})
  await Promise.race([daemonExited, wait(10_000)])
  try { daemon.kill('SIGKILL') } catch {}
  await api.close()
  clearTimeout(guard)
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures === 0 ? '\n✅ seat wait: all laws hold' : `\n❌ seat wait: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

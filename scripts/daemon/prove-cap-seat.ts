#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-cap-seat: the drive signals the runner with POSIX signals — nothing to drive on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'capseat-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# cap seat fixture\n')
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MERCURY_CAP_FAILOVER',
  'MERCURY_MOCK_LIMITS',
]) {
  delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const fixtureWords = await import('./cap-fixture-words.ts')
const { SPEND_ASK, HOLD_ASK, ANTHROPIC_REPLY, OPENAI_REPLY, GPT_ID } = fixtureWords

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-cap-seat exceeded 270s')
  process.exit(1)
}, 270_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {
    }
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-00000000cafe', emailAddress: 'sam@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')

type Rec = {
  runnerId: string
  sessionId: string
  workspaceId: string
  modelKey: string
  pendingModelKey?: string
  pid?: number
  stoppedAt?: number
  parkedAt?: number
  retired?: unknown
  crash?: { at: number; reason: string; respawning: boolean }
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  endedAt?: number
}
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean; atMs?: number; model?: { effective: string }; pendingModel?: string | null } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as ReturnType<typeof readFacts>
  } catch {
    return undefined
  }
}
type Capture = { kind: string; ask?: string; model?: string; status?: number | string; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const mainHits = (): Capture[] => wire().filter(c => (c.kind === 'anthropic' || c.kind === 'openai') && typeof c.ask === 'string')
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
type Row = {
  payload?: { kind?: string; content?: Array<{ kind?: string; text?: string }> | string }
  annotations?: { isApiErrorMessage?: boolean; uuid?: string }
}
const transcriptRows = (sid: string): Row[] => {
  const rec = readRec(sid)
  const file = join(paths.getProjectDir(rec?.workspaceId ?? work), `${sid}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => {
      try {
        return JSON.parse(l) as Row
      } catch {
        return {}
      }
    })
}
const textOf = (row: Row): string => {
  const content = row.payload?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b.kind === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
}
const assistantRows = (sid: string): Row[] => transcriptRows(sid).filter(r => r.payload?.kind === 'output')
const lastAssistantText = (sid: string): string => {
  const rows = assistantRows(sid)
  return rows.length === 0 ? '' : textOf(rows[rows.length - 1]!)
}

const fixture = spawn('node', [join(REPO, 'scripts', 'daemon', 'cap-fixture-server.ts'), captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[fixture] ${chunk.toString('utf8')}`))
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const logFd = openSync(daemonLogPath, 'a')
const daemon: ChildProcess = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: base,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 })
  } catch {
  }
  await sleep(500)
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
    }
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

type Outcome = { ok?: boolean; outcome?: string; detail?: string; error?: string }
const control = async (action: string, sessionId: string, extra: Record<string, unknown> = {}): Promise<Outcome> =>
  (await daemonControlRpc({ op: 'sessionControl', action, sessionId, by: 'operator', ...extra } as never, { timeoutMs: 30_000 })) as Outcome
const setModel = (sessionId: string, model: string): Promise<Outcome> => control('set-model', sessionId, { model })
const say = async (prompt: string, target?: string, model?: string): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  (await daemonControlRpc(
    {
      op: 'sessionDispatch',
      clientMessageId: `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      workspaceDir: work,
      ...(target !== undefined ? { targetSessionId: target } : { title: 'Cap seat' }),
      ...(model !== undefined ? { model } : {}),
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; error?: string }
const turnEnded = (sid: string): boolean => {
  const rec = readRec(sid)
  const facts = readFacts(sid)
  return rec !== undefined && (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) && facts?.busy === false
}
const sinceHits = (n: number): Capture[] => mainHits().slice(n)

console.log('cap seat — a spent window never kills the seat; a model switch always lands')
console.log(`  home ${home}\n  fixture ${base}`)

let sid = ''
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§1 a live session on the Fable row answers from the fixture')
  const born = await say('hello there', undefined, 'claude-fable-5-1')
  check('the session dispatched onto a real runner', born.ok === true && typeof born.sessionId === 'string', JSON.stringify(born))
  sid = born.sessionId ?? ''
  check('the first turn ended', await untilAsync(() => turnEnded(sid), 90_000), JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  const first = mainHits()
  check('the wire carried the ask on the Anthropic wire, on the Fable row, answered 200', first.some(h => h.kind === 'anthropic' && h.model === 'claude-fable-5-1' && h.status === 200), JSON.stringify(first))
  check('the transcript carries the reply', lastAssistantText(sid).includes(ANTHROPIC_REPLY), lastAssistantText(sid).slice(0, 200))
  const pid1 = readRec(sid)?.pid
  check('the runner is alive', alive(pid1), `pid ${pid1}`)

  section('§2 C1 the spent window ends the turn typed — the runner stays, its channel open')
  const before2 = mainHits().length
  const spent = await say(SPEND_ASK, sid)
  check('the ask that spends the window was delivered', spent.ok === true, JSON.stringify(spent))
  check('the wire answered 429 with the unified headers', await untilAsync(() => sinceHits(before2).some(h => h.kind === 'anthropic' && h.status === 429), 60_000), JSON.stringify(sinceHits(before2)))
  const ended = await untilAsync(() => turnEnded(sid), 45_000)
  check('C1 the turn ENDED on the cap (no retry sleep, no hang)', ended, JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  check('C1 exactly one request carried the spent ask (a subscriber refusal is never retried)', sinceHits(before2).filter(h => h.kind === 'anthropic').length === 1, JSON.stringify(sinceHits(before2)))
  const rec2 = readRec(sid)
  check('C1 the runner is ALIVE after the cap', rec2 !== undefined && alive(rec2.pid) && rec2.pid === pid1, `pid ${rec2?.pid} (was ${pid1}) alive=${alive(rec2?.pid)}`)
  check('C1 the record carries no crash, stop or park stamp', rec2 !== undefined && rec2.crash === undefined && rec2.stoppedAt === undefined && rec2.parkedAt === undefined, JSON.stringify(rec2))
  const wall = lastAssistantText(sid)
  check('C1 the wall row is the typed end: it names the window and its reset', /window|limit/i.test(wall) && /resets/i.test(wall), wall.slice(0, 300))
  check('C1 the wall row names the /model door', wall.includes('/model'), wall.slice(0, 300))
  console.log(`      wall row: ${wall.replace(/\n/g, ' ↵ ').slice(0, 400)}`)

  section('§3 C2/C4 the family switch on the live idle runner: Fable → GPT lands in place')
  const sw1 = await setModel(sid, GPT_ID)
  check('the switch was APPLIED (never "no live control channel")', sw1.ok === true && sw1.outcome === 'applied', JSON.stringify(sw1))
  console.log(`      switch receipt: ${JSON.stringify(sw1)}`)
  check('the record and the facts carry the new model', await untilAsync(() => readRec(sid)?.modelKey === GPT_ID && readFacts(sid)?.model?.effective === GPT_ID, 20_000), JSON.stringify({ rec: readRec(sid)?.modelKey, facts: readFacts(sid)?.model }))
  const before3 = mainHits().length
  const again = await say('hello again', sid)
  check('the next ask was delivered', again.ok === true, JSON.stringify(again))
  check('the next turn ended', await untilAsync(() => sinceHits(before3).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before3), rec: readRec(sid), facts: readFacts(sid) }))
  check('C4 the next call rode the OpenAI wire on the GPT row, answered 200', sinceHits(before3).some(h => h.kind === 'openai' && h.model === GPT_ID && h.status === 200), JSON.stringify(sinceHits(before3)))
  check('the transcript carries the GPT reply', lastAssistantText(sid).includes(OPENAI_REPLY), lastAssistantText(sid).slice(0, 200))

  section('§4 C1 on the OpenAI wire: the GPT cap ends the turn typed the same way')
  const before4 = mainHits().length
  const spentGpt = await say(SPEND_ASK, sid)
  check('the ask that spends the GPT window was delivered', spentGpt.ok === true, JSON.stringify(spentGpt))
  check('the OpenAI wire answered 429 usage_limit_reached', await untilAsync(() => sinceHits(before4).some(h => h.kind === 'openai' && h.status === 429), 60_000), JSON.stringify(sinceHits(before4)))
  check('C1 the turn ENDED on the GPT cap', await untilAsync(() => turnEnded(sid), 45_000), JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  const rec4 = readRec(sid)
  check('C1 the runner is ALIVE after the GPT cap', rec4 !== undefined && alive(rec4.pid) && rec4.pid === pid1, `pid ${rec4?.pid} alive=${alive(rec4?.pid)}`)
  const gptWall = lastAssistantText(sid)
  check('C1 the GPT wall row names the window, its reset and the /model door', /usage window/i.test(gptWall) && /resets/i.test(gptWall) && gptWall.includes('/model'), gptWall.slice(0, 300))
  console.log(`      gpt wall row: ${gptWall.replace(/\n/g, ' ↵ ').slice(0, 400)}`)
  const swBack = await setModel(sid, 'claude-fable-5-1')
  check('the switch back to the Fable row lands in place', swBack.ok === true && swBack.outcome === 'applied', JSON.stringify(swBack))
  check('the record carries the Fable row again', await untilAsync(() => readRec(sid)?.modelKey === 'claude-fable-5-1', 20_000), JSON.stringify(readRec(sid)?.modelKey))

  section('§5 C2 the runner cut by the hard stop: /model respawns it on the requested row')
  const before5 = mainHits().length
  const held = await say(HOLD_ASK, sid)
  check('the held ask was delivered', held.ok === true, JSON.stringify(held))
  check('the wire holds the reply open', await untilAsync(() => sinceHits(before5).some(h => h.kind === 'anthropic' && h.status === 'held'), 60_000), JSON.stringify(sinceHits(before5)))
  await sleep(400)
  const pidHeld = readRec(sid)?.pid
  if (pidHeld !== undefined) process.kill(pidHeld, 'SIGSTOP')
  const hard = await control('interrupt', sid, { hard: true })
  check('the hard interrupt was delivered', hard.ok === true && hard.outcome === 'applied', JSON.stringify(hard))
  check('the daemon cut the runner', await untilAsync(() => daemonLog().includes(`hard stop: ${readRec(sid)?.runnerId ?? '?'} still holds its turn`), 10_000), daemonLog().split('\n').slice(-8).join('\n'))
  if (pidHeld !== undefined) {
    try {
      process.kill(pidHeld, 'SIGCONT')
    } catch {
    }
  }
  check('the cut runner is DEAD', await untilAsync(() => !alive(pidHeld), 10_000), `pid ${pidHeld} alive=${alive(pidHeld)}`)
  check('the facts fell idle with it', await untilAsync(() => readFacts(sid)?.busy === false, 10_000), JSON.stringify(readFacts(sid)))
  const recCut = readRec(sid)
  check('the record still stands live (no stop stamp — the session survives its runner)', recCut !== undefined && recCut.stoppedAt === undefined && recCut.endedAt === undefined, JSON.stringify(recCut))
  const sw2 = await setModel(sid, 'claude-opus-5')
  console.log(`      switch receipt on the cut runner: ${JSON.stringify(sw2)}`)
  check('C2 the same-family switch on the cut runner is APPLIED — never "no live control channel"', sw2.ok === true && sw2.outcome === 'applied', JSON.stringify(sw2))
  check('C2 the receipt says the runner had been cut and was restarted on the requested row', typeof sw2.detail === 'string' && /had been cut|had exited/.test(sw2.detail) && /restarted on/.test(sw2.detail) && /Opus 5|claude-opus-5/.test(sw2.detail) && (sw2 as { respawned?: unknown }).respawned === true, JSON.stringify(sw2))
  const respawned = await untilAsync(() => {
    const r = readRec(sid)
    return r !== undefined && r.pid !== undefined && r.pid !== pidHeld && alive(r.pid)
  }, 20_000)
  check('C2 the daemon respawned the runner (a new live pid on the same session)', respawned, JSON.stringify(readRec(sid)))
  check('C2 the record carries the requested model', readRec(sid)?.modelKey === 'claude-opus-5' && readRec(sid)?.pendingModelKey === undefined, JSON.stringify({ model: readRec(sid)?.modelKey, pending: readRec(sid)?.pendingModelKey }))
  const rowsBefore = transcriptRows(sid).length
  const before5b = mainHits().length
  const onceMore = await say('hello once more', sid)
  check('the next ask was delivered to the respawned runner', onceMore.ok === true, JSON.stringify(onceMore))
  check('the next turn ended', await untilAsync(() => sinceHits(before5b).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before5b), rec: readRec(sid), facts: readFacts(sid) }))
  check('C2 the next call rode the Anthropic wire on the Opus row', sinceHits(before5b).some(h => h.kind === 'anthropic' && h.model === 'claude-opus-5' && h.status === 200), JSON.stringify(sinceHits(before5b)))
  check('C2 the session kept its transcript across the respawn (the rows before the switch stand)', rowsBefore >= 4 && transcriptRows(sid).length > rowsBefore && transcriptRows(sid).some(r => textOf(r).includes(ANTHROPIC_REPLY)), `${rowsBefore} → ${transcriptRows(sid).length}`)

  section('§6 C2 the runner killed by hand: the family switch respawns it on the GPT row')
  const pidLive = readRec(sid)?.pid
  check('the runner is live before the kill', alive(pidLive), `pid ${pidLive}`)
  if (pidLive !== undefined) process.kill(pidLive, 'SIGKILL')
  check('the runner is dead', await untilAsync(() => !alive(pidLive), 10_000), `pid ${pidLive}`)
  const sw3 = await setModel(sid, GPT_ID)
  console.log(`      switch receipt on the killed runner: ${JSON.stringify(sw3)}`)
  check('C2 the family switch on the killed runner is APPLIED', sw3.ok === true && sw3.outcome === 'applied', JSON.stringify(sw3))
  check('C2 the receipt names the exit and the restart on the GPT row', typeof sw3.detail === 'string' && /had exited at \d\d:\d\d/.test(sw3.detail) && /restart(ed|ing) on GPT-5\.6 Sol/.test(sw3.detail) && (sw3 as { respawned?: unknown }).respawned === true, JSON.stringify(sw3))
  check('C2 the runner is live again on the GPT row', await untilAsync(() => {
    const r = readRec(sid)
    return r !== undefined && r.modelKey === GPT_ID && r.pendingModelKey === undefined && alive(r.pid) && r.pid !== pidLive
  }, 30_000), JSON.stringify(readRec(sid)))
  const before6 = mainHits().length
  const last = await say('hello at last', sid)
  check('the next ask was delivered', last.ok === true, JSON.stringify(last))
  check('the next turn ended', await untilAsync(() => sinceHits(before6).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before6), rec: readRec(sid), facts: readFacts(sid) }))
  check('C2 the next call rode the OpenAI wire on the GPT row', sinceHits(before6).some(h => h.kind === 'openai' && h.model === GPT_ID && h.status === 200), JSON.stringify(sinceHits(before6)))
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-cap-seat: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

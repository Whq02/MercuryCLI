#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
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

const reapTargets: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = []
const reapNow = (): void => {
  for (const p of reapTargets) {
    try {
      p.kill('SIGKILL')
    } catch {
    }
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-cap-seat exceeded 270s')
  reapNow()
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
const crashLines = (): string => daemonLog().split('\n').filter(l => /long-lived concourse-w\d+ crashed/.test(l)).join(' | ')
type LedgerRow = { ts: string; kind?: string; event?: string; id?: string; pid?: number; code?: number | null; signal?: string | null; outcome?: string }
const ledgerOf = (runnerId: string): LedgerRow[] => {
  const path = join(daemonDir, 'spawn-ledger.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as LedgerRow)
    .filter(r => r.id === `${runnerId}@concourse`)
}
const isExitRow = (r: LedgerRow): boolean => r.event === 'exit'
const isSpawnRow = (r: LedgerRow): boolean => r.kind === 'long-lived' && r.event === undefined
const exitRowsOf = (runnerId: string): LedgerRow[] => ledgerOf(runnerId).filter(isExitRow)
const ms = (iso: string): number => new Date(iso).getTime()
const respawnAfterExit = (runnerId: string, nth: number): { exit: LedgerRow; spawn: LedgerRow; gapMs: number } | null => {
  const rows = ledgerOf(runnerId)
  let seen = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (!isExitRow(row)) continue
    seen++
    if (seen !== nth) continue
    const next = rows.slice(i + 1).find(isSpawnRow)
    return next === undefined ? null : { exit: row, spawn: next, gapMs: ms(next.ts) - ms(row.ts) }
  }
  return null
}
const AT_ONCE_MS = 700
const clockOf = (atMs: number): string => new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
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
reapTargets.push(fixture)
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
  reapNow()
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
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DAEMON_OWNER_FD: '3',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
  },
  stdio: ['ignore', logFd, logFd, 'pipe'],
})
reapTargets.push(daemon)
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
  const modelsBefore2 = wire().filter(c => c.kind === 'models').length
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
  const capAt = sinceHits(before2).find(h => h.kind === 'anthropic' && h.status === 429)?.at ?? 0
  const modelsReads = wire().filter(c => c.kind === 'models')
  check('C1 the OpenAI catalogue was read when the wall row asked, not before (no models request before the cap; one at the wall)', modelsBefore2 === 0 && modelsReads.length >= 1 && modelsReads[0]!.at >= capAt, JSON.stringify({ before: modelsBefore2, readsSinceCapMs: modelsReads.map(r => r.at - capAt) }))
  check('C1 the wall row names the OpenAI family it read', /\/model moves there \(bills under your OpenAI account/.test(wall), wall.slice(0, 400))
  console.log(`      wall row: ${wall.replace(/\n/g, ' ↵ ').slice(0, 400)}`)

  section('§3 C2/C4 the family switch on the live idle runner: Fable → GPT lands in place')
  const sw1 = await setModel(sid, GPT_ID)
  check('the switch was APPLIED (never "no live control channel")', sw1.ok === true && sw1.outcome === 'applied', JSON.stringify(sw1))
  console.log(`      switch receipt: ${JSON.stringify(sw1)}`)
  check('the receipt on a runner with no standing crash row is the plain "<runner> → <model>"', sw1.detail === `${readRec(sid)?.runnerId} → ${GPT_ID}`, JSON.stringify(sw1))
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

  section('§5 C2 the runner killed through the roster (no stop stamp): /model respawns it on the requested row')
  const before5 = mainHits().length
  const held = await say(HOLD_ASK, sid)
  check('the held ask was delivered', held.ok === true, JSON.stringify(held))
  check('the wire holds the reply open', await untilAsync(() => sinceHits(before5).some(h => h.kind === 'anthropic' && h.status === 'held'), 60_000), JSON.stringify(sinceHits(before5)))
  await sleep(400)
  const pidHeld = readRec(sid)?.pid
  const runnerHeld = readRec(sid)?.runnerId ?? ''
  const second = await control('interrupt', sid, { hard: true })
  await sleep(1_500)
  check('the second-press interrupt was delivered and the daemon never signalled the runner for it (alive 1.5 s on, no cut line)', second.ok === true && second.outcome === 'applied' && alive(pidHeld) && !/hard stop:/.test(daemonLog()), JSON.stringify({ second, alive: alive(pidHeld) }))
  const killed = (await daemonControlRpc({ op: 'kill', short: runnerHeld } as never, { timeoutMs: 10_000 })) as { ok?: boolean }
  check('the roster kill (the raw op — a kill from outside the session verbs) took', killed.ok === true, JSON.stringify(killed))
  check('the killed runner is DEAD', await untilAsync(() => !alive(pidHeld), 10_000), `pid ${pidHeld} alive=${alive(pidHeld)}`)
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
  check('the facts read idle once the runner is back', await untilAsync(() => readFacts(sid)?.busy === false, 10_000), JSON.stringify(readFacts(sid)))
  check('C2 the record carries the requested model', readRec(sid)?.modelKey === 'claude-opus-5' && readRec(sid)?.pendingModelKey === undefined, JSON.stringify({ model: readRec(sid)?.modelKey, pending: readRec(sid)?.pendingModelKey }))
  const rowsBefore = transcriptRows(sid).length
  const before5b = mainHits().length
  const onceMore = await say('hello once more', sid)
  check('the next ask was delivered to the respawned runner', onceMore.ok === true, JSON.stringify(onceMore))
  check('the next turn ended', await untilAsync(() => sinceHits(before5b).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before5b), rec: readRec(sid), facts: readFacts(sid) }))
  check('C2 the next call rode the Anthropic wire on the Opus row', sinceHits(before5b).some(h => h.kind === 'anthropic' && h.model === 'claude-opus-5' && h.status === 200), JSON.stringify(sinceHits(before5b)))
  check('C2 the session kept its transcript across the respawn (the rows before the switch stand)', rowsBefore >= 4 && transcriptRows(sid).length > rowsBefore && transcriptRows(sid).some(r => textOf(r).includes(ANTHROPIC_REPLY)), `${rowsBefore} → ${transcriptRows(sid).length}`)

  section('§6 C2 the runner killed by hand: the crash arm respawns it at once, and the family switch lands on the respawned runner in place')
  const runnerLive = readRec(sid)?.runnerId ?? ''
  const pidLive = readRec(sid)?.pid
  check('the runner is live before the kill', alive(pidLive), `pid ${pidLive}`)
  const exitsBefore6 = exitRowsOf(runnerLive).length
  if (pidLive !== undefined) process.kill(pidLive, 'SIGKILL')
  check('the runner is dead', await untilAsync(() => !alive(pidLive), 10_000), `pid ${pidLive}`)
  check("C2 the crash row: the record carries the crash arm's stamp, respawning", await untilAsync(() => readRec(sid)?.crash?.respawning === true, 10_000), JSON.stringify(readRec(sid)?.crash))
  const crash6 = readRec(sid)?.crash
  check('C2 the crash row\'s words name the death and the resume: "crashed mid-run (exit none · signal SIGKILL) … · resumed — the interrupted ask needs a re-send"', crash6 !== undefined && /^crashed mid-run \(exit none · signal SIGKILL\)/.test(crash6.reason) && / · resumed — the interrupted ask needs a re-send$/.test(crash6.reason), JSON.stringify(crash6))
  check('C2 the daemon read the death as a crash and the ladder chose the respawn (its first)', await untilAsync(() => /long-lived concourse-w\d+ crashed \(code=null sig=SIGKILL\); respawn \(1\/\d+\)/.test(daemonLog()), 10_000), crashLines())
  const respawned6 = await untilAsync(() => respawnAfterExit(runnerLive, exitsBefore6 + 1) !== null, 10_000)
  const gap6 = respawnAfterExit(runnerLive, exitsBefore6 + 1)
  console.log(`      the ledger: exit ${gap6?.exit.outcome ?? '?'} → the respawn row ${gap6?.gapMs ?? '?'} ms later`)
  check(`C2 the ledger's exit row reads crash-respawn (signal SIGKILL) and the respawn row follows it at once (within ${AT_ONCE_MS} ms)`, respawned6 && gap6 !== null && gap6.exit.outcome === 'crash-respawn' && gap6.exit.signal === 'SIGKILL' && gap6.gapMs <= AT_ONCE_MS, gap6 === null ? JSON.stringify(exitRowsOf(runnerLive)) : `${gap6.exit.outcome} → respawn ${gap6.gapMs} ms later`)
  const back6 = await untilAsync(() => {
    const r = readRec(sid)
    return r !== undefined && r.pid !== undefined && r.pid !== pidLive && alive(r.pid)
  }, 20_000)
  const pidBack = readRec(sid)?.pid
  check('C2 the runner is back on its own (a new live pid on the same session, no switch sent yet)', back6, JSON.stringify(readRec(sid)))
  check('the facts read idle once the runner is back', await untilAsync(() => readFacts(sid)?.busy === false, 10_000), JSON.stringify(readFacts(sid)))
  check("C2 the respawn kept the Opus row, and the crash row stands until the operator's next act", readRec(sid)?.modelKey === 'claude-opus-5' && readRec(sid)?.pendingModelKey === undefined && readRec(sid)?.crash?.respawning === true, JSON.stringify({ model: readRec(sid)?.modelKey, pending: readRec(sid)?.pendingModelKey, crash: readRec(sid)?.crash }))
  const sw3 = await setModel(sid, GPT_ID)
  console.log(`      switch receipt on the respawned runner: ${JSON.stringify(sw3)}`)
  check('C2 the family switch on the respawned runner is APPLIED', sw3.ok === true && sw3.outcome === 'applied', JSON.stringify(sw3))
  check('C2 the receipt names the exit the record still shows and the landing in place: "the runner had exited at hh:mm (crashed mid-run (exit none · signal SIGKILL)) and is back — <runner> → <model>", the clock the crash row\'s own, no respawned flag', sw3.detail === `the runner had exited at ${clockOf(crash6?.at ?? 0)} (crashed mid-run (exit none · signal SIGKILL)) and is back — ${runnerLive} → ${GPT_ID}` && (sw3 as { respawned?: unknown }).respawned === undefined, JSON.stringify({ sw3, at: crash6?.at }))
  check('C2 the switch landed in place: the respawned pid stands', readRec(sid)?.pid === pidBack && alive(pidBack), JSON.stringify({ pid: readRec(sid)?.pid, pidBack }))
  check("C2 the record's crash row still stands after the switch (the row says the runner exited and resumed; the receipt did not)", readRec(sid)?.crash?.respawning === true && readRec(sid)?.crash?.at === crash6?.at, JSON.stringify(readRec(sid)?.crash))
  check('C2 the record and the facts carry the GPT row', await untilAsync(() => readRec(sid)?.modelKey === GPT_ID && readRec(sid)?.pendingModelKey === undefined && readFacts(sid)?.model?.effective === GPT_ID, 20_000), JSON.stringify({ rec: readRec(sid)?.modelKey, facts: readFacts(sid)?.model }))
  const before6 = mainHits().length
  const last = await say('hello at last', sid)
  check('the next ask was delivered', last.ok === true, JSON.stringify(last))
  check('the next turn ended', await untilAsync(() => sinceHits(before6).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before6), rec: readRec(sid), facts: readFacts(sid) }))
  check('C2 the next call rode the OpenAI wire on the GPT row', sinceHits(before6).some(h => h.kind === 'openai' && h.model === GPT_ID && h.status === 200), JSON.stringify(sinceHits(before6)))
  check("the operator's words landing cleared the crash row (the record's clear beat is the next ask, not the switch)", readRec(sid)?.crash === undefined, JSON.stringify(readRec(sid)?.crash))

  section("§7 C2b the runner killed by hand again inside the healthy window: the ladder's wait is armed, and the switch that meets the dead runner rides the respawn")
  const pidGpt = readRec(sid)?.pid
  check('the runner is live before the second kill', alive(pidGpt) && pidGpt !== pidLive, `pid ${pidGpt}`)
  const exitsBefore7 = exitRowsOf(runnerLive).length
  const killAt7 = Date.now()
  if (pidGpt !== undefined) process.kill(pidGpt, 'SIGKILL')
  check('the runner is dead', await untilAsync(() => !alive(pidGpt), 10_000), `pid ${pidGpt}`)
  check('C2b the crash row is stamped again, respawning', await untilAsync(() => {
    const c = readRec(sid)?.crash
    return c !== undefined && c.respawning && c.at >= killAt7
  }, 10_000), JSON.stringify(readRec(sid)?.crash))
  check("C2b the daemon read the second death inside the window as a loop forming: the ladder's second rung", await untilAsync(() => /long-lived concourse-w\d+ crashed \(code=null sig=SIGKILL\); respawn \(2\/\d+\)/.test(daemonLog()), 10_000), crashLines())
  const recDead = readRec(sid)
  check('C2b the switch meets a dead runner: the record still names the killed pid, and no respawn row has landed', recDead !== undefined && recDead.pid === pidGpt && !alive(pidGpt) && respawnAfterExit(runnerLive, exitsBefore7 + 1) === null, JSON.stringify({ rec: recDead, exits: exitRowsOf(runnerLive).length }))
  const switchAt7 = Date.now()
  const sw4 = await setModel(sid, 'claude-fable-5-1')
  console.log(`      switch receipt on the dead runner: ${JSON.stringify(sw4)}`)
  check('C2b the switch on the dead runner is APPLIED — never "no live control channel"', sw4.ok === true && sw4.outcome === 'applied', JSON.stringify(sw4))
  check('C2b the receipt names the exit and the restart: "the runner had exited at hh:mm (crashed mid-run (exit none · signal SIGKILL)) — restarting on Fable 5.1", respawned', typeof sw4.detail === 'string' && /^the runner had exited at \d\d:\d\d \(crashed mid-run \(exit none · signal SIGKILL\)\) — restarting on Fable 5\.1$/.test(sw4.detail) && (sw4 as { respawned?: unknown }).respawned === true, JSON.stringify(sw4))
  check("C2b the receipt's clock is the crash row's own stamp", typeof sw4.detail === 'string' && recDead?.crash !== undefined && sw4.detail.includes(`had exited at ${clockOf(recDead.crash.at)}`), JSON.stringify({ detail: sw4.detail, at: recDead?.crash?.at }))
  check('C2b the record took the Fable row in the same beat (nothing parked)', readRec(sid)?.modelKey === 'claude-fable-5-1' && readRec(sid)?.pendingModelKey === undefined, JSON.stringify({ model: readRec(sid)?.modelKey, pending: readRec(sid)?.pendingModelKey }))
  check("C2b the ladder's respawn lands the runner on the Fable row (a new live pid)", await untilAsync(() => {
    const r = readRec(sid)
    return r !== undefined && r.pid !== undefined && r.pid !== pidGpt && alive(r.pid) && r.modelKey === 'claude-fable-5-1'
  }, 30_000), JSON.stringify(readRec(sid)))
  const gap7 = respawnAfterExit(runnerLive, exitsBefore7 + 1)
  console.log(`      the ledger: exit ${gap7?.exit.outcome ?? '?'} → the respawn row ${gap7?.gapMs ?? '?'} ms later (the ladder's second rung)`)
  check("C2b the ledger's exit row reads crash-respawn, and its respawn row came after the switch was sent (the switch rode the armed respawn)", gap7 !== null && gap7.exit.outcome === 'crash-respawn' && gap7.exit.signal === 'SIGKILL' && ms(gap7.spawn.ts) >= switchAt7, gap7 === null ? JSON.stringify(exitRowsOf(runnerLive)) : JSON.stringify({ exit: gap7.exit.ts, spawn: gap7.spawn.ts, switchAt: new Date(switchAt7).toISOString() }))
  check('the facts read idle once the runner is back', await untilAsync(() => readFacts(sid)?.busy === false, 10_000), JSON.stringify(readFacts(sid)))
  const before7 = mainHits().length
  const after = await say('hello after the loop', sid)
  check('the next ask was delivered to the respawned runner', after.ok === true, JSON.stringify(after))
  check('the next turn ended', await untilAsync(() => sinceHits(before7).length > 0 && turnEnded(sid), 90_000), JSON.stringify({ hits: sinceHits(before7), rec: readRec(sid), facts: readFacts(sid) }))
  check('C2b the next call rode the Anthropic wire on the Fable row', sinceHits(before7).some(h => h.kind === 'anthropic' && h.model === 'claude-fable-5-1' && h.status === 200), JSON.stringify(sinceHits(before7)))
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-cap-seat: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

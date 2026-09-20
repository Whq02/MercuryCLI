#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOGUE_WORDS,
  DELEGATE_GPT_ASK,
  DELEGATE_GPT_SHORT_SPEND_ASK,
  DELEGATE_GPT_SPEND_ASK,
  MAIN_MODEL,
  MODELS_FAIL_FLAG,
  REFUSAL_HEAD,
  RESET_SHORT_SECONDS,
  SHORT_SPEND_ASK,
  SPEND_ASK,
  SUBAGENT_ASK,
  SUBAGENT_REPLY,
  WINDOW_WORDS,
} from './openai-lane-fixture-words.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-openai-lane-after-relogin: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'openai-lane-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# openai lane fixture\n')
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
  'MERCURY_DAEMON_NO_SELF_WARM',
  'MERCURY_WARM_RUNNER',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
]) {
  delete process.env[k]
}

const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { recordSignIn, noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.ts')
const owned = await import('../../src/daemon/ownedDaemon.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const reapTargets: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = []
const reapNow = (): void => {
  for (const p of reapTargets) {
    try {
      p.kill('SIGKILL')
    } catch {}
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-openai-lane-after-relogin exceeded 540s')
  reapNow()
  process.exit(1)
}, 540_000)
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
    } catch {}
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

const authFile = join(home, '.openai-auth.json')
type Account = { tail: string; email: string }
const ACCOUNTS: Record<'a' | 'b' | 'c', Account> = {
  a: { tail: 'aaaa', email: 'ana@example.com' },
  b: { tail: 'bbbb', email: 'bea@example.com' },
  c: { tail: 'cccc', email: 'cai@example.com' },
}
function landOpenaiSignIn(account: Account): void {
  const now = Date.now()
  writeFileSync(
    authFile,
    JSON.stringify(
      {
        version: 1,
        tokens: {
          idToken: `fixture-id-${account.tail}`,
          accessToken: `fixture-access-${account.tail}`,
          refreshToken: `fixture-refresh-${account.tail}-${now.toString(36)}`,
          accountId: `acct-fixture-${account.tail}`,
          planType: 'plus',
          email: account.email,
          accessTokenExpiresAtMs: now + 86_400_000,
        },
        lastRefreshMs: now,
        preferredSource: 'chatgpt-subscription',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  chmodSync(authFile, 0o600)
  noteCredentialChange()
  recordSignIn('openai', 'subscription')
}

type Rec = { runnerId: string; sessionId: string; workspaceId: string; pid?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number; endedAt?: number }
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}
type Facts = { busy?: boolean; identity?: { accountEmail?: string | null }; usage?: { openaiObserved?: unknown; limitWarning?: unknown } }
const factsPath = (sid: string): string => join(daemonDir, 'session-facts', `${sid}.json`)
const readFacts = (sid: string): Facts | undefined => {
  try {
    return JSON.parse(readFileSync(factsPath(sid), 'utf8')) as Facts
  } catch {
    return undefined
  }
}
type Capture = { kind: string; arm?: string; ask?: string; model?: string; status?: number | string; token?: string; result?: string; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const since = (n: number): Capture[] => wire().slice(n)
const brief = (cs: Capture[]): string => JSON.stringify(cs.map(c => [c.kind, c.arm ?? '', c.token ?? '', c.status ?? '']))
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
const transcriptLines = (sid: string): string[] => {
  const rec = readRec(sid)
  const file = join(paths.getProjectDir(rec?.workspaceId ?? work), `${sid}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
}
const rowsSince = (sid: string, n: number): string => transcriptLines(sid).slice(n).join('\n')
const unescaped = (raw: string): string => raw.replace(/\\u2014/g, '—').replace(/\\n/g, '\n').replace(/\\"/g, '"')
const refusalOf = (rows: string): string => unescaped(rows).match(/Agent dispatch refused[^"\\]{0,400}/)?.[0] ?? '(no refusal words)'
const bracketOf = (refusal: string): string => refusal.match(/\(([^)]*)\)/)?.[1] ?? ''

const modelsFailFlag = join(SCRATCH, MODELS_FAIL_FLAG)
const fixture = spawn('node', [join(REPO, 'scripts', 'daemon', 'openai-lane-fixture-server.ts'), captureFile, modelsFailFlag], { stdio: ['ignore', 'pipe', 'pipe'] })
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

landOpenaiSignIn(ACCOUNTS.a)

const logFd = openSync(daemonLogPath, 'a')
const daemon: ChildProcess = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: base,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/chatgpt`,
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:1',
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
const records: Record<string, string> = {}
const keep = (name: string, text: string): void => {
  records[name] = text
}
const exportRecords = (sid: string): void => {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  for (const [name, text] of Object.entries(records)) writeFileSync(join(FRAMES, name), text)
  writeFileSync(join(FRAMES, 'wire.jsonl'), readFileSync(captureFile, 'utf8'))
  writeFileSync(join(FRAMES, 'daemon.log'), daemonLog())
  if (sid !== '') writeFileSync(join(FRAMES, 'transcript.jsonl'), transcriptLines(sid).join('\n') + '\n')
  console.log(`  [records] written under ${FRAMES}`)
}
const cleanup = async (sid: string): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 })
  } catch {}
  await sleep(500)
  exportRecords(sid)
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const say = async (prompt: string, target?: string, model?: string): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  (await daemonControlRpc(
    {
      op: 'sessionDispatch',
      clientMessageId: `lane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      workspaceDir: work,
      ...(target !== undefined ? { targetSessionId: target } : { title: 'OpenAI lane' }),
      ...(model !== undefined ? { model } : {}),
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; error?: string }
type Outcome = { ok?: boolean; outcome?: string; detail?: string; error?: string }
const control = async (action: string, sessionId: string, extra: Record<string, unknown> = {}): Promise<Outcome> =>
  (await daemonControlRpc({ op: 'sessionControl', action, sessionId, by: 'operator', ...extra } as never, { timeoutMs: 30_000 })) as Outcome
const turnEnded = (sid: string): boolean => {
  const rec = readRec(sid)
  const facts = readFacts(sid)
  return rec !== undefined && (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) && facts?.busy === false
}

const pokes: Array<Promise<unknown>> = []
const pokeRequests: Array<Record<string, unknown>> = []
owned.armDaemonSignInPoke({
  rpc: (req, o) => {
    pokeRequests.push(req as unknown as Record<string, unknown>)
    const flight = daemonControlRpc(req as never, o)
    pokes.push(flight.catch(() => undefined))
    return flight
  },
})
const pokesSettled = async (): Promise<void> => {
  await Promise.all(pokes)
  await sleep(300)
}

type Errand = { refused: boolean; proceeded: boolean; refusal: string; hits: Capture[]; rows: string }
async function errand(sid: string, ask: string, label: string, walled = false): Promise<Errand> {
  const wireBefore = wire().length
  const rowsBefore = transcriptLines(sid).length
  const sent = await say(ask, sid)
  check(`${label}: the ask was delivered`, sent.ok === true, JSON.stringify(sent))
  const settled = (): boolean =>
    walled
      ? since(wireBefore).some(h => h.kind === 'openai' && h.status === 429) && since(wireBefore).some(h => h.kind === 'anthropic' && h.arm === 'report')
      : rowsSince(sid, rowsBefore).includes(REFUSAL_HEAD) || rowsSince(sid, rowsBefore).includes(SUBAGENT_REPLY)
  await untilAsync(() => turnEnded(sid) && settled(), 90_000)
  await sleep(400)
  const rows = rowsSince(sid, rowsBefore)
  const refused = rows.includes(REFUSAL_HEAD)
  const proceeded = rows.includes(SUBAGENT_REPLY) && since(wireBefore).some(h => h.kind === 'openai' && h.arm === 'delegate' && h.status === 200)
  return { refused, proceeded, refusal: refused ? refusalOf(rows) : '', hits: since(wireBefore), rows }
}

console.log('the OpenAI lane after a reset and a re-login — the real daemon and runner from the bundle, both wires at the fixture')
console.log(`  bundle ${DIST}\n  home ${home}\n  fixture ${base}`)

let sid = ''
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§1 a hosted session on the Anthropic main model, signed in to OpenAI as account A')
  const born = await say('hello there', undefined, MAIN_MODEL)
  check('the session dispatched onto a real runner', born.ok === true && typeof born.sessionId === 'string', JSON.stringify(born))
  sid = born.sessionId ?? ''
  check('the first turn ended', await untilAsync(() => turnEnded(sid), 90_000), JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  const granted = await control('grant-workflows', sid)
  check('the session holds the workflows-allowed tag', granted.ok === true, JSON.stringify(granted))

  section('§2 a reached window lapses at the reset it names (a short window observed on the GPT row)')
  const shortSpend = await errand(sid, DELEGATE_GPT_SHORT_SPEND_ASK, 'the short spend', true)
  check('the delegate rode the OpenAI wire under A and was walled with a short reset', shortSpend.hits.some(h => h.kind === 'openai' && h.arm === 'short-spend' && h.status === 429 && h.token === ACCOUNTS.a.tail), brief(shortSpend.hits))
  const atOnce = await errand(sid, DELEGATE_GPT_ASK, 'the errand at once')
  check('the next delegated errand is refused while the reset is ahead', atOnce.refused && atOnce.refusal.includes(WINDOW_WORDS), atOnce.refusal || brief(atOnce.hits))
  check('…and no request was made for it', !atOnce.hits.some(h => h.kind === 'openai' && (h.ask ?? '').includes(SUBAGENT_ASK)), brief(atOnce.hits))
  console.log(`      refusal: ${atOnce.refusal}`)
  await sleep((RESET_SHORT_SECONDS + 3) * 1000)
  const lapsed = await errand(sid, DELEGATE_GPT_ASK, 'the errand after the reset')
  check('after the reset it names the delegate proceeds and is answered under A', lapsed.proceeded && lapsed.hits.some(h => h.kind === 'openai' && h.arm === 'delegate' && h.token === ACCOUNTS.a.tail), lapsed.refusal || brief(lapsed.hits))

  section('§3 a long window is reached on the GPT row; the next delegated errand is refused, naming the window')
  const spend = await errand(sid, DELEGATE_GPT_SPEND_ASK, 'the spend', true)
  check('the delegate rode the OpenAI wire under A and was walled with a long reset', spend.hits.some(h => h.kind === 'openai' && h.arm === 'spend' && h.status === 429 && h.token === ACCOUNTS.a.tail), brief(spend.hits))
  await sleep(1_000)
  keep('facts-after-wall.json', readFileSync(factsPath(sid), 'utf8'))
  const walled = await errand(sid, DELEGATE_GPT_ASK, 'the errand under the wall')
  check('the dispatch is refused before any request, naming the window', walled.refused && walled.refusal.includes(WINDOW_WORDS) && !walled.hits.some(h => h.kind === 'openai' && (h.ask ?? '').includes(SUBAGENT_ASK)), walled.refusal || brief(walled.hits))
  check('the bracket names the window alone (the catalogue was read by the request that observed the wall)', walled.refused && !bracketOf(walled.refusal).includes(CATALOGUE_WORDS), bracketOf(walled.refusal))
  console.log(`      refusal: ${walled.refusal}`)
  keep('refusal-under-wall.txt', `${walled.refusal}\n`)

  section('§4 the operator signs in to OpenAI again (account B): the poke rides the road every sign-in raises, the daemon tells the runner')
  const pokesBefore = pokeRequests.length
  const logBefore = daemonLog().length
  const wireBeforeRelogin = wire().length
  landOpenaiSignIn(ACCOUNTS.b)
  await pokesSettled()
  check("the sign-in raised the screen's poke (signIns with refresh)", pokeRequests.slice(pokesBefore).some(r => r.op === 'signIns' && r.refresh === true), JSON.stringify(pokeRequests.slice(pokesBefore)))
  const catalogueReadForB = await untilAsync(() => since(wireBeforeRelogin).some(h => h.kind === 'models' && h.token === ACCOUNTS.b.tail), 10_000)
  check("the daemon's word reached the runner: it read the catalogue under B on the poke, before any errand (its memo follows the credential)", catalogueReadForB, brief(since(wireBeforeRelogin)))
  console.log(`      daemon: ${daemonLog().slice(logBefore).split('\n').filter(l => l.includes('credential moved')).join(' | ') || '(the relay line is a debug-only log; the wire above is the evidence)'}`)
  await sleep(2_000)
  keep('facts-after-relogin.json', readFileSync(factsPath(sid), 'utf8'))

  section('§5 the next delegated errand after the re-login — the defect as the owner met it')
  const after = await errand(sid, DELEGATE_GPT_ASK, 'the errand after the re-login')
  if (after.refused) console.log(`      refusal: ${after.refusal}`)
  keep('refusal-after-relogin.txt', `${after.refused ? after.refusal : '(not refused)'}\n`)
  check('the dispatch is not refused: the wall observed under A does not outlive A', !after.refused, after.refusal)
  check("the delegate's request rode the OpenAI wire under B and was answered", after.proceeded && after.hits.some(h => h.kind === 'openai' && h.arm === 'delegate' && h.token === ACCOUNTS.b.tail && h.status === 200), brief(after.hits))
  check("the transcript carries the delegate's reply, not the pending-catalogue words", after.rows.includes(SUBAGENT_REPLY) && !after.rows.includes('live catalogue not fetched yet'), unescaped(after.rows).match(/the delegate reported:[^"\\]{0,200}/)?.[0] ?? '(no report)')
  await sleep(1_000)
  keep('facts-after-dispatch.json', readFileSync(factsPath(sid), 'utf8'))

  section('§6 the refusal names the blocker that blocks: a wall with the catalogue unreachable is refused for the window alone')
  writeFileSync(modelsFailFlag, 'down\n')
  const wireBeforeC = wire().length
  landOpenaiSignIn(ACCOUNTS.c)
  await pokesSettled()
  await untilAsync(() => since(wireBeforeC).some(h => h.kind === 'models' && h.token === ACCOUNTS.c.tail), 8_000)
  const spendC = await errand(sid, DELEGATE_GPT_SPEND_ASK, 'the spend under C', true)
  check('the delegate rode the OpenAI wire under C and was walled (the request goes out without a catalogue)', spendC.hits.some(h => h.kind === 'openai' && h.arm === 'spend' && h.status === 429 && h.token === ACCOUNTS.c.tail), brief(spendC.hits))
  const walledC = await errand(sid, DELEGATE_GPT_ASK, 'the errand under the wall with the catalogue down')
  check('the dispatch is refused for the window', walledC.refused && walledC.refusal.includes(WINDOW_WORDS), walledC.refusal || brief(walledC.hits))
  check('the bracket carries the window, never the catalogue state as if it were the block', walledC.refused && !bracketOf(walledC.refusal).includes(CATALOGUE_WORDS), bracketOf(walledC.refusal))
  console.log(`      refusal: ${walledC.refusal}`)
  keep('refusal-catalogue-down.txt', `${walledC.refusal}\n`)
  try {
    unlinkSync(modelsFailFlag)
  } catch {}
} finally {
  await cleanup(sid)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-openai-lane-after-relogin: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

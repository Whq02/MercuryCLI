#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = process.argv[2] ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle as the first argument`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-credential-change-reaches-runner: the drive holds the daemon on a POSIX owner pipe — nothing to drive on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'credchange-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# credential change fixture\n')
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
]) {
  delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn, noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.ts')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
const { getSecureStorage } = await import('../../src/utils/secureStorage/index.ts')
const owned = await import('../../src/daemon/ownedDaemon.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const words = await import('./delegate-fixture-words.ts')
const { DELEGATE_ASK, DELEGATE_SPEND_ASK, DELEGATE_REPORT, GPT_ID, SPEND_ASK, SUBAGENT_ASK, SUBAGENT_REPLY, DELEGATE_MODEL } = words

const reapTargets: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = []
const reapNow = (): void => {
  for (const p of reapTargets) {
    try {
      p.kill('SIGKILL')
    } catch {}
  }
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-credential-change-reaches-runner exceeded 330s')
  reapNow()
  process.exit(1)
}, 330_000)
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

const ACCOUNTS = {
  a: { uuid: '00000000-0000-4000-8000-0000000000aa', email: 'ana@example.com' },
  b: { uuid: '00000000-0000-4000-8000-0000000000bb', email: 'bea@example.com' },
  c: { uuid: '00000000-0000-4000-8000-0000000000cc', email: 'cai@example.com' },
} as const
function landSignIn(account: { uuid: string; email: string }): void {
  storeOAuthAccountInfo({ accountUuid: account.uuid, emailAddress: account.email })
  const saved = auth.saveOAuthTokensIfNeeded({
    accessToken: `fixture-access-${account.uuid.slice(-2)}`,
    refreshToken: `fixture-refresh-${account.uuid.slice(-2)}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  })
  if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
  auth.clearOAuthTokenCache()
  recordSignIn('anthropic', 'oauth')
}
function landSignOut(): void {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  const { claudeAiOauth: _gone, ...rest } = current as Record<string, unknown> & { claudeAiOauth?: unknown }
  storage.update(rest as never)
  auth.clearOAuthTokenCache()
  saveGlobalConfig(config => ({ ...config, oauthAccount: undefined }))
  noteCredentialChange()
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
const readFacts = (sid: string): { busy?: boolean; identity?: { accountEmail?: string | null } } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as ReturnType<typeof readFacts>
  } catch {
    return undefined
  }
}
type Capture = { kind: string; arm?: string; ask?: string; model?: string; status?: number | string; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const hits = (): Capture[] => wire().filter(c => c.kind === 'anthropic' || c.kind === 'openai')
const sinceHits = (n: number): Capture[] => hits().slice(n)
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

const fixture = spawn('node', [join(REPO, 'scripts', 'daemon', 'delegate-fixture-server.ts'), captureFile, '0', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
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

landSignIn(ACCOUNTS.a)

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
    MERCURY_DAEMON_OWNER_FD: '3',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
  },
  stdio: ['ignore', logFd, logFd, 'pipe'],
})
reapTargets.push(daemon)
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 })
  } catch {}
  await sleep(500)
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
      clientMessageId: `cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      workspaceDir: work,
      ...(target !== undefined ? { targetSessionId: target } : { title: 'Credential change' }),
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

console.log('a sign-in reaches the engines behind the open chats — the real daemon and runner from the bundle, two wires at the fixture')
console.log(`  bundle ${DIST}\n  home ${home}\n  fixture ${base}`)

let sid = ''
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  section('§1 a hosted session whose main model is on the OpenAI route')
  const born = await say('hello there', undefined, GPT_ID)
  check('the session dispatched onto a real runner on the GPT row', born.ok === true && typeof born.sessionId === 'string', JSON.stringify(born))
  sid = born.sessionId ?? ''
  check('the first turn ended', await untilAsync(() => turnEnded(sid), 90_000), JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  check('the ask rode the OpenAI wire', hits().some(h => h.kind === 'openai' && h.model === GPT_ID && h.status === 200), JSON.stringify(hits()))
  check("the runner's facts name account A", await untilAsync(() => readFacts(sid)?.identity?.accountEmail === ACCOUNTS.a.email, 60_000), JSON.stringify(readFacts(sid)?.identity))
  const granted = await control('grant-workflows', sid)
  check('the session holds the workflows-allowed tag (a backgrounded seat may delegate only with it or with a live operator)', granted.ok === true, JSON.stringify(granted))

  section('§2 a delegated agent on the Anthropic route spends the window under account A; the next dispatch is refused, naming A and the moment')
  const before2 = hits().length
  const rows2 = transcriptLines(sid).length
  const spend = await say(DELEGATE_SPEND_ASK, sid)
  check('the ask that delegates the spend was delivered', spend.ok === true, JSON.stringify(spend))
  check('the delegate rode the Anthropic wire and was answered 429 with the unified headers', await untilAsync(() => sinceHits(before2).some(h => h.kind === 'anthropic' && h.status === 429 && (h.ask ?? '').includes(SPEND_ASK)), 90_000), JSON.stringify(sinceHits(before2)))
  check('the main turn ended', await untilAsync(() => turnEnded(sid), 60_000), JSON.stringify({ rec: readRec(sid), facts: readFacts(sid) }))
  await sleep(1_500)
  const before2b = hits().length
  const rows2b = transcriptLines(sid).length
  const refused = await say(DELEGATE_ASK, sid)
  check('the next delegated errand was delivered', refused.ok === true, JSON.stringify(refused))
  const sawRefusal = await untilAsync(() => rowsSince(sid, rows2b).includes('Agent dispatch refused') && turnEnded(sid), 90_000)
  const refusalRows = unescaped(rowsSince(sid, rows2b))
  check('the dispatch was refused before any request (the sighting)', sawRefusal && refusalRows.includes('usage window is reached'), refusalRows.slice(0, 600))
  check('no Anthropic request was made for the refused dispatch', !sinceHits(before2b).some(h => h.kind === 'anthropic' && (h.ask ?? '').includes(SUBAGENT_ASK)), JSON.stringify(sinceHits(before2b)))
  check('the refusal names the account the verdict belongs to', refusalRows.includes(`usage window is reached for ${ACCOUNTS.a.email}`), refusalRows.match(/usage window is reached[^"\\]{0,120}/)?.[0] ?? '(no window words)')
  check('the refusal names when the window was observed', /seen at \d\d:\d\d/.test(refusalRows), refusalRows.match(/usage window is reached[^"\\]{0,120}/)?.[0] ?? '(no window words)')
  console.log(`      refusal: ${refusalRows.match(/Agent dispatch refused[^"\\]{0,260}/)?.[0] ?? '(none)'}`)
  void rows2

  section('§3 account B signs in on the screen: the poke rides the road every sign-in raises, the daemon tells the runner')
  const pokesBefore = pokeRequests.length
  const logBefore = daemonLog().length
  landSignIn(ACCOUNTS.b)
  await pokesSettled()
  check("the sign-in raised the screen's poke (signIns with refresh)", pokeRequests.slice(pokesBefore).some(r => r.op === 'signIns' && r.refresh === true), JSON.stringify(pokeRequests.slice(pokesBefore)))
  const relayed = daemonLog().slice(logBefore)
  console.log(`      daemon: ${relayed.split('\n').filter(l => l.includes('credential moved')).join(' | ') || '(no relay line in the log)'}`)

  section('§4 the next delegated dispatch proceeds on the new account')
  const before4 = hits().length
  const rows4 = transcriptLines(sid).length
  const again = await say(DELEGATE_ASK, sid)
  check('the errand was delivered', again.ok === true, JSON.stringify(again))
  const proceeded = await untilAsync(() => sinceHits(before4).some(h => h.kind === 'anthropic' && h.status === 200 && (h.ask ?? '').includes(SUBAGENT_ASK)), 90_000)
  check('the delegate reached the Anthropic wire on the Opus row and was answered', proceeded && sinceHits(before4).some(h => h.kind === 'anthropic' && h.model === DELEGATE_MODEL), JSON.stringify(sinceHits(before4)))
  check("the transcript carries the delegate's reply, not a refusal", await untilAsync(() => rowsSince(sid, rows4).includes(SUBAGENT_REPLY) && turnEnded(sid), 90_000) && !rowsSince(sid, rows4).includes('usage window is reached'), unescaped(rowsSince(sid, rows4)).match(/the delegate reported:[^"\\]{0,200}/)?.[0] ?? '(no report)')
  check("the runner's facts name account B", await untilAsync(() => readFacts(sid)?.identity?.accountEmail === ACCOUNTS.b.email, 60_000), JSON.stringify(readFacts(sid)?.identity))

  section('§5 B spends its own window; the refusal now names B')
  const before5 = hits().length
  const spendB = await say(DELEGATE_SPEND_ASK, sid)
  check('the spend was delivered', spendB.ok === true, JSON.stringify(spendB))
  check('the Anthropic wire answered 429 under B', await untilAsync(() => sinceHits(before5).some(h => h.kind === 'anthropic' && h.status === 429), 90_000), JSON.stringify(sinceHits(before5)))
  check('the main turn ended', await untilAsync(() => turnEnded(sid), 60_000))
  await sleep(1_500)
  const rows5 = transcriptLines(sid).length
  await say(DELEGATE_ASK, sid)
  const refusedB = await untilAsync(() => rowsSince(sid, rows5).includes('Agent dispatch refused') && turnEnded(sid), 90_000)
  const refusalB = unescaped(rowsSince(sid, rows5))
  check("B's own observation refuses, naming B", refusedB && refusalB.includes(`usage window is reached for ${ACCOUNTS.b.email}`), refusalB.match(/usage window is reached[^"\\]{0,120}/)?.[0] ?? '(no window words)')

  section('§6 a sign-out clears it the same way; a later sign-in is read by the runner')
  const pokesBefore6 = pokeRequests.length
  landSignOut()
  await pokesSettled()
  check("the sign-out raised the screen's poke", pokeRequests.slice(pokesBefore6).some(r => r.op === 'signIns' && r.refresh === true), JSON.stringify(pokeRequests.slice(pokesBefore6)))
  const rows6 = transcriptLines(sid).length
  await say(DELEGATE_ASK, sid)
  check('after the sign-out the dispatch is no longer refused for the window', await untilAsync(() => turnEnded(sid) && rowsSince(sid, rows6).includes(DELEGATE_REPORT), 90_000) && !rowsSince(sid, rows6).includes('usage window is reached'), unescaped(rowsSince(sid, rows6)).match(/the delegate reported:[^"\\]{0,200}/)?.[0] ?? '(no report)')
  const pokesBefore7 = pokeRequests.length
  landSignIn(ACCOUNTS.c)
  await pokesSettled()
  check("the sign-in raised the screen's poke", pokeRequests.slice(pokesBefore7).some(r => r.op === 'signIns' && r.refresh === true))
  const before7 = hits().length
  const rows7 = transcriptLines(sid).length
  await say(DELEGATE_ASK, sid)
  check('the delegate proceeds on account C and is answered on the wire', await untilAsync(() => sinceHits(before7).some(h => h.kind === 'anthropic' && h.status === 200 && (h.ask ?? '').includes(SUBAGENT_ASK)) && rowsSince(sid, rows7).includes(SUBAGENT_REPLY) && turnEnded(sid), 90_000), JSON.stringify(sinceHits(before7)))
  check("the runner's facts name account C", await untilAsync(() => readFacts(sid)?.identity?.accountEmail === ACCOUNTS.c.email, 60_000), JSON.stringify(readFacts(sid)?.identity))
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-credential-change-reaches-runner: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

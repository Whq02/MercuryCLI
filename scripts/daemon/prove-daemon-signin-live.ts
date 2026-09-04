#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-signin-live-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of [
  'MERCURY_HOME',
  'CI',
  'NODE_ENV',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_DAEMON_NO_SELF_WARM',
  'MERCURY_WARM_RUNNER',
  'MERCURY_CONCOURSE_WORKER',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[k]
}

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const FIXTURE_PORT = 23000 + (process.pid % 2000)
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
const { screenBirthModel } = await import('../../src/services/switchboard/bootBirthFacts.ts')
const owned = await import('../../src/daemon/ownedDaemon.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — daemon-signin-live exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(250)
  }
}

type AdmitReply = { ok: true; runnerId: string; sessionId: string; modelId?: string; modelDisplayName?: string; note?: string } | { ok: false; code?: string; error?: string }
const admit = async (model: string | undefined): Promise<AdmitReply> =>
  (await daemonControlRpc(
    { op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', ...(model !== undefined ? { model } : {}), bornBlank: true } as never,
    { timeoutMs: 30_000 },
  )) as AdmitReply
const release = async (runnerId: string): Promise<void> => {
  await daemonControlRpc({ op: 'sessionRelease', runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
}
const refusalOf = (r: AdmitReply): string => (r.ok ? '(admitted)' : (r.error ?? r.code ?? '(no text)'))

type SignInsReply =
  | { ok: true; op: 'signIns'; view: { home: string; store: string; refreshed: boolean; families: Array<{ family: string; credentialed: boolean; usable: boolean; row?: string; why?: string }> } }
  | { ok: false; code?: string; error?: string }
const signIns = async (refresh?: true): Promise<SignInsReply> =>
  (await daemonControlRpc({ op: 'signIns', ...(refresh ? { refresh: true } : {}) } as never, { timeoutMs: 10_000 })) as SignInsReply

const daemonEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  ...fixture.env,
  ...extra,
})
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()
const logPath = join(SCRATCH, 'daemon.log')
function bootDaemon(extra: Record<string, string>): void {
  const logFd = openSync(logPath, 'a')
  const env = daemonEnv(extra)
  delete env.ANTHROPIC_API_KEY
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  const child = daemon
  daemonExit = new Promise<void>(r => child.once('exit', () => r()))
}
async function stopDaemon(): Promise<void> {
  if (daemon === null) return
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => undefined)
  const gone = await Promise.race([daemonExit.then(() => true), wait(15_000).then(() => false)])
  if (!gone) {
    try {
      daemon.kill('SIGKILL')
    } catch {
    }
  }
  daemon = null
}
const daemonLogTail = (n = 30): string => {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').slice(-n).join('\n')
  } catch {
    return '(no daemon.log)'
  }
}
const daemonLogLines = (needle: string): string[] => {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(l => l.includes(needle))
  } catch {
    return []
  }
}

function landAnthropicSignIn(expiresAt: number): void {
  storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-00000000c0de', emailAddress: 'sam@example.com' })
  const saved = auth.saveOAuthTokensIfNeeded({
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    expiresAt,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  })
  if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
  auth.clearOAuthTokenCache()
  recordSignIn('anthropic', 'oauth')
}

console.log('daemon sign-in view — live at every admission · the poke · the refusal names its read')
console.log(`  home ${home}\n  store file (${join(home, '.credentials.json')})\n  fixture ${fixture.base}`)

let clientModel: string | undefined
try {
  section('§1 the sighting: OpenAI at boot, the Anthropic sign-in lands later, the admit must follow it')
  bootDaemon({})
  check('the supervisor answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  let openaiRunner: string | null = null
  const openaiUsable = await untilAsync(async () => {
    const r = await admit('openai')
    if (r.ok) {
      openaiRunner = r.runnerId
      return true
    }
    return false
  }, 40_000)
  check('CONTROL: the family signed in at boot (OpenAI, the fixture catalogue) admits', openaiUsable)
  if (openaiRunner !== null) await release(openaiRunner)

  const before = await admit('anthropic')
  check('CONTROL: before the sign-in the Anthropic family word refuses no-credential:anthropic', !before.ok && /no-credential:anthropic/.test(refusalOf(before)), refusalOf(before))
  check('…and the refusal names the OTHER signed-in family as the way out', /OpenAI is signed in/.test(refusalOf(before)), refusalOf(before))
  console.log(`  before-sign-in refusal: ${refusalOf(before)}`)

  const pokes: Array<{ op: string; refresh?: boolean }> = []
  owned.armDaemonSignInPoke({
    rpc: async (req, o) => {
      pokes.push(req)
      return daemonControlRpc(req as never, o)
    },
  })
  landAnthropicSignIn(Date.now() + 3_600_000)
  check('the sign-in landing pokes the daemon (signIns with refresh) through the ledger epoch', pokes.length === 1 && pokes[0]?.op === 'signIns' && pokes[0]?.refresh === true, JSON.stringify(pokes))
  clientModel = screenBirthModel()
  check('the client now computes a Claude birth model (the screen would send it)', clientModel !== undefined && /claude/.test(clientModel ?? ''), String(clientModel))
  console.log(`  the screen's birth model after the sign-in: ${clientModel}`)

  const named = await admit(clientModel)
  check('THE FIX: the id the screen sends is ADMITTED without a daemon restart', named.ok, refusalOf(named))
  console.log(`  admit(${clientModel}): ${named.ok ? `admitted ${named.modelId ?? ''} ${named.modelDisplayName ?? ''}` : refusalOf(named)}`)
  if (named.ok) await release(named.runnerId)
  const word = await admit('anthropic')
  check('THE FIX: the Anthropic family word is ADMITTED after the sign-in', word.ok, refusalOf(word))
  console.log(`  admit(anthropic): ${word.ok ? `admitted ${word.modelId ?? ''}` : refusalOf(word)}`)
  if (word.ok) await release(word.runnerId)
  const unnamed = await admit(undefined)
  check('an unnamed launch lands on the most recent sign-in (Anthropic) — never keyless, never the older family', unnamed.ok && /claude/.test(unnamed.modelId ?? ''), unnamed.ok ? `${unnamed.modelId} ${unnamed.note ?? ''}` : refusalOf(unnamed))
  if (unnamed.ok) await release(unnamed.runnerId)

  section('§2 the verb: signIns answers the live view; refresh drops the caches')
  const view = await signIns()
  check('signIns answers ok', view.ok, view.ok ? '' : `${view.code ?? ''} ${view.error ?? ''}`)
  if (view.ok) {
    const fam = (id: string) => view.view.families.find(f => f.family === id)
    check('the view names the home the daemon read', view.view.home === home || view.view.home.endsWith(home.slice(home.indexOf('/daemon-signin-live-'))), view.view.home)
    check('the view names the file-backed store', view.view.store === 'plaintext', view.view.store)
    check('anthropic: credentialed and usable, with a Claude row', fam('anthropic')?.credentialed === true && fam('anthropic')?.usable === true && /claude|fable|opus|sonnet/i.test(fam('anthropic')?.row ?? ''), JSON.stringify(fam('anthropic')))
    check('openai: credentialed and usable (the fixture catalogue)', fam('openai')?.credentialed === true && fam('openai')?.usable === true, JSON.stringify(fam('openai')))
    check('a family with no credential is listed as such, never dropped', fam('gemini')?.credentialed === false, JSON.stringify(fam('gemini')))
    check('the plain read is not a refresh', view.view.refreshed === false)
  }
  const poked = await signIns(true)
  check('signIns with refresh answers ok and says it refreshed', poked.ok && poked.view.refreshed === true, poked.ok ? JSON.stringify(poked.view.refreshed) : `${poked.code ?? ''} ${poked.error ?? ''}`)

  section('§3a the refusal names what it read (no credential)')
  const gemini = await admit('gemini')
  const geminiText = refusalOf(gemini)
  check('a family with no credential still refuses no-credential:<family>', !gemini.ok && /no-credential:gemini/.test(geminiText), geminiText)
  check('the refusal names the home the daemon read', geminiText.includes(home), geminiText)
  check('the refusal names the credential store the daemon read', /store: plaintext|plaintext store|the plaintext credential store/.test(geminiText), geminiText)
  console.log(`  gemini refusal: ${geminiText}`)
  const logged = daemonLogLines('admission refused')
  check('the daemon log records the refusal with its read', logged.some(l => /no-credential:gemini/.test(l) && l.includes(home)), logged.slice(-2).join(' | ') || '(no such line)')

  section('§4 an expired token with a refresh token counts as signed in')
  landAnthropicSignIn(Date.now() - 3_600_000)
  const expired = await admit(clientModel)
  check('an EXPIRED-but-refreshable Anthropic token ADMITS (the runner refreshes at first use)', expired.ok, refusalOf(expired))
  console.log(`  admit(${clientModel}) with the expired token: ${expired.ok ? 'admitted' : refusalOf(expired)}`)
  if (expired.ok) await release(expired.runnerId)
  check('the presence owner reads the refreshable expiry as present and not stranded', (() => {
    auth.clearOAuthTokenCache()
    return auth.isAnthropicOAuthSignInExpired() === false && auth.hasStoredOAuthToken()
  })())
  await stopDaemon()

  section('§3b credential present, no usable row: the refusal says so (a catalogue fix, not a sign-in)')
  rmSync(join(home, '.credentials.json'), { force: true })
  rmSync(join(home, '.sign-ins.json'), { force: true })
  bootDaemon({ MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:9/openai/v1' })
  check('the second supervisor answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const dark = await admit('openai')
  const darkText = refusalOf(dark)
  check('the OpenAI family word refuses (its catalogue never landed)', !dark.ok && /no-credential:openai/.test(darkText), darkText)
  check('…and the text says a credential IS present but no usable row', /credential is present/.test(darkText) && /no usable row/.test(darkText), darkText)
  console.log(`  dark-catalogue refusal: ${darkText}`)
  await stopDaemon()
} catch (error) {
  failures++
  console.log(`  [FAIL] the drive threw — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  await stopDaemon()
  await fixture.close()
}

if (failures > 0) {
  console.log('\n── daemon.log (tail) ──')
  console.log(daemonLogTail(40))
}
console.log('\n' + '═'.repeat(76))
if (failures === 0) {
  console.log('✅ ALL DAEMON SIGN-IN-LIVE PROOFS PASS')
  rmSync(SCRATCH, { recursive: true, force: true })
} else {
  console.log(`❌ ${failures} DAEMON SIGN-IN-LIVE PROOF(S) FAILED — scratch kept at ${SCRATCH}`)
}
console.log('═'.repeat(76))
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)

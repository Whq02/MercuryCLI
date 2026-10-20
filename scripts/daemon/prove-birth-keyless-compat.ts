#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = process.argv[2] ? resolve(process.argv[2]) : join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or pass a bundle path as argv[2]`)
  process.exit(1)
}

const PARENT_TMP = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(PARENT_TMP, { recursive: true })
const SCRATCH = mkdtempSync(join(PARENT_TMP, 'birth-keyless-compat-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
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
  'MERCURY_MODEL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MODEL_API_KEY',
  'MISTRAL_API_KEY',
  'NOUS_API_KEY',
  'OPENCODE_API_KEY',
  'MINIMAX_API_KEY',
  'TOGETHER_API_KEY',
  'COHERE_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'FIREWORKS_API_KEY',
  'DASHSCOPE_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_MODELS',
  'MERCURY_COMPAT_LABEL',
  'MERCURY_LOCAL_BASE_URL',
]) {
  delete process.env[k]
}
for (const k of Object.keys(process.env)) {
  if (/^MERCURY_COMPAT_.*_API_KEY$/.test(k)) delete process.env[k]
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({
  ...c,
  switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 6 },
}))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { screenBirthModel } = await import('../../src/services/switchboard/bootBirthFacts.ts')
const { dropCredentialMemos } = await import('../../src/utils/auth.ts')
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')

const ENDPOINT_NAME = 'llmhost'
const WIRE_MODEL = 'unsloth/GLM-5.3-Flash-GGUF:UD-Q4_K_XL'
const FULL_MODEL = `compat/${ENDPOINT_NAME}/${WIRE_MODEL}`
const FIXTURE_REPLY = 'KEYLESS-COMPAT-BIRTH-ANSWER'

const captures: Array<{ path: string; model?: string; auth: string | null }> = []
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/v1/models') {
      return Response.json({ data: [{ id: WIRE_MODEL, owned_by: 'llamacpp' }] })
    }
    if (path === '/props') {
      return Response.json({ default_generation_settings: { n_ctx: 131_072 }, total_slots: 1 })
    }
    if (path === '/v1/chat/completions') {
      const body = (await req.json()) as { model?: string }
      captures.push({ path, model: body.model, auth: req.headers.get('authorization') })
      const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
        sse({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
      const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } }
      const payload = chunk({ content: FIXTURE_REPLY }) + chunk({}, 'stop', usage) + 'data: [DONE]\n\n'
      return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
const baseUrl = `http://127.0.0.1:${server.port}/v1`

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-birth-keyless-compat exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      if (await cond()) return true
    } catch {}
    if (Date.now() > deadline) return false
    await wait(200)
  }
}

const logPath = join(SCRATCH, 'daemon.log')
let daemon: ChildProcess | null = null
let daemonExit: Promise<void> = Promise.resolve()

function bootDaemon(): void {
  const logFd = openSync(logPath, 'a')
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
  const child = daemon
  daemonExit = new Promise<void>(r => child.once('exit', () => r()))
}

async function stopDaemon(): Promise<void> {
  if (daemon === null) return
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5_000 }).catch(() => undefined)
  const gone = await Promise.race([daemonExit.then(() => true), wait(10_000).then(() => false)])
  if (!gone) {
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  daemon = null
}

type WorkerRec = {
  runnerId: string
  sessionId: string
  workspaceId: string
  modelKey?: string
  keyless?: boolean
  pid?: number
  parkedAt?: number
  endedAt?: number
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
}
const readWorkerRec = (sid: string): WorkerRec | undefined => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, WorkerRec> }
    return Object.values(raw.workers).find(w => w.sessionId === sid && w.endedAt === undefined)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const turnSettled = (sid: string): boolean => {
  const rec = readWorkerRec(sid)
  const facts = readFacts(sid)
  return rec !== undefined && (rec.lastTurnSettledAt ?? 0) >= (rec.lastDeliveryAt ?? 1) && facts?.busy === false
}
const transcriptText = (sid: string): string => {
  const file = join(getProjectDir(work), `${sid}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

type AdmitReply =
  | { ok: true; runnerId: string; sessionId: string; modelId?: string; modelDisplayName?: string }
  | { ok: false; code?: string; error?: string }

const admitSession = async (opts: { model?: string; vacatingSessionId?: string } = {}): Promise<AdmitReply> =>
  (await daemonControlRpc(
    {
      op: 'sessionAdmit',
      workspaceDir: work,
      isolation: 'shared',
      by: 'operator',
      bornBlank: true,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.vacatingSessionId !== undefined ? { vacatingSessionId: opts.vacatingSessionId } : {}),
    } as never,
    { timeoutMs: 30_000 },
  )) as AdmitReply

const dispatchTurn = async (sessionId: string, prompt: string): Promise<{ ok?: boolean; error?: string }> =>
  (await daemonControlRpc(
    {
      op: 'sessionDispatch',
      clientMessageId: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      workspaceDir: work,
      targetSessionId: sessionId,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; error?: string }

const writeUserSettings = (settings: Record<string, unknown>): void => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  resetSettingsCache()
}

console.log('============================================================')
console.log(' prove-birth-keyless-compat — keyless named compat birth & /clear')
console.log(`  bundle ${DIST}`)
console.log(`  home   ${home}`)
console.log(`  server ${baseUrl}`)
console.log('============================================================')

try {
  bootDaemon()
  check('daemon boots and answers ping', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  const preAdmit = await admitSession({ model: 'compat/legacy-model' })
  check(
    'control before registration: unconfigured compat model is refused with no-credential:openai-compat',
    !preAdmit.ok && (preAdmit.error ?? '').includes('no-credential:openai-compat'),
    preAdmit.ok ? 'unexpectedly admitted' : (preAdmit.error ?? ''),
  )

  writeUserSettings({
    compatProvider: {
      [ENDPOINT_NAME]: {
        baseUrl,
        dialect: 'llamacpp',
      },
    },
    engine: {
      model: FULL_MODEL,
    },
  })

  section('§1 New session admission on keyless named compat endpoint + first turn from fixture')
  check(
    '(1a) screenBirthModel() preserves saved engine.model on a keyless named compat home',
    screenBirthModel() === FULL_MODEL,
    `screenBirthModel=${String(screenBirthModel())}`,
  )
  const firstBirth = await admitSession({ model: FULL_MODEL })
  check(
    '(1b) new session on compat/llmhost/<model> is admitted by the daemon',
    firstBirth.ok === true && firstBirth.modelId === FULL_MODEL,
    firstBirth.ok ? `admitted modelId=${firstBirth.modelId}` : (firstBirth.error ?? ''),
  )
  const defaultBirth = await admitSession()
  check(
    '(1c) unnamed new session resolves engine.model = compat/llmhost/<model> and is admitted',
    defaultBirth.ok === true && defaultBirth.modelId === FULL_MODEL,
    defaultBirth.ok ? `admitted modelId=${defaultBirth.modelId}` : (defaultBirth.error ?? ''),
  )
  if (defaultBirth.ok) {
    await daemonControlRpc({ op: 'sessionRelease', runnerId: defaultBirth.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }

  let firstSessionId = ''
  if (firstBirth.ok) {
    firstSessionId = firstBirth.sessionId
    const sent = await dispatchTurn(firstSessionId, 'Say hello from the keyless named compat fixture.')
    check('(1d) first turn dispatches to the born session', sent.ok === true, JSON.stringify(sent))
    const settled = await untilAsync(
      () => turnSettled(firstSessionId) && transcriptText(firstSessionId).includes(FIXTURE_REPLY),
      60_000,
    )
    check(
      '(1e) first turn answers from the loopback fixture without an Authorization header',
      settled &&
        captures.some(c => c.path === '/v1/chat/completions' && c.model === WIRE_MODEL && c.auth === null) &&
        transcriptText(firstSessionId).includes(FIXTURE_REPLY),
      JSON.stringify({ settled, captures, transcriptTail: transcriptText(firstSessionId).slice(-300) }),
    )
  } else {
    check('(1d) first turn dispatches to the born session', false, 'skipped — birth refused')
    check('(1e) first turn answers from the loopback fixture without an Authorization header', false, 'skipped — birth refused')
  }

  section('§2 /clear road (fresh session admission with vacatingSessionId + park old session) on the same model')
  if (firstSessionId !== '') {
    const clearBirth = await admitSession({ model: FULL_MODEL, vacatingSessionId: firstSessionId })
    check(
      '(2a) /clear fresh-session admission succeeds on the same keyless named compat model',
      clearBirth.ok === true && clearBirth.sessionId !== firstSessionId && clearBirth.modelId === FULL_MODEL,
      clearBirth.ok ? `sessionId=${clearBirth.sessionId} modelId=${clearBirth.modelId}` : (clearBirth.error ?? ''),
    )
    const parked = (await daemonControlRpc(
      { op: 'sessionControl', action: 'park', sessionId: firstSessionId, by: `operator:${process.pid}` } as never,
      { timeoutMs: 15_000 },
    )) as { ok?: boolean; outcome?: string }
    check(
      '(2b) /clear parks the vacated session while the fresh session stands live on the same model',
      parked.ok === true &&
        readWorkerRec(firstSessionId)?.parkedAt !== undefined &&
        (clearBirth.ok ? readWorkerRec(clearBirth.sessionId)?.modelKey === FULL_MODEL : false),
      JSON.stringify({ parked, oldRec: readWorkerRec(firstSessionId), newRec: clearBirth.ok ? readWorkerRec(clearBirth.sessionId) : null }),
    )
    if (clearBirth.ok) {
      const beforeCaptures = captures.length
      const clearTurn = await dispatchTurn(clearBirth.sessionId, 'Second turn on the cleared session.')
      const clearSettled = await untilAsync(
        () => turnSettled(clearBirth.sessionId) && transcriptText(clearBirth.sessionId).includes(FIXTURE_REPLY),
        60_000,
      )
      check(
        '(2c) the fresh session born by /clear also answers from the fixture on the same model',
        clearTurn.ok === true && clearSettled && captures.length > beforeCaptures,
        JSON.stringify({ clearTurn, clearSettled, newCaptures: captures.length - beforeCaptures }),
      )
      await daemonControlRpc({ op: 'sessionRelease', runnerId: clearBirth.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
    } else {
      check('(2c) the fresh session born by /clear also answers from the fixture on the same model', false, 'skipped — /clear birth refused')
    }
  } else {
    check('(2a) /clear fresh-session admission succeeds on the same keyless named compat model', false, 'skipped — §1 birth refused')
    check('(2b) /clear parks the vacated session while the fresh session stands live on the same model', false, 'skipped — §1 birth refused')
    check('(2c) the fresh session born by /clear also answers from the fixture on the same model', false, 'skipped — §1 birth refused')
  }

  section('§3 Named endpoint WITH keyCommand and no key stored is refused, naming the endpoint')
  writeUserSettings({
    compatProvider: {
      [ENDPOINT_NAME]: {
        baseUrl,
        dialect: 'llamacpp',
        keyCommand: 'exit 1',
      },
    },
    engine: {
      model: FULL_MODEL,
    },
  })
  const keyedRefusal = await admitSession({ model: FULL_MODEL })
  const keyedText = keyedRefusal.ok ? '(unexpectedly admitted)' : (keyedRefusal.error ?? '')
  if (keyedRefusal.ok) {
    await daemonControlRpc({ op: 'sessionRelease', runnerId: keyedRefusal.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }
  check(
    '(3a) named endpoint with keyCommand and no key stored is refused with no-credential:openai-compat',
    !keyedRefusal.ok && keyedText.includes('no-credential:openai-compat'),
    keyedText,
  )
  check(
    "(3b) refusal words name the endpoint ('llmhost' needs a key: /logins compat/llmhost) instead of MERCURY_COMPAT_BASE_URL",
    !keyedRefusal.ok &&
      keyedText.includes(`the endpoint '${ENDPOINT_NAME}' needs a key: /logins compat/${ENDPOINT_NAME}`) &&
      keyedText.includes('MERCURY_COMPAT_LLMHOST_API_KEY') &&
      !keyedText.includes('MERCURY_COMPAT_BASE_URL'),
    keyedText,
  )

  section('§4 Legacy env endpoint without a key is still refused with today’s words')
  writeUserSettings({
    compatProvider: {
      [ENDPOINT_NAME]: {
        baseUrl,
        dialect: 'llamacpp',
      },
    },
  })
  const legacyUnconfigured = await admitSession({ model: 'compat/legacy-model' })
  const legacyText = legacyUnconfigured.ok ? '(unexpectedly admitted)' : (legacyUnconfigured.error ?? '')
  if (legacyUnconfigured.ok) {
    await daemonControlRpc({ op: 'sessionRelease', runnerId: legacyUnconfigured.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }
  check(
    '(4a) legacy compat/<model> without MERCURY_COMPAT_BASE_URL/key is refused even while a keyless named endpoint exists',
    !legacyUnconfigured.ok && legacyText.includes('no-credential:openai-compat'),
    legacyText,
  )
  check(
    '(4b) legacy refusal keeps today’s env-var words (MERCURY_COMPAT_BASE_URL and MERCURY_COMPAT_API_KEY)',
    !legacyUnconfigured.ok &&
      legacyText.includes('set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY if the endpoint needs one)') &&
      legacyText.includes('the openai-compat family holds no credential on this account'),
    legacyText,
  )

  section('§5 A keyCommand endpoint: each admission re-reads settings and never re-runs the key command')
  const keyRuns = join(SCRATCH, 'key-command-runs.txt')
  writeFileSync(keyRuns, '')
  writeUserSettings({
    compatProvider: {
      [ENDPOINT_NAME]: {
        baseUrl,
        dialect: 'llamacpp',
        keyCommand: `echo $PPID >> '${keyRuns}'; echo fixture-llmhost-key-not-a-real-key`,
      },
    },
    engine: { model: FULL_MODEL },
  })
  const keyedBirths: AdmitReply[] = []
  for (let i = 0; i < 3; i++) {
    const birth = await admitSession({ model: FULL_MODEL })
    keyedBirths.push(birth)
    if (birth.ok) await daemonControlRpc({ op: 'sessionRelease', runnerId: birth.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }
  const daemonPid = ((): number | undefined => {
    try {
      return (JSON.parse(readFileSync(join(daemonDir, 'daemon.json'), 'utf8')) as { pid?: number }).pid
    } catch {
      return undefined
    }
  })()
  const runLines = readFileSync(keyRuns, 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '')
  const daemonKeyRuns = runLines.filter(line => Number(line) === daemonPid).length
  check(
    '(5a) three births on the keyCommand endpoint are admitted on its model',
    keyedBirths.every(b => b.ok === true && b.modelId === FULL_MODEL),
    JSON.stringify(keyedBirths.map(b => (b.ok ? b.modelId : b.error))),
  )
  check(
    '(5b) the daemon runs the key command once across the three admissions',
    daemonPid !== undefined && daemonKeyRuns === 1,
    `daemon pid ${String(daemonPid)} ran it ${daemonKeyRuns} time(s); ${runLines.length} run(s) across every process`,
  )

  section('§6 A sign-out since: a saved engine.model nothing on the home can run births keyless, as before')
  writeUserSettings({ engine: { model: FULL_MODEL } })
  dropCredentialMemos()
  resetComputedDefaultMemo()
  const signedOutScreen = screenBirthModel()
  check(
    '(6a) the birth door carries no model when no credential on the home runs the saved engine.model',
    signedOutScreen === undefined,
    `screenBirthModel=${String(signedOutScreen)}`,
  )
  const signedOutBirth = await admitSession()
  check(
    '(6b) the model-less birth the door sends is admitted keyless',
    signedOutBirth.ok === true && readWorkerRec(signedOutBirth.sessionId)?.keyless === true,
    signedOutBirth.ok ? JSON.stringify(readWorkerRec(signedOutBirth.sessionId) ?? null) : (signedOutBirth.error ?? ''),
  )
  if (signedOutBirth.ok) {
    await daemonControlRpc({ op: 'sessionRelease', runnerId: signedOutBirth.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }
  const signedOutNamed = await admitSession({ model: FULL_MODEL })
  check(
    '(6c) the saved model spelled out on that home is refused naming its family',
    !signedOutNamed.ok && (signedOutNamed.error ?? '').includes('no-credential:openai-compat'),
    signedOutNamed.ok ? '(unexpectedly admitted)' : (signedOutNamed.error ?? ''),
  )
  if (signedOutNamed.ok) {
    await daemonControlRpc({ op: 'sessionRelease', runnerId: signedOutNamed.runnerId } as never, { timeoutMs: 10_000 }).catch(() => undefined)
  }
} finally {
  await stopDaemon()
  server.stop(true)
  rmSync(SCRATCH, { recursive: true, force: true })
}

clearTimeout(guard)
console.log('\n' + '═'.repeat(60))
console.log(failures === 0 ? '✅ ALL BIRTH-KEYLESS-COMPAT PROOFS PASS' : `❌ ${failures} BIRTH-KEYLESS-COMPAT PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

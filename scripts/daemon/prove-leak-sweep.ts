#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'leak-sweep-home-'))
delete process.env.MERCURY_HOME

let failures = 0
const leakFailureHints: Array<[string, string]> = [
  ['A1a', 'fix subprocessEnv in src/platform/processes/subprocessEnv.ts or pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts'],
  ['A2', 'fix execFileNoThrow in src/platform/processes/execFileNoThrow.ts'],
  ['A3', 'fix buildKernelEnv in src/tools/engines/eval-kernels/kernelEnv.ts'],
  ['A4', 'fix the call of CronCreateTool (src/tools/cron/CronCreateTool.ts) or ScheduleWakeupTool (src/tools/schedule-wakeup/ScheduleWakeupTool.ts)'],
  ['A5', 'fix deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts or saturnFactsOf in src/daemon/saturn/saturn.ts'],
  ['A6', 'fix describeHeadersRedacted in src/commands/mcp/redactHeaders.ts'],
  ['A7', 'fix validateSaturnSubmission or saturnSecretProseRefusal in src/daemon/saturn/saturn.ts, boxScheduleProblem in src/daemon/saturn/saturnBoxSchedules.ts, or the two schedule tools'],
  ['B5', 'fix runHuggingfaceDeviceLogin in src/models/roads/huggingface/huggingfaceLogin.ts or runKimiDeviceLogin in src/models/roads/moonshot/moonshotLogin.ts'],
  ['B4x', 'fix rearmWatchRoots or dispose in src/integrations/skill-watch/skillChangeDetector.ts'],
]
const leakHintOf = (label: string): string => {
  const found = leakFailureHints.find(([prefix]) => label.startsWith(`${prefix} `))
  return found ? ` · ${found[1]}` : ''
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : `${detail ? '' : ' —'}${leakHintOf(label)}`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


const MARK = 'LEAKMARK-a1b2c3d4e5f60718'
const FOREIGN_TOKEN_VAR = ['CLAUDE', 'CODE'].join('_') + '_OAUTH_TOKEN'


section('§A1a — the scrubbed base is BEHAVIOURAL law (subprocessEnv strips the marks)')
{
  process.env.MERCURY_OAUTH_TOKEN = MARK
  process.env[FOREIGN_TOKEN_VAR] = MARK
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `authorization=Bearer ${MARK}`
  const { subprocessEnv } = await import('../../src/platform/processes/subprocessEnv.ts')
  const scrubbed = subprocessEnv()
  check('A1a the session token never rides a child env', scrubbed.MERCURY_OAUTH_TOKEN === undefined)
  check('A1a the foreign session token never rides a child env', scrubbed[FOREIGN_TOKEN_VAR] === undefined)
  check('A1a the OTLP bearer header never rides a child env', scrubbed.OTEL_EXPORTER_OTLP_HEADERS === undefined)
  check('A1a the scrub never eats the world (PATH survives)', scrubbed.PATH === process.env.PATH)

  const { pythonSpawnEnv } = await import('../../src/integrations/debugger/debugpyResolver.ts')
  const adapterEnv = pythonSpawnEnv()
  const overlayPresent =
    adapterEnv.PYTHONPYCACHEPREFIX !== undefined || adapterEnv.PYTHONDONTWRITEBYTECODE === '1'
  check('A1a pythonSpawnEnv: the marked session token is absent', adapterEnv.MERCURY_OAUTH_TOKEN === undefined)
  check('A1a pythonSpawnEnv: the marked foreign token is absent', adapterEnv[FOREIGN_TOKEN_VAR] === undefined)
  check('A1a pythonSpawnEnv: the marked OTLP header is absent', adapterEnv.OTEL_EXPORTER_OTLP_HEADERS === undefined)
  check('A1a pythonSpawnEnv: the builder overlay still lands', overlayPresent)

  delete process.env.MERCURY_OAUTH_TOKEN
  delete process.env[FOREIGN_TOKEN_VAR]
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
}


section('§A2 — the execa wrapper cannot extend over the raw env (extendEnv trap)')
{
  process.env.MERCURY_OAUTH_TOKEN = MARK
  const { execFileNoThrow } = await import('../../src/platform/processes/execFileNoThrow.ts')
  const probeJs = 'process.stdout.write((process.env.MERCURY_OAUTH_TOKEN ?? "absent") + "|" + (process.env.LEAK_OVERLAY ?? "none") + "|" + (process.env.PATH ? "path" : "nopath"))'
  const bare = await execFileNoThrow(process.execPath, ['-e', probeJs])
  check('A2 a wrapper child never sees the session token (no caller env)', bare.stdout.startsWith('absent|'), bare.stdout.slice(0, 60))
  check('A2 the wrapper child still has a real env (PATH survives)', bare.stdout.endsWith('|path'), bare.stdout.slice(0, 60))
  const overlaid = await execFileNoThrow(process.execPath, ['-e', probeJs], { env: { LEAK_OVERLAY: 'rides' } })
  check('A2 a partial caller env still merges over the SCRUBBED base', overlaid.stdout === 'absent|rides|path', overlaid.stdout.slice(0, 60))
  delete process.env.MERCURY_OAUTH_TOKEN
}

section('§A3 — the no-env spawn subset that runs foreign/user code, and the kernel env\'s OTEL gap')
{
  const { buildKernelEnv } = await import('../../src/tools/engines/eval-kernels/kernelEnv.ts')
  const kernelEnv = buildKernelEnv({
    PATH: '/usr/bin',
    MERCURY_OAUTH_TOKEN: MARK,
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer ${MARK}`,
    OTEL_SERVICE_NAME: 'mercury',
    HOME: '/home/op',
  })
  check('A3 kernel env: the token suffix law already held (VERIFIED-GOOD arm)', kernelEnv.MERCURY_OAUTH_TOKEN === undefined)
  check('A3 kernel env: the OTLP bearer headers never reach a kernel', kernelEnv.OTEL_EXPORTER_OTLP_HEADERS === undefined)
  check('A3 kernel env: the whole OTEL_ exporter family stays out', kernelEnv.OTEL_SERVICE_NAME === undefined)
  check('A3 kernel env: PATH and HOME still ride', kernelEnv.PATH === '/usr/bin' && kernelEnv.HOME === '/home/op')

}

section('§A4 — a secret-bearing prompt never persists onto a schedule (both model doors)')
{
  const MARKED_KEY = `sk-ant-${MARK}`
  const { CronCreateTool } = await import('../../src/tools/cron/CronCreateTool.ts')
  let cronRefusal = ''
  try {
    await CronCreateTool.call({ cron: '0 9 * * *', prompt: `use ${MARKED_KEY} for the audit` } as never, {} as never)
  } catch (e) {
    cronRefusal = String((e as Error).message ?? e)
  }
  check('A4 CronCreate refuses a secret-bearing prompt typed', cronRefusal.includes('secret'), cronRefusal.slice(0, 90))
  check('A4 the refusal never echoes the secret bytes', !cronRefusal.includes(MARK), cronRefusal.slice(0, 90))

  const { ScheduleWakeupTool } = await import('../../src/tools/schedule-wakeup/ScheduleWakeupTool.ts')
  let wakeRefusal = ''
  try {
    await ScheduleWakeupTool.call({ delaySeconds: 60, prompt: `key: ${MARKED_KEY}` } as never, {} as never)
  } catch (e) {
    wakeRefusal = String((e as Error).message ?? e)
  }
  check('A4 ScheduleWakeup already refuses the same (VERIFIED-GOOD arm)', wakeRefusal.includes('secret'), wakeRefusal.slice(0, 90))
  check('A4 the wakeup refusal never echoes the secret bytes', !wakeRefusal.includes(MARK))
}

section('§A5 — SATURN\'s capture is WHO, never a token (the schema\'s own law, driven)')
{
  const { deriveScheduleAccountForModel } = await import('../../src/daemon/saturn/saturnAccount.ts')
  const smuggled = {
    subscriber: true,
    scopeDir: '/scope/ring-a',
    identity: 'operator@example.com',
    knownExpiresAt: 1_900_000_000_000,
    refreshable: true,
    refreshToken: MARK,
    accessToken: MARK,
  }
  const derived = deriveScheduleAccountForModel('claude-opus-5', {
    familyOf: () => 'anthropic',
    presenceOf: () => ({ credentialed: true, kind: 'oauth' as const }),
    anthropicDetail: () => smuggled as never,
  })
  const captureJson = JSON.stringify(derived)
  check('A5 the capture never carries smuggled token bytes', derived.ok && !captureJson.includes(MARK), captureJson.slice(0, 120))
  const CAPTURE_FIELDS = new Set(['family', 'source', 'scopeDir', 'identity', 'knownExpiresAt', 'refreshable'])
  const captureKeys = derived.ok ? Object.keys(derived.account) : []
  check('A5 the capture fields are the closed WHO set', captureKeys.length > 0 && captureKeys.every(k => CAPTURE_FIELDS.has(k)), captureKeys.join(','))
  check('A5 the capture carries the identity (WHO rides)', derived.ok && (derived.account as { identity?: string }).identity === 'operator@example.com')

  const saturn = await import('../../src/daemon/saturn/saturn.ts')
  const schedule = {
    schema: 1,
    id: 'ab12cd34',
    when: { kind: 'every' as const, cron: '0 9 * * *', spelling: 'daily at 9' },
    action: { kind: 'fire' as const, prompt: 'audit' },
    account: { family: 'anthropic', source: 'oauth' as const, identity: 'op@x.com', smuggle: MARK },
    modelKey: 'claude-opus-5',
    createdAt: 1_700_000_000_000,
    createdBy: 'operator:test',
  }
  const facts = saturn.saturnFactsOf({ schedules: [schedule as never], heldFires: [] }, 1_700_000_000_000)
  const factsJson = JSON.stringify(facts)
  check('A5 the facts projection is account-free (no mark, no identity, no family)', !factsJson.includes(MARK) && !factsJson.includes('op@x.com') && !factsJson.includes('anthropic'), factsJson.slice(0, 120))
  const rowKeys = Object.keys(facts.schedules?.[0] ?? {})
  check('A5 the facts row keys are the closed display set', rowKeys.every(k => ['id', 'when', 'nextFireMs', 'kind', 'paused'].includes(k)), rowKeys.join(','))

}

section('§A6 — a headers object is never spelled whole onto a surface (log, confirmation, error)')
{
  const { describeHeadersRedacted } = await import('../../src/commands/mcp/redactHeaders.ts')
  const spelled = describeHeadersRedacted({
    authorization: `Bearer ${MARK}`,
    'X-Api-Key': MARK,
    'X-Custom-Note': `Bearer ${MARK}`,
    'x-org': 'acme',
  })
  check('A6 credential-named values mask (authorization, api-key)', !spelled.includes(MARK) || !/authorization[^,]*LEAKMARK/.test(spelled), spelled.slice(0, 120))
  check('A6 NO marked value survives anywhere (secret-shaped belt included)', !spelled.includes(MARK), spelled.slice(0, 120))
  check('A6 header NAMES all ride (the diagnostic value)', ['authorization', 'X-Api-Key', 'X-Custom-Note', 'x-org'].every(n => spelled.includes(n)), spelled.slice(0, 160))
  check('A6 a benign value rides verbatim', spelled.includes('acme'), spelled.slice(0, 160))

}


section('§A7 — the secret-prose guard is the DAEMON VALIDATOR\'s (one home; every persisting door inherits)')
{
  const MARKED_KEY = `sk-ant-${MARK}`
  const saturn = await import('../../src/daemon/saturn/saturn.ts')
  const fire = saturn.validateSaturnSubmission({
    when: { kind: 'every', cron: '0 9 * * *' },
    action: { kind: 'fire', prompt: `audit with ${MARKED_KEY}` },
  })
  check('A7 a secret-bearing fire prompt refuses at the validator', !fire.ok && /secret/.test((fire as { reason: string }).reason ?? ''), JSON.stringify(fire).slice(0, 100))
  check('A7 the fire refusal never echoes the bytes', !JSON.stringify(fire).includes(MARK))
  const birth = saturn.validateSaturnSubmission({
    when: { kind: 'at', atMs: 2_000_000_000_000 },
    action: {
      kind: 'birth',
      birth: { workspaceDir: '/w', modelKey: 'claude-opus-5', presence: 'headless', opening: `start with ${MARKED_KEY}` },
    },
  })
  check('A7 a secret-bearing birth opening refuses at the validator', !birth.ok && /secret/.test((birth as { reason: string }).reason ?? ''), JSON.stringify(birth).slice(0, 100))
  const cleanFire = saturn.validateSaturnSubmission({
    when: { kind: 'every', cron: '0 9 * * *' },
    action: { kind: 'fire', prompt: 'nightly audit, no credentials aboard' },
  })
  check('A7 a clean submission still validates ok (no false refusal)', cleanFire.ok === true)

  const { boxScheduleProblem } = await import('../../src/daemon/saturn/saturnBoxSchedules.ts')
  const boxProblem = boxScheduleProblem({
    schema: 1,
    id: 'ab12cd34',
    when: { kind: 'at', atMs: 2_000_000_000_000 },
    action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'claude-opus-5', presence: 'headless', opening: `use ${MARKED_KEY}` } },
    account: { family: 'anthropic', source: 'oauth' },
    createdAt: 1_700_000_000_000,
    createdBy: 'operator:test',
  })
  check('A7 the box door refuses the same secret-bearing opening', typeof boxProblem === 'string' && /secret/.test(boxProblem), String(boxProblem).slice(0, 100))

  const refusalSentence = saturn.saturnSecretProseRefusal('prompt', MARKED_KEY)
  check('A7 the helper refuses a marked key and never echoes it', refusalSentence !== null && !refusalSentence.includes(MARK) && refusalSentence.includes('environment or keychain'))
  const { CronCreateTool } = await import('../../src/tools/cron/CronCreateTool.ts')
  let cronRefusal = ''
  try {
    await CronCreateTool.call({ cron: '0 9 * * *', prompt: `use ${MARKED_KEY}` } as never, {} as never)
  } catch (e) {
    cronRefusal = String((e as Error).message ?? e)
  }
  const { ScheduleWakeupTool } = await import('../../src/tools/schedule-wakeup/ScheduleWakeupTool.ts')
  let wakeRefusal = ''
  try {
    await ScheduleWakeupTool.call({ delaySeconds: 60, prompt: `key ${MARKED_KEY}` } as never, {} as never)
  } catch (e) {
    wakeRefusal = String((e as Error).message ?? e)
  }
  check('A7 CronCreate consumes the one spelling', refusalSentence !== null && cronRefusal.includes(refusalSentence))
  check('A7 ScheduleWakeup consumes the one spelling', refusalSentence !== null && wakeRefusal.includes(refusalSentence))
}


section('§B — every arm is paired with its release (the class-B lifecycle census)')
{


  {
    ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
    const { runHuggingfaceDeviceLogin } = await import('../../src/models/roads/huggingface/huggingfaceLogin.ts')
    const { runKimiDeviceLogin } = await import('../../src/models/roads/moonshot/moonshotLogin.ts')
    const cancelledInThePause = async (run: (seam: { cancelled: () => boolean; sleep: () => Promise<void>; fetchImpl: typeof fetch }) => Promise<{ ok: boolean; code?: string }>): Promise<string> => {
      let cancelled = false
      let pauses = 0
      let polls = 0
      const fetchImpl = (async (url: RequestInfo | URL) => {
        if (String(url).includes('token')) polls++
        return new Response(JSON.stringify({ device_code: 'DC-B5', user_code: 'USER-B5', verification_uri: 'https://login.example/activate', interval: 0, expires_in: 300 }), { status: 200 })
      }) as typeof fetch
      const outcome = await run({ cancelled: () => cancelled, sleep: async () => { pauses++; cancelled = true }, fetchImpl })
      return `${outcome.code ?? (outcome.ok ? 'signed in' : 'failed')} after ${pauses} pause(s) and ${polls} poll(s)`
    }
    const hub = await cancelledInThePause(seam => runHuggingfaceDeviceLogin({ cancelled: seam.cancelled, sleep: seam.sleep, refreshCatalogue: () => Promise.resolve(null), io: { env: { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture' }, fetchImpl: seam.fetchImpl } }))
    check('B5 the Hugging Face sign-in re-checks cancelled() right after the sleep: a cancel that lands in the pause ends it before any poll', hub === 'cancelled after 1 pause(s) and 0 poll(s)', hub)
    const kimi = await cancelledInThePause(seam => runKimiDeviceLogin({ region: 'global', cancelled: seam.cancelled, sleep: seam.sleep, io: { fetchImpl: seam.fetchImpl } }))
    check('B5 the Kimi sign-in re-checks cancelled() right after the sleep: a cancel that lands in the pause ends it before any poll', kimi === 'cancelled after 1 pause(s) and 0 poll(s)', kimi)
  }
}

section('§B4x — two overlapping re-arms leave EXACTLY ONE live watcher (the generation guard, driven through the factory seam)')
{
  const { mkdirSync } = await import('node:fs')
  const home = process.env.MERCURY_CONFIG_DIR as string
  mkdirSync(join(home, 'skills'), { recursive: true })
  mkdirSync(join(home, 'commands'), { recursive: true })
  const detector = await import('../../src/integrations/skill-watch/skillChangeDetector.ts')
  const made: Array<{ closed: boolean }> = []
  const factory = () => {
    const rec = { closed: false }
    made.push(rec)
    return {
      on: () => undefined,
      close: async () => {
        rec.closed = true
      },
    }
  }
  const previousCwd = process.cwd()
  const ground = join(home, 'b4x-ground')
  mkdirSync(join(ground, '.mercury', 'skills'), { recursive: true })
  mkdirSync(join(ground, '.mercury', 'commands'), { recursive: true })
  process.chdir(ground)
  try {
    await detector.resetForTesting({ watcherFactory: factory } as never)
    await Promise.all([detector.rearmWatchRoots(), detector.rearmWatchRoots()])
    const liveAfterRace = made.filter(w => !w.closed).length
    check('B4x two overlapping re-arms leave exactly one live watcher', made.length >= 1 && liveAfterRace === 1, `made=${made.length} live=${liveAfterRace}`)
    await detector.rearmWatchRoots()
    const liveAfterThird = made.filter(w => !w.closed).length
    check('B4x a later re-arm closes the standing watcher and arms one', liveAfterThird === 1, `made=${made.length} live=${liveAfterThird}`)
    await detector.dispose()
    check('B4x dispose closes the last watcher (zero live)', made.every(w => w.closed), `live=${made.filter(w => !w.closed).length}`)

    const bare = join(home, 'b4x-bare')
    mkdirSync(bare, { recursive: true })
    process.chdir(bare)
    made.length = 0
    await detector.resetForTesting({ watcherFactory: factory } as never)
    await Promise.all([detector.rearmWatchRoots(), detector.rearmWatchRoots()])
    const liveB = made.filter(w => !w.closed)
    check(
      'B4x with birth targets: the race leaves exactly the last generation pair live',
      made.length >= 2 && liveB.length === 2 && liveB[0] === made[made.length - 2] && liveB[1] === made[made.length - 1],
      `made=${made.length} live=${liveB.length}`,
    )
    await detector.dispose()
    check('B4x with birth targets: dispose closes both handles', made.every(w => w.closed), `live=${made.filter(w => !w.closed).length}`)
  } finally {
    process.chdir(previousCwd)
    await detector.resetForTesting()
  }
}

console.log(failures === 0 ? '\nprove-leak-sweep: ALL GREEN' : `\nprove-leak-sweep: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

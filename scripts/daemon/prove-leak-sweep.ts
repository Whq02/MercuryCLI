#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'leak-sweep-home-'))
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')

const MARK = 'LEAKMARK-a1b2c3d4e5f60718'
const FOREIGN_TOKEN_VAR = ['CLAUDE', 'CODE'].join('_') + '_OAUTH_TOKEN'

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) srcFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

section('§A1a — the scrubbed base is BEHAVIOURAL law (subprocessEnv strips the marks)')
{
  process.env.MERCURY_OAUTH_TOKEN = MARK
  process.env[FOREIGN_TOKEN_VAR] = MARK
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `authorization=Bearer ${MARK}`
  const { subprocessEnv } = await import('../../src/utils/subprocessEnv.ts')
  const scrubbed = subprocessEnv()
  check('A1a the session token never rides a child env', scrubbed.MERCURY_OAUTH_TOKEN === undefined)
  check('A1a the foreign session token never rides a child env', scrubbed[FOREIGN_TOKEN_VAR] === undefined)
  check('A1a the OTLP bearer header never rides a child env', scrubbed.OTEL_EXPORTER_OTLP_HEADERS === undefined)
  check('A1a the scrub never eats the world (PATH survives)', scrubbed.PATH === process.env.PATH)

  const { pythonSpawnEnv } = await import('../../src/services/dap/debugpyResolver.ts')
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

section('§A1b — the raw-env census (every child rides the scrubbed base, or wears the law comment)')
{
  const needle = /\.\.\.process\.env(?![.\w])|env:\s*process\.env(?![.\w])/
  const violations: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    if (file.endsWith(join('utils', 'subprocessEnv.ts'))) continue
    const lines = readFileSync(file, 'utf-8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      if (!needle.test(line)) continue
      const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
      if (context.includes('child-env law:')) continue
      violations.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
    }
  }
  check('A1b zero unlawful raw process.env child bases in src/', violations.length === 0, violations.join(' · '))
}

section('§A2 — the execa wrapper cannot extend over the raw env (extendEnv trap)')
{
  process.env.MERCURY_OAUTH_TOKEN = MARK
  const { execFileNoThrow } = await import('../../src/utils/execFileNoThrow.ts')
  const probeJs = 'process.stdout.write((process.env.MERCURY_OAUTH_TOKEN ?? "absent") + "|" + (process.env.LEAK_OVERLAY ?? "none") + "|" + (process.env.PATH ? "path" : "nopath"))'
  const bare = await execFileNoThrow(process.execPath, ['-e', probeJs])
  check('A2 a wrapper child never sees the session token (no caller env)', bare.stdout.startsWith('absent|'), bare.stdout.slice(0, 60))
  check('A2 the wrapper child still has a real env (PATH survives)', bare.stdout.endsWith('|path'), bare.stdout.slice(0, 60))
  const overlaid = await execFileNoThrow(process.execPath, ['-e', probeJs], { env: { LEAK_OVERLAY: 'rides' } })
  check('A2 a partial caller env still merges over the SCRUBBED base', overlaid.stdout === 'absent|rides|path', overlaid.stdout.slice(0, 60))
  const wrapperSrc = readFileSync(join(ROOT, 'src', 'utils', 'execFileNoThrow.ts'), 'utf-8')
  check('A2 the wrapper pins extendEnv: false (the execa merge can never resurface the raw env)', wrapperSrc.includes('extendEnv: false'))
  delete process.env.MERCURY_OAUTH_TOKEN
}

section('§A3 — the no-env spawn subset that runs foreign/user code, and the kernel env\'s OTEL gap')
{
  const { buildKernelEnv } = await import('../../src/services/eval/kernelEnv.ts')
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

  const editor = readFileSync(join(ROOT, 'src', 'utils', 'editor.ts'), 'utf-8')
  check('A3 editor.ts: all four editor spawns ride the scrubbed base', (editor.match(/env: subprocessEnv\(\)/g) ?? []).length === 4)
  const bridge = readFileSync(join(ROOT, 'src', 'cli', 'editorBridge.ts'), 'utf-8')
  check('A3 editorBridge.ts: all four CLI calls ride the scrubbed base', (bridge.match(/env: subprocessEnv\(\)/g) ?? []).length === 4)
  const interp = readFileSync(join(ROOT, 'src', 'services', 'eval', 'interpreters.ts'), 'utf-8')
  check('A3 interpreters.ts: the version probe rides the scrubbed base', interp.includes('env: { ...subprocessEnv() }'))
}

section('§A4 — a secret-bearing prompt never persists onto a schedule (both model doors)')
{
  const MARKED_KEY = `sk-ant-${MARK}`
  const { CronCreateTool } = await import('../../src/tools/ScheduleCronTool/CronCreateTool.ts')
  let cronRefusal = ''
  try {
    await CronCreateTool.call({ cron: '0 9 * * *', prompt: `use ${MARKED_KEY} for the audit` } as never, {} as never)
  } catch (e) {
    cronRefusal = String((e as Error).message ?? e)
  }
  check('A4 CronCreate refuses a secret-bearing prompt typed', cronRefusal.includes('secret'), cronRefusal.slice(0, 90))
  check('A4 the refusal never echoes the secret bytes', !cronRefusal.includes(MARK), cronRefusal.slice(0, 90))

  const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')
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
  const { deriveScheduleAccountForModel } = await import('../../src/daemon/saturnAccount.ts')
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

  const saturn = await import('../../src/daemon/saturn.ts')
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

  const acctSrc = readFileSync(join(ROOT, 'src', 'daemon', 'saturnAccount.ts'), 'utf-8')
  check('A5 refreshable is an existence check on the token, never a copy', acctSrc.includes("refreshable: typeof tokens?.refreshToken === 'string' && tokens.refreshToken.length > 0"))
  const saturnSrc = readFileSync(join(ROOT, 'src', 'daemon', 'saturn.ts'), 'utf-8')
  const iface = (name: string): string => saturnSrc.slice(saturnSrc.indexOf(`export interface ${name} {`), saturnSrc.indexOf('\n}', saturnSrc.indexOf(`export interface ${name} {`)))
  const acctIface = iface('ScheduleAccountV1')
  check('A5 ScheduleAccountV1 spells no secret-shaped field', !/accessToken|refreshToken\??:|apiKey|authorization/i.test(acctIface))
  const heldIface = iface('HeldFireV1')
  check('A5 HeldFireV1 spells the closed hold set (identity comparator, never credential)', heldIface.includes('mismatchIdentity?: string') && !/token|apiKey|authorization/i.test(heldIface))
}

section('§A6 — a headers object is never spelled whole onto a surface (log, confirmation, error)')
{
  const { describeHeadersRedacted } = await import('../../src/utils/redactHeaders.ts')
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

  const needle = /JSON\.stringify\((?:config\.)?headers/
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const body = readFileSync(file, 'utf-8')
    if (needle.test(body)) offenders.push(file.slice(ROOT.length + 1))
  }
  check('A6 zero whole-headers stringify sites in src/', offenders.length === 0, offenders.join(' · '))
}

section('§R1 — every listening socket binds LOOPBACK-ONLY by construction (the crown row)')
{
  const unity = readFileSync(join(ROOT, 'src', 'services', 'unity', 'bridgeFiles.generated.ts'), 'utf-8')
  check('R1 the Unity bridge server binds IPAddress.Loopback', unity.includes('TcpListener(IPAddress.Loopback'))
  const vulcan = readFileSync(join(ROOT, 'src', 'services', 'vulcan', 'addonFiles.generated.ts'), 'utf-8')
  check('R1 the Godot addon server binds 127.0.0.1', vulcan.includes('_server.listen(port, \\"127.0.0.1\\")'))
  const blenderBaked = join(ROOT, 'src', 'services', 'blender', 'bridgeFiles.generated.ts')
  const blenderPresent = ((): boolean => { try { statSync(blenderBaked); return true } catch { return false } })()
  if (blenderPresent) {
    const blender = readFileSync(blenderBaked, 'utf-8')
    check('R1 the Blender bridge server binds 127.0.0.1', blender.includes('bind((\\"127.0.0.1\\"'))
  } else {
    check('R1 the Blender baked server is absent on this base (censused read-only on its lane)', true)
  }
  const tcpBridge = readFileSync(join(ROOT, 'src', 'services', 'tcpBridge', 'entry.ts'), 'utf-8')
  check('R1 the tcp bridge client refuses non-loopback hosts typed', tcpBridge.includes("refusing non-loopback host"))

  const LAWFUL_LISTEN = /sockPath|127\.0\.0\.1|'localhost'|conn\.listen\(\)/
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf-8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue
      if (!/\.listen\(/.test(line)) continue
      if (LAWFUL_LISTEN.test(line)) continue
      if (file.endsWith('.generated.ts') || file.includes(join('skills', 'bundled'))) continue
      offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
    }
  }
  check('R1 zero TCP listeners without a loopback bind on the line', offenders.length === 0, offenders.join(' · '))

  for (const rel of [join('services', 'unity', 'bridgeToken.ts'), join('services', 'vulcan', 'vulcanToken.ts')]) {
    const body = readFileSync(join(ROOT, 'src', rel), 'utf-8')
    check(`R1 ${rel} writes the token 0600 with the chmod pin`, body.includes('{ mode: 0o600 }') && body.includes('chmodSync(file, 0o600)'))
  }
}

section('§R2 — no real key ever committed (the fixture sweep, standing)')
{
  const KEY_SHAPES: ReadonlyArray<{ kind: string; re: RegExp }> = [
    { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
    { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { kind: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
    { kind: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  ]
  const FIXTURE_MARKER = /fixture|dummy|proof|probe|poison|example|fake|test|redact|momentum|crewrender/i
  const KNOWN_SYNTHETIC = [
    'AKIA1234567890ABCDEF',
    'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL',
    'sk-ant-spoken-model-pin',
    'sk-ant-0123456789abcdef',
    'MIIBfixture',
  ]
  const classify = (line: string): string | null => {
    for (const { kind, re } of KEY_SHAPES) {
      if (!re.test(line)) continue
      if (KNOWN_SYNTHETIC.some(v => line.includes(v))) continue
      if (kind !== 'private-key-block' && FIXTURE_MARKER.test(line)) continue
      return kind
    }
    return null
  }
  check('R2 classifier: a bare real-shaped key flags', classify('const k = "sk-ant-api03-' + 'A'.repeat(24) + '"') === 'anthropic')
  check('R2 classifier: a self-declared fixture key is lawful', classify("process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'") === null)
  check('R2 classifier: a private key block is NEVER lawful', classify('-----BEGIN RSA PRIVATE KEY----- // fixture') === 'private-key-block')

  const { execFileSync } = await import('node:child_process')
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } })
    .split('\n')
    .filter(f => f.length > 0 && !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|gz|pdf)$/i.test(f))
  const hits: string[] = []
  for (const rel of tracked) {
    if (rel === 'scripts/daemon/prove-leak-sweep.ts') continue
    let body: string
    try {
      body = readFileSync(join(ROOT, rel), 'utf-8')
    } catch {
      continue
    }
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const kind = classify(lines[i] as string)
      if (kind !== null) hits.push(`${rel}:${i + 1} (${kind})`)
    }
  }
  check('R2 zero real-shaped keys in the tracked tree', hits.length === 0, hits.slice(0, 6).join(' · '))
}

section('§A7 — the secret-prose guard is the DAEMON VALIDATOR\'s (one home; every persisting door inherits)')
{
  const MARKED_KEY = `sk-ant-${MARK}`
  const saturn = await import('../../src/daemon/saturn.ts')
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

  const { boxScheduleProblem } = await import('../../src/daemon/saturnBoxSchedules.ts')
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
  const { CronCreateTool } = await import('../../src/tools/ScheduleCronTool/CronCreateTool.ts')
  let cronRefusal = ''
  try {
    await CronCreateTool.call({ cron: '0 9 * * *', prompt: `use ${MARKED_KEY}` } as never, {} as never)
  } catch (e) {
    cronRefusal = String((e as Error).message ?? e)
  }
  const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')
  let wakeRefusal = ''
  try {
    await ScheduleWakeupTool.call({ delaySeconds: 60, prompt: `key ${MARKED_KEY}` } as never, {} as never)
  } catch (e) {
    wakeRefusal = String((e as Error).message ?? e)
  }
  check('A7 CronCreate consumes the one spelling', refusalSentence !== null && cronRefusal.includes(refusalSentence))
  check('A7 ScheduleWakeup consumes the one spelling', refusalSentence !== null && wakeRefusal.includes(refusalSentence))
}

section('§A8 — EVERY spawn passes an explicit env (the product law; an env-less spawn reds)')
{
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const body = readFileSync(file, 'utf-8')
    const importMatch = body.match(/import \{([^}]*)\} from 'node:child_process'/)
    if (!importMatch) continue
    const names = (importMatch[1] as string)
      .split(',')
      .map(n => n.trim().replace(/^type\s+.*/, '').replace(/\s+as\s+(\w+)/, '$1'))
      .filter(n => /^(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/.test(n))
    if (names.length === 0) continue
    const lines = body.split('\n')
    const callRe = new RegExp(`(?<![.\\w])(${names.join('|')})\\(`)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      if (!callRe.test(line)) continue
      if (file.includes(join('skills', 'bundled'))) continue
      let depth = 0
      let end = i
      outer: for (let j = i; j < Math.min(lines.length, i + 60); j++) {
        for (const ch of lines[j] as string) {
          if (ch === '(') depth++
          else if (ch === ')') {
            depth--
            if (depth === 0 && j > i) { end = j; break outer }
            if (depth === 0 && j === i && (lines[i] as string).indexOf('(') < (lines[i] as string).lastIndexOf(')')) { end = j; break outer }
          }
        }
        end = j
      }
      const windowText = lines.slice(i, end + 1).join('\n')
      if (/\benv\b\s*[:,)\]}]|\benv:\s/.test(windowText)) continue
      const above = lines.slice(Math.max(0, i - 3), i).join('\n')
      if (above.includes('child-env law:')) continue
      offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
    }
  }
  check('A8 zero env-less child_process calls in src/', offenders.length === 0, offenders.slice(0, 40).join(' · '))
}

section('§B — every arm is paired with its release (the class-B lifecycle census)')
{
  const src = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf-8')

  const ticker = src(join('daemon', 'saturnTicker.ts'))
  check('B1 ticker stop clears the interval idempotently', ticker.includes('stopped = true') && ticker.includes('clearInterval(timer)') && ticker.includes('if (running || stopped) return'))
  check('B1 the ticker interval is unref\'d (never holds the process)', ticker.includes('timer.unref?.()'))
  check('B1 the daemon calls the stop at shutdown', src(join('daemon', 'main.ts')).includes('stopSaturnTicker?.()'))

  for (const rel of [join('services', 'unity', 'bridgeClient.ts'), join('services', 'vulcan', 'vulcanClient.ts')]) {
    const body = src(rel)
    const teardownWhole =
      body.includes('this.clearHeartbeat()') &&
      body.includes('socket.removeAllListeners()') &&
      body.includes('clearTimeout(p.timer)') &&
      body.includes('if (q.queueTimer) clearTimeout(q.queueTimer)')
    check(`B2 ${rel} teardown releases heartbeat, pendings, queue, socket`, teardownWhole)
    check(`B2 ${rel} singleton closes the old client before replacing`, body.includes('singleton?.client.close()'))
  }
  const unityBaked = src(join('services', 'unity', 'bridgeFiles.generated.ts'))
  check('B2 the baked server closes the old socket on accept-newest', unityBaked.includes('_client.Tcp.Close()') && unityBaked.includes('_client = client;'))

  const skills = src(join('utils', 'skills', 'skillChangeDetector.ts'))
  check('B4 skill watcher: rearm and dispose both close the old watcher', (skills.match(/watcher\?\.close\(\) \?\? Promise\.resolve\(\)/g) ?? []).length >= 3 && skills.includes('clearTimeout(reloadTimer)'))
  for (const rel of [join('components', 'concourse', 'liveTiles.ts'), join('components', 'concourse', 'workerTranscriptFold.ts'), join('services', 'concourse', 'crossProjectPings.ts')]) {
    const body = src(rel)
    check(`B4 ${rel} pairs its watch with a close`, body.includes('.close()'))
  }

  for (const rel of [join('services', 'providers', 'huggingface', 'huggingfaceLogin.ts'), join('services', 'providers', 'moonshot', 'moonshotLogin.ts')]) {
    const body = src(rel)
    const sleepIdx = body.indexOf('await sleep(')
    const recheck = sleepIdx !== -1 && body.slice(sleepIdx, sleepIdx + 200).includes('cancelled()')
    check(`B5 ${rel} re-checks cancelled() right after the sleep`, recheck)
  }
  const machine = src(join('components', 'mercury-ui', 'screens', 'anthropicLoginModel.ts'))
  check('B5 the login machine clears its timer registry on BOTH reset and dispose', (machine.match(/for \(const handle of timers\) deps\.clearTimer\(handle\)/g) ?? []).length === 2)

  const worktrees = src(join('daemon', 'concourseWorktrees.ts'))
  check('B7 gitAsync kills the child on timeout, timer unref\'d', worktrees.includes("child.kill('SIGKILL')") && worktrees.includes('timer.unref?.()'))
  check('B7 the doctor journey probe reaps its owner in finally', src(join('utils', 'healthDeepProbes.ts')).includes('await disposeOwner(owner)'))
}

section('§B4x — two overlapping re-arms leave EXACTLY ONE live watcher (the generation guard, driven through the factory seam)')
{
  const { mkdirSync } = await import('node:fs')
  const home = process.env.MERCURY_CONFIG_DIR as string
  mkdirSync(join(home, 'skills'), { recursive: true })
  mkdirSync(join(home, 'commands'), { recursive: true })
  const detector = await import('../../src/utils/skills/skillChangeDetector.ts')
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

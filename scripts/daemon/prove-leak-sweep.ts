#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-leak-sweep.ts — THE LEAK SWEEP: the two leak classes swept
//  product-wide (CLASS A: nothing secret is ever printed, persisted, or
//  shipped; CLASS B: nothing leaks a handle, a timer, a watcher, or a socket).
//  Each § carries one findings-ledger row's teeth — the pin that would have
//  caught the defect it names, run RED against the pre-fix tree in-lane.
//
//  cpu-pure: marked secrets (LEAKMARK bytes that exist only in this process),
//  injected env, source census — zero daemons, zero PTYs, zero live keys.
//  The marked-secret grammar: a secret-carrying road is driven with bytes no
//  real provider ever mints, and every output surface is grepped for them —
//  presence anywhere is the leak, absence is the law holding.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-leak-sweep.ts
// ============================================================================
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch home BEFORE any src import — no section may touch the real one.
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

// Marked secrets: bytes no real road mints (the FACELOGINS §12 grammar,
// extended product-wide). The foreign product's env spelling is composed so
// this prover never matches a vocabulary sweep.
const MARK = 'LEAKMARK-a1b2c3d4e5f60718'
const FOREIGN_TOKEN_VAR = ['CLAUDE', 'CODE'].join('_') + '_OAUTH_TOKEN'

/** Every source file under src/ (the census walk). */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) srcFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
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

  // The debug-adapter env builder rides the same base: a marked parent env
  // never reaches the adapter child, while the builder's own overlay lands.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A1b — the raw-env census (every child rides the scrubbed base, or wears the law comment)')
{
  // A child spawned on a raw `...process.env` base bypasses the scrub the
  // module's own docblock claims for "every spawned child process". The few
  // deliberate raw sites (a Mercury-own child that IS the session's
  // continuation, or an own-process env seam that spawns nothing) each wear
  // a `child-env law:` sentence within the three lines above — everything
  // else must ride subprocessEnv(). A new raw site reds this pin.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A2 — the execa wrapper cannot extend over the raw env (extendEnv trap)')
{
  // execa's default is `env = {...process.env, ...envOption}` — so the
  // shared execFileNoThrow wrapper handed every child the raw parent env
  // UNDER whatever the caller passed, and a scrubbed caller env was
  // silently un-scrubbed by the merge. The wrapper must pin
  // extendEnv: false over the scrubbed base.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A3 — the no-env spawn subset that runs foreign/user code, and the kernel env\'s OTEL gap')
{
  // The eval kernel's own scrub (stricter than subprocessEnv: a secrets
  // denylist + suffix law) missed the OTEL_* exporter family — the OTLP
  // header variables are specified to carry bearer credentials, and the
  // subprocessEnv precedent strips the whole prefix from every child.
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

  // The editor family and the interpreter probe spawn user-configured
  // binaries with NO env option — a full raw inherit. Source pins: each
  // call shape spells the scrubbed base.
  const editor = readFileSync(join(ROOT, 'src', 'utils', 'editor.ts'), 'utf-8')
  check('A3 editor.ts: all four editor spawns ride the scrubbed base', (editor.match(/env: subprocessEnv\(\)/g) ?? []).length === 4)
  const bridge = readFileSync(join(ROOT, 'src', 'cli', 'editorBridge.ts'), 'utf-8')
  check('A3 editorBridge.ts: all four CLI calls ride the scrubbed base', (bridge.match(/env: subprocessEnv\(\)/g) ?? []).length === 4)
  const interp = readFileSync(join(ROOT, 'src', 'services', 'eval', 'interpreters.ts'), 'utf-8')
  check('A3 interpreters.ts: the version probe rides the scrubbed base', interp.includes('env: { ...subprocessEnv() }'))
}

// ────────────────────────────────────────────────────────────────────────────
section('§A4 — a secret-bearing prompt never persists onto a schedule (both model doors)')
{
  // The prompt of a schedule PERSISTS on the session record and re-feeds
  // at every fire. ScheduleWakeup refuses a secret-bearing prompt typed
  // (audit-r3); CronCreate — the SAME persistence road — must speak the
  // same law. The marked key is shaped to the detector's anthropic row.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A5 — SATURN\'s capture is WHO, never a token (the schema\'s own law, driven)')
{
  // The derivation builder picks fields EXPLICITLY — an injected detail
  // smuggling secret-shaped excess (a refreshToken value, an accessToken)
  // must never survive into the capture. A future `...detail` spread reds.
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

  // The facts projection carries NO account material at all — a schedule
  // whose account smuggles a mark projects mark-free, on the closed row set.
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

  // Source law pins: the capture stores token EXISTENCE, never bytes; the
  // two persisted schemas stay the closed field sets (a new field reds
  // here for adjudication before it ships).
  const acctSrc = readFileSync(join(ROOT, 'src', 'daemon', 'saturnAccount.ts'), 'utf-8')
  check('A5 refreshable is an existence check on the token, never a copy', acctSrc.includes("refreshable: typeof tokens?.refreshToken === 'string' && tokens.refreshToken.length > 0"))
  const saturnSrc = readFileSync(join(ROOT, 'src', 'daemon', 'saturn.ts'), 'utf-8')
  const iface = (name: string): string => saturnSrc.slice(saturnSrc.indexOf(`export interface ${name} {`), saturnSrc.indexOf('\n}', saturnSrc.indexOf(`export interface ${name} {`)))
  const acctIface = iface('ScheduleAccountV1')
  check('A5 ScheduleAccountV1 spells no secret-shaped field', !/accessToken|refreshToken\??:|apiKey|authorization/i.test(acctIface))
  const heldIface = iface('HeldFireV1')
  check('A5 HeldFireV1 spells the closed hold set (identity comparator, never credential)', heldIface.includes('mismatchIdentity?: string') && !/token|apiKey|authorization/i.test(heldIface))
}

// ────────────────────────────────────────────────────────────────────────────
section('§A6 — a headers object is never spelled whole onto a surface (log, confirmation, error)')
{
  // Two sites spelled MCP headers onto surfaces: the add confirmation
  // printed the whole object (a --header authorization: Bearer … lands in
  // the terminal record verbatim), and the xaa debug log redacted only the
  // literal 'authorization' name (an X-Api-Key value logged clear). One
  // home: describeHeadersRedacted — names ride, credential-named or
  // secret-shaped values mask.
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

  // The census: no source spells a headers object whole any more.
  const needle = /JSON\.stringify\((?:config\.)?headers/
  const offenders: string[] = []
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const body = readFileSync(file, 'utf-8')
    if (needle.test(body)) offenders.push(file.slice(ROOT.length + 1))
  }
  check('A6 zero whole-headers stringify sites in src/', offenders.length === 0, offenders.join(' · '))
}

// ────────────────────────────────────────────────────────────────────────────
section('§R1 — every listening socket binds LOOPBACK-ONLY by construction (the crown row)')
{
  // A token-authed protocol on an exposed bind is a different threat class
  // than loopback. The three baked bridge servers are pinned by their own
  // bind spellings; the Mercury-side listeners are censused — a future
  // .listen that widens the bind reds here.
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

  // The Mercury-side census: every TCP .listen carries a loopback host on
  // the same line (unix sockets, jsonrpc conn.listen pumps, and baked/
  // sample content inside string literals classify by their own spellings).
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
      // The generated/baked sources carry their binds inside one huge
      // string line — pinned above by exact spelling, skipped here.
      if (file.endsWith('.generated.ts') || file.includes(join('skills', 'bundled'))) continue
      offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
    }
  }
  check('R1 zero TCP listeners without a loopback bind on the line', offenders.length === 0, offenders.join(' · '))

  // The persisted shared secrets (the hello tokens) stay 0600 with the
  // umask-proof chmod pin, in the editors' own gitignored-private dirs.
  for (const rel of [join('services', 'unity', 'bridgeToken.ts'), join('services', 'vulcan', 'vulcanToken.ts')]) {
    const body = readFileSync(join(ROOT, 'src', rel), 'utf-8')
    check(`R1 ${rel} writes the token 0600 with the chmod pin`, body.includes('{ mode: 0o600 }') && body.includes('chmodSync(file, 0o600)'))
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('§R2 — no real key ever committed (the fixture sweep, standing)')
{
  // High-confidence key shapes over the TRACKED tree. A fixture value is
  // lawful only when its own line declares itself one (fixture · dummy ·
  // proof · probe · poison · example · fake · test · redacted); a private
  // key block is never lawful. A real key committed anywhere reds this pin
  // — and per the R2 ruling is reported to the lead before anything else.
  const KEY_SHAPES: ReadonlyArray<{ kind: string; re: RegExp }> = [
    { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
    { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { kind: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
    { kind: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  ]
  const FIXTURE_MARKER = /fixture|dummy|proof|probe|poison|example|fake|test|redact|momentum|crewrender/i
  // Values ADJUDICATED synthetic in-lane (patterned bodies, no real
  // material). Exact spellings: an edit re-adjudicates, nothing is masked
  // by file.
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
  // The classifier's own teeth (the tree stays clean; the needle must bite).
  check('R2 classifier: a bare real-shaped key flags', classify('const k = "sk-ant-api03-' + 'A'.repeat(24) + '"') === 'anthropic')
  check('R2 classifier: a self-declared fixture key is lawful', classify("process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'") === null)
  check('R2 classifier: a private key block is NEVER lawful', classify('-----BEGIN RSA PRIVATE KEY----- // fixture') === 'private-key-block')

  const { execFileSync } = await import('node:child_process')
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } })
    .split('\n')
    .filter(f => f.length > 0 && !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|gz|pdf)$/i.test(f))
  const hits: string[] = []
  for (const rel of tracked) {
    // The sweep's own needle strings live here — self-skip, nothing else.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A7 — the secret-prose guard is the DAEMON VALIDATOR\'s (one home; every persisting door inherits)')
{
  // The LM-4 ruling's re-home: prompts and birth openings persist on
  // plain-text records regardless of which door wrote them — the guard
  // lives in the one validator every road passes (the wire set-schedule
  // door, the box add door, the box read-back), and the model-door guards
  // consume the same one spelling.
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

  // The box add/read door inherits through the same validator.
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

  // One spelling: both model-door guards speak the helper's own sentence.
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

// ────────────────────────────────────────────────────────────────────────────
section('§A8 — EVERY spawn passes an explicit env (the product law; an env-less spawn reds)')
{
  // A spawn with no env option inherits the raw parent env whole — the
  // same leak §A1b's spelling census cannot see. The law: every
  // child_process call passes an env (the scrubbed base, or a curated
  // build at a `child-env law:` site). The census parses each file's own
  // child_process import names and demands `env` inside every call's
  // option window.
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
      if (file.includes(join('skills', 'bundled'))) continue // baked content strings
      // The option window is the CALL's own extent: walk to paren-depth
      // zero from the call's open paren (capped at 60 lines).
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

// ────────────────────────────────────────────────────────────────────────────
section('§B — every arm is paired with its release (the class-B lifecycle census)')
{
  const src = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf-8')

  // B1 the ticker: the returned stop clears the interval under an
  // idempotence flag, the interval never overlaps itself, the daemon
  // wires the stop.
  const ticker = src(join('daemon', 'saturnTicker.ts'))
  check('B1 ticker stop clears the interval idempotently', ticker.includes('stopped = true') && ticker.includes('clearInterval(timer)') && ticker.includes('if (running || stopped) return'))
  check('B1 the ticker interval is unref\'d (never holds the process)', ticker.includes('timer.unref?.()'))
  check('B1 the daemon calls the stop at shutdown', src(join('daemon', 'main.ts')).includes('stopSaturnTicker?.()'))

  // B2 the bridge clients: teardown releases heartbeat + every pending
  // timer + every queued timer + the socket; the session singleton closes
  // the old client before replacing it; the baked server closes the old
  // socket on accept-newest.
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

  // B4 the watcher families: dispose/rearm close what they armed and
  // clear their debounce timers.
  const skills = src(join('utils', 'skills', 'skillChangeDetector.ts'))
  check('B4 skill watcher: rearm and dispose both close the old watcher', (skills.match(/watcher\?\.close\(\) \?\? Promise\.resolve\(\)/g) ?? []).length >= 3 && skills.includes('clearTimeout(reloadTimer)'))
  for (const rel of [join('components', 'concourse', 'liveTiles.ts'), join('components', 'concourse', 'workerTranscriptFold.ts'), join('services', 'concourse', 'crossProjectPings.ts')]) {
    const body = src(rel)
    check(`B4 ${rel} pairs its watch with a close`, body.includes('.close()'))
  }

  // B5 the login waits: the device loops re-check cancelled() AFTER every
  // sleep (an abandoned wait dies within one interval, nothing re-arms),
  // and the machine's dispose clears its whole timer registry.
  for (const rel of [join('services', 'providers', 'huggingface', 'huggingfaceLogin.ts'), join('services', 'providers', 'moonshot', 'moonshotLogin.ts')]) {
    const body = src(rel)
    const sleepIdx = body.indexOf('await sleep(')
    const recheck = sleepIdx !== -1 && body.slice(sleepIdx, sleepIdx + 200).includes('cancelled()')
    check(`B5 ${rel} re-checks cancelled() right after the sleep`, recheck)
  }
  const machine = src(join('components', 'mercury-ui', 'screens', 'anthropicLoginModel.ts'))
  check('B5 the login machine clears its timer registry on BOTH reset and dispose', (machine.match(/for \(const handle of timers\) deps\.clearTimer\(handle\)/g) ?? []).length === 2)

  // B7 bounded children: the async git road kills on timeout with an
  // unref\'d timer; the doctor journey probe reaps its owner in finally.
  const worktrees = src(join('daemon', 'concourseWorktrees.ts'))
  check('B7 gitAsync kills the child on timeout, timer unref\'d', worktrees.includes("child.kill('SIGKILL')") && worktrees.includes('timer.unref?.()'))
  check('B7 the doctor journey probe reaps its owner in finally', src(join('utils', 'healthDeepProbes.ts')).includes('await disposeOwner(owner)'))
}

// ────────────────────────────────────────────────────────────────────────────
section('§B4x — two overlapping re-arms leave EXACTLY ONE live watcher (the generation guard, driven through the factory seam)')
{
  // The race: rearmWatchRoots closes the old watcher, AWAITS the close,
  // then arms — two overlapping calls both pass the close, both arm, and
  // the first assignment is orphaned by the second (a live chokidar
  // watcher nothing can ever close). The ruled fix: an injectable
  // watcher-factory seam + a generation guard — the loser closes what it
  // armed. Driven here with a fake factory, cpu-pure.
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
  // Leg A: every candidate exists (a scratch ground with its own
  // .mercury/skills + commands), so each generation arms EXACTLY ONE
  // watcher — the original exactly-one-live law, verbatim.
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

    // Leg B: the project candidates are MISSING (a bare ground), so each
    // generation arms exactly TWO handles — the birth watcher over the
    // nearest existing ancestor plus the main watcher over the home dirs
    // (release-hardening audit rank 28). The leak law is per-generation:
    // after a race exactly the LAST generation's pair is live, every
    // earlier handle closed; dispose closes both.
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

// ────────────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nprove-leak-sweep: ALL GREEN' : `\nprove-leak-sweep: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

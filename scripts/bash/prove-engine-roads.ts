#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { plugin } from 'bun'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type LegName = 'no-bash' | 'off' | 'off-pinned' | 'located'
type LegReport = {
  leg: LegName
  engineBinary: string | null
  plain: { out: string; code: number; session: boolean; scrubbed: readonly string[] }
  monitor: { streamedWhileRunning: boolean; backgrounded: boolean; chunks: string; code: number | null }
  background: { accepted: boolean; out: string; code: number; taskId: string | null; groupLeader: boolean }
  inherit: { out: string; code: number; scrubbed: readonly string[] | null }
  timeout: { autoBackgroundOffered: boolean; code: number; stderr: string }
  cwd: { moved: boolean; keptAfterFailure: boolean; recordsLeft: number }
  crewmate: { code: number; out: string; refusal: string }
  prompt: string
  healthLine: string
}

const LEG_FLAG = '--leg'
const legArg = process.argv.includes(LEG_FLAG) ? (process.argv[process.argv.indexOf(LEG_FLAG) + 1] as LegName) : null
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const q = (path: string): string => `'${path.split("'").join("'\\''")}'`
const SERVED = '${BRUSH_VERSION:-system}'

async function runLeg(leg: LegName): Promise<LegReport> {
  const { exec, getShellCwd, setCwd } = await import('../../src/utils/Shell.ts')
  const engine = await import('../../src/utils/shell/engineSession.ts')
  const road = await import('../../src/utils/shell/windowsShellRoad.ts')
  const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
  road.armWindowsShellRoad()
  const resolution = engine.resolveShellEngine()
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-roads-leg-')))
  const signal = (): AbortSignal => new AbortController().signal
  const bounded = <T>(promise: Promise<T>, ms: number): Promise<T | null> => Promise.race([promise, sleep(ms).then(() => null)])
  const groupLeader = (pid: number | undefined): boolean => {
    if (typeof pid !== 'number' || process.platform === 'win32') return false
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }

  await (await exec('export ROADS_MARK=kept', signal(), 'bash', { timeout: 30_000 })).result
  const plainHandle = await exec(`echo "plain:${SERVED}:\${ROADS_MARK:-none}:\${MERCURY_ENTRYPOINT:-scrubbed}"`, signal(), 'bash', { timeout: 30_000 })
  const plain = await plainHandle.result

  const monitorGate = join(scratch, 'monitor-gate')
  let chunks = ''
  let sawFirstTick!: () => void
  const firstTick = new Promise<boolean>(r => {
    sawFirstTick = () => r(true)
  })
  const monitorHandle = await exec(`echo "tick1:${SERVED}:$SHELL"; while [ ! -f ${q(monitorGate)} ]; do sleep 0.05; done; echo "tick2:${SERVED}"`, signal(), 'bash', {
    preventCwdChanges: true,
    onStdout: chunk => {
      chunks += chunk
      if (chunks.includes('tick1:')) sawFirstTick()
    },
  })
  const monitorBackgrounded = monitorHandle.background('engine-roads-monitor')
  const streamedWhileRunning = (await bounded(firstTick, 20_000)) === true
  writeFileSync(monitorGate, '')
  const monitorResult = await bounded(monitorHandle.result, 20_000)
  await sleep(50)

  const backgroundGate = join(scratch, 'background-gate')
  const backgroundHandle = await exec(`while [ ! -f ${q(backgroundGate)} ]; do sleep 0.05; done; echo "background:${SERVED}:\${ROADS_MARK:-none}:$SHELL"`, signal(), 'bash', { timeout: 30_000, shouldAutoBackground: true, backgroundIntent: true })
  const accepted = backgroundHandle.background('engine-roads-background')
  const backgroundGroupLeader = groupLeader(backgroundHandle.pid)
  writeFileSync(backgroundGate, '')
  const background = await backgroundHandle.result

  const inheritHandle = await exec(`echo "inherit:${SERVED}:\${ROADS_MARK:-none}:\${MERCURY_ENTRYPOINT:-scrubbed}:\${ROADS_SEEDED:-unseeded}:$SHELL"`, signal(), 'bash', { timeout: 30_000, shouldAutoBackground: true, inheritSessionEnv: true })
  const inherit = await inheritHandle.result

  const slowHandle = await exec('sleep 5; echo late', signal(), 'bash', { timeout: 1_000, shouldAutoBackground: true, inheritSessionEnv: true })
  const autoBackgroundOffered = typeof slowHandle.onTimeout === 'function'
  const slow = await slowHandle.result

  const home = getShellCwd()
  const target = realpathSync(mkdtempSync(join(scratch, 'cwd-target-')))
  const other = realpathSync(mkdtempSync(join(scratch, 'cwd-other-')))
  await (await exec(`cd ${q(target)} && echo moved`, signal(), 'bash', { timeout: 30_000, inheritSessionEnv: true })).result
  const moved = getShellCwd() === target
  await (await exec(`cd ${q(other)} && false`, signal(), 'bash', { timeout: 30_000, inheritSessionEnv: true })).result
  const keptAfterFailure = getShellCwd() === target
  setCwd(home)
  const records = (): number => readdirSync(tmpdir()).filter(name => name.startsWith('mercury-cwd-')).length
  for (let i = 0; i < 40 && records() > 0; i++) await sleep(50)

  const crewmate = await (await exec('echo crewmate-ran', signal(), 'bash', { timeout: 10_000, owner: 'agent-engine-roads' })).result

  const report: LegReport = {
    leg,
    engineBinary: resolution.engine === 'brush' ? resolution.binaryPath : null,
    plain: { out: plain.stdout.trim(), code: plain.code, session: engine.engineChildForTest() !== null, scrubbed: plainHandle.scrubbedSessionEnv ?? [] },
    monitor: { streamedWhileRunning, backgrounded: monitorBackgrounded, chunks, code: monitorResult?.code ?? null },
    background: { accepted, out: background.stdout.trim(), code: background.code, taskId: background.backgroundTaskId ?? null, groupLeader: backgroundGroupLeader },
    inherit: { out: inherit.stdout.trim(), code: inherit.code, scrubbed: inheritHandle.scrubbedSessionEnv ?? null },
    timeout: { autoBackgroundOffered, code: slow.code, stderr: slow.stderr },
    cwd: { moved, keptAfterFailure, recordsLeft: records() },
    crewmate: { code: crewmate.code, out: crewmate.stdout.trim(), refusal: crewmate.preSpawnError ?? '' },
    prompt: getSimplePrompt(),
    healthLine: road.describeWindowsShellRoad().line,
  }
  await engine.endEngineSession()
  rmSync(scratch, { recursive: true, force: true })
  return report
}

if (legArg !== null) {
  const report = await runLeg(legArg)
  console.log(`ENGINE-ROADS-LEG ${JSON.stringify(report)}`)
  process.exit(0)
}

for (const name of Object.keys(process.env)) {
  if (name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_DESKTOP_DRIVER'].includes(name)) delete process.env[name]
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'engine-roads-')))
const legEnvBase = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('MERCURY_')) delete env[name]
  return env
}

function runLegProcess(leg: LegName, extra: Record<string, string>): Promise<{ report: LegReport | null; text: string }> {
  const legTmp = realpathSync(mkdtempSync(join(scratchRoot, `${leg}-tmp-`)))
  const env: NodeJS.ProcessEnv = {
    ...legEnvBase(),
    TMPDIR: legTmp,
    MERCURY_TMPDIR: legTmp,
    MERCURY_CONFIG_DIR: realpathSync(mkdtempSync(join(scratchRoot, `${leg}-home-`))),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_ENTRYPOINT: 'cli',
    MERCURY_SHELL_ENGINE_SESSIONS: '1',
    ...extra,
  }
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [import.meta.path, LEG_FLAG, leg], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = text.split('\n').find(l => l.startsWith('ENGINE-ROADS-LEG '))
      resolvePromise({ report: line ? (JSON.parse(line.slice('ENGINE-ROADS-LEG '.length)) as LegReport) : null, text })
    })
  })
}

const servedBy = (out: string): string => out.split(':')[1] ?? ''
const shellOf = (out: string): string => out.split(':').slice(-1)[0] ?? ''

const { resolveBrushPackDir } = await import('../../src/utils/shell/brushPack.ts')
const pack = resolveBrushPackDir()
check('the shell engine pack resolves on this tree (build or fetch it first: bun run scripts/vendor/fetch-brush.ts)', pack.state === 'ok', pack.state === 'ok' ? '' : pack.note)
const VERSION = pack.state === 'ok' ? pack.manifest.version : 'unresolved'

section('§1 the Windows road with no bash.exe (MERCURY_WINDOWS_SHELL_ROAD=no-bash): every Bash path rides the bundled engine')
{
  const envFile = join(scratchRoot, 'session-env.sh')
  writeFileSync(envFile, 'export ROADS_SEEDED=from-env-file\necho seed-noise\necho seed-err >&2\n')
  const { report: r, text } = await runLegProcess('no-bash', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_ENV_FILE: envFile })
  check('the leg ran and reported', r !== null, text.slice(-1500))
  if (r !== null) {
    const engineBinary = r.engineBinary ?? ''
    check('the bundled engine is armed on this road', engineBinary.includes('brush'), JSON.stringify(r.engineBinary))
    check('the plain foreground call rides the engine session, unchanged: the session state persists and the stamps are scrubbed', r.plain.code === 0 && r.plain.out === `plain:${VERSION}:kept:scrubbed` && r.plain.session && r.plain.scrubbed.includes('MERCURY_ENTRYPOINT'), JSON.stringify(r.plain))
    check('a Monitor-shaped call (onStdout, preventCwdChanges) streams its first line while the command is still running', r.monitor.streamedWhileRunning, JSON.stringify(r.monitor))
    check('…and it runs under the engine binary, not a system shell', r.monitor.chunks.includes(`tick1:${VERSION}:${engineBinary}`), JSON.stringify(r.monitor.chunks))
    check('…and it moves to the background the way the Monitor task takes it, then delivers its last line and exits 0', r.monitor.backgrounded && r.monitor.chunks.includes(`tick2:${VERSION}`) && r.monitor.code === 0, JSON.stringify(r.monitor))
    check('a run_in_background call is taken by the background task while it runs', r.background.accepted && r.background.taskId === 'engine-roads-background', JSON.stringify(r.background))
    check('…and returns its output from the engine binary, in a process of its own that does not see the session state', r.background.code === 0 && servedBy(r.background.out) === VERSION && r.background.out === `background:${VERSION}:none:${engineBinary}`, JSON.stringify(r.background))
    check('…and that process leads its own process group (the detached lifetime the tree kill reaches)', process.platform === 'win32' || r.background.groupLeader, JSON.stringify(r.background))
    check('an inherit_session_env call runs under the engine binary with the session stamps handed over', r.inherit.code === 0 && r.inherit.out.startsWith(`inherit:${VERSION}:none:cli:`) && r.inherit.out.endsWith(`:${engineBinary}`) && Array.isArray(r.inherit.scrubbed) && r.inherit.scrubbed.length === 0, JSON.stringify(r.inherit))
    check("…seeded like the session (the session environment script ran in the command's own shell) with the seed's output kept out of the result", r.inherit.out === `inherit:${VERSION}:none:cli:from-env-file:${engineBinary}` && !r.monitor.chunks.includes('seed-') && !r.background.out.includes('seed-') && !r.plain.out.includes('seed-'), JSON.stringify({ inherit: r.inherit.out, monitor: r.monitor.chunks, background: r.background.out }))
    check('a per-command engine call is killed at its timeout (exit 143), never moved to the background — the timeout field\'s engine rule', !r.timeout.autoBackgroundOffered && r.timeout.code === 143 && /timed out/.test(r.timeout.stderr), JSON.stringify(r.timeout))
    check('an env-inheriting cd moves the shell directory through the engine\'s record, a failed one leaves it, and no record file is left behind', r.cwd.moved && r.cwd.keptAfterFailure && r.cwd.recordsLeft === 0, JSON.stringify(r.cwd))
    check("a crewmate's call under a ceiling of 1 is refused, and the way round names the engine process", r.crewmate.code === 1 && /the ceiling is 1/.test(r.crewmate.refusal) && r.crewmate.refusal.includes('run_in_background (its own engine process)'), JSON.stringify(r.crewmate))
    check('the Bash tool description says a run_in_background call still runs in its own engine process', r.prompt.includes('a `run_in_background` call still runs, in its own engine process.') && !r.prompt.includes('in its own system shell'), r.prompt.slice(r.prompt.indexOf('The shell.sessions setting'), r.prompt.indexOf('The shell.sessions setting') + 260))
    check("/health's line names the bundled engine as what the Bash tool runs under", /bundled shell engine at .*brush/.test(r.healthLine) && /runs under Mercury's own bash-compatible engine/.test(r.healthLine), r.healthLine)
  }
}

section('§2 off the Windows road (this host, nothing pinned): the system shell serves all four paths')
{
  const { report: r, text } = await runLegProcess('off', {})
  check('the leg ran and reported', r !== null, text.slice(-1500))
  if (r !== null) {
    check('no engine is armed', r.engineBinary === null)
    check('the plain call is the system shell, a fresh process per call', r.plain.code === 0 && r.plain.out === 'plain:system:none:scrubbed' && !r.plain.session, JSON.stringify(r.plain))
    check('the Monitor-shaped call streams under the system shell', r.monitor.streamedWhileRunning && r.monitor.backgrounded && r.monitor.chunks.includes('tick1:system:') && !r.monitor.chunks.includes('brush') && r.monitor.code === 0, JSON.stringify(r.monitor))
    check('the run_in_background call runs under the system shell', r.background.accepted && r.background.code === 0 && servedBy(r.background.out) === 'system' && !shellOf(r.background.out).includes('brush'), JSON.stringify(r.background))
    check('the inherit_session_env call runs under the system shell with the stamps handed over', r.inherit.code === 0 && r.inherit.out.startsWith('inherit:system:none:cli:') && !shellOf(r.inherit.out).includes('brush'), JSON.stringify(r.inherit))
    check('a system-shell call keeps its timeout-to-background offer', r.timeout.autoBackgroundOffered, JSON.stringify(r.timeout))
    check('the cwd record still moves and keeps the directory', r.cwd.moved && r.cwd.keptAfterFailure && r.cwd.recordsLeft === 0, JSON.stringify(r.cwd))
  }
}

section('§3 off the Windows road with the engine pinned (MERCURY_SHELL_ENGINE=brush): the session serves the plain call, the system shell the other three — byte for byte as before')
{
  const { report: r, text } = await runLegProcess('off-pinned', { MERCURY_SHELL_ENGINE: 'brush' })
  check('the leg ran and reported', r !== null, text.slice(-1500))
  if (r !== null) {
    check('the plain call rides the engine session', r.plain.code === 0 && r.plain.out === `plain:${VERSION}:kept:scrubbed` && r.plain.session, JSON.stringify(r.plain))
    check('the Monitor-shaped, background and inheriting calls stay on the system shell', r.monitor.chunks.includes('tick1:system:') && servedBy(r.background.out) === 'system' && r.inherit.out.startsWith('inherit:system:none:cli:'), JSON.stringify({ monitor: r.monitor.chunks, background: r.background.out, inherit: r.inherit.out }))
    check('the inheriting call keeps its timeout-to-background offer', r.timeout.autoBackgroundOffered, JSON.stringify(r.timeout))
    check("the crewmate refusal's way round still names the system shell", r.crewmate.refusal.includes('run_in_background (its own system shell)'), JSON.stringify(r.crewmate))
    check('the description still says its own system shell', r.prompt.includes('a `run_in_background` call still runs, in its own system shell.'), '')
  }
}

section('§4 the Windows road WITH a bash located (MERCURY_WINDOWS_SHELL_ROAD=locate): the located bash serves the three paths beside the engine')
{
  const located = existsSync('/bin/bash') ? '/bin/bash' : null
  if (located === null) {
    check('a bash stands in for the located Git Bash on this host', false, 'no /bin/bash')
  } else {
    const { report: r, text } = await runLegProcess('located', { MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: located })
    check('the leg ran and reported', r !== null, text.slice(-1500))
    if (r !== null) {
      check('the engine is the road (the Windows default)', (r.engineBinary ?? '').includes('brush') && r.plain.session && r.plain.out === `plain:${VERSION}:kept:scrubbed`, JSON.stringify(r.plain))
      check('the Monitor-shaped, background and inheriting calls run under the located bash', r.monitor.chunks.includes(`tick1:system:${located}`) && r.background.out === `background:system:none:${located}` && r.inherit.out === `inherit:system:none:cli:unseeded:${located}`, JSON.stringify({ monitor: r.monitor.chunks, background: r.background.out, inherit: r.inherit.out }))
      check("…and a crewmate's way round under a ceiling of 1 names that system shell", r.crewmate.refusal.includes('run_in_background (its own system shell)'), JSON.stringify(r.crewmate))
    }
  }
}

section('§5 the source keeps the session road and its three exclusions; the per-command road picks the engine only where no bash.exe was found')
{
  const shell = readFileSync(join(ROOT, 'src/utils/Shell.ts'), 'utf8')
  const engine = readFileSync(join(ROOT, 'src/utils/shell/engineSession.ts'), 'utf8')
  check('the engine session still serves only the plain foreground call', shell.includes("if (shellType === 'bash' && options.onStdout === undefined && options.backgroundIntent !== true && options.inheritSessionEnv !== true) {"))
  check('the per-command road takes the engine provider when the road names an engine binary, else the provider table', shell.includes("const engineBinary = shellType === 'bash' ? perCommandEngineBinary(getInitialSettings().shell?.engine) : null") && shell.includes('const provider = engineBinary === null ? await PROVIDER_TABLE[shellType]() : createEngineCommandProvider(engineBinary)'))
  check('a per-command engine call never auto-backgrounds at its timeout', shell.includes('engineBinary === null && (options.shouldAutoBackground ?? false)'))
  check('the engine binary serves the per-command road only on the Windows road with no bash.exe located', engine.includes('if (!windowsBashAbsent()) return null'))
  check('the engine provider runs the binary with its own flags and names no null device', engine.includes("getSpawnArgs: commandString => [...ENGINE_FLAGS, '-c', commandString]") && !engine.slice(engine.indexOf('export function createEngineCommandProvider'), engine.indexOf('function sessionFor(owner: string)')).includes('/dev/null'))
  const config = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the /config ceiling warning follows the road the same way', config.includes("still runs, in its own ${windowsBashAbsent() ? 'engine process' : 'system shell'})."))
  const runtime = readFileSync(join(ROOT, 'docs/TERMINAL-RUNTIME.md'), 'utf8').replace(/\r\n/g, '\n')
  check('TERMINAL-RUNTIME names which process takes the three calls, the engine itself on a box with no bash.exe', runtime.includes('A call the long-lived process cannot take runs in a process of its own') && runtime.includes('Windows box with no `bash.exe` it is the engine itself') && !runtime.includes('still runs, in its own system shell'))
}

section('§6 the Monitor mailbox delivers the first burst, holds later ticks, and delivers them together at 30 seconds')
{
  const { createWatchMailbox, BURST_WINDOW_MS, DELIVERY_INTERVAL_MS } = await import('../../src/tools/MonitorTool/watchMailbox.ts')
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const delivered: Array<{ at: number; text: string; count: number }> = []
  const mailbox = createWatchMailbox({
    now: () => now,
    wall: () => ({ closed: false }),
    deliver: (text, summary) => { delivered.push({ at: now, text, count: summary.count }) },
    setTimer: (run, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id },
    clearTimer: handle => { timers.delete(handle as number) },
  })
  const advance = (ms: number): void => {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = until
  }
  mailbox.push('tick1')
  advance(BURST_WINDOW_MS)
  check('the first tick is delivered at the end of its initial 200 ms burst', delivered.length === 1 && delivered[0]?.at === 200 && delivered[0]?.text === 'tick1')
  mailbox.push('tick2')
  advance(BURST_WINDOW_MS)
  mailbox.push('tick3')
  advance(BURST_WINDOW_MS)
  check('ticks two and three do not wake the model individually', delivered.length === 1)
  advance(DELIVERY_INTERVAL_MS - 2 * BURST_WINDOW_MS - 1)
  check('the later ticks remain held until the 30 second delivery window', DELIVERY_INTERVAL_MS === 30_000 && delivered.length === 1)
  advance(1)
  check('both held ticks arrive together at the next delivery window', delivered.length === 2 && delivered[1]?.at === 30_200 && delivered[1]?.text === 'tick2\ntick3' && delivered[1]?.count === 2)
  mailbox.dispose()
}

section('§7 the built bundle through the seam: a scripted model calls the Bash tool plain, inheriting and in the background, then the Monitor tool')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs is present (build first: bun run build.ts)', false)
  } else {
    const { seedScratchHome, startScriptedFixture } = await import('../lib/scriptedTurn.ts')
    const { childEnv, MODEL, NODE } = await import('../daemon/dupline-world.ts')
    const ASK = 'walk the Bash roads and the Monitor road on this shell'
    const script = (req: { ask: string; step: number }) => {
      if (req.ask.trim() !== ASK) return [{ type: 'text' as const, text: 'ok' }]
      if (req.step === 0) return [{ type: 'tool_use' as const, name: 'Bash', input: { command: `export ROADS_MARK=kept; echo "plain:${SERVED}"`, description: 'plain call' } }]
      if (req.step === 1) return [{ type: 'tool_use' as const, name: 'Bash', input: { command: `echo "inherit:${SERVED}:\${ROADS_MARK:-none}"`, inherit_session_env: true, description: 'inheriting call' } }]
      if (req.step === 2) return [{ type: 'tool_use' as const, name: 'Bash', input: { command: `echo "background:${SERVED}:\${ROADS_MARK:-none}"`, run_in_background: true, description: 'background call' } }]
      if (req.step === 3) return [{ type: 'tool_use' as const, name: 'ToolSearch', input: { query: 'select:Monitor' } }]
      if (req.step === 4) return [{ type: 'tool_use' as const, name: 'Monitor', input: { command: `printf '%s\\n' "tick1:${SERVED}" "tick2:${SERVED}" "tick3:${SERVED}"`, description: 'engine roads ticks', timeout_ms: 60_000 } }]
      if (req.step === 5) return [{ type: 'tool_use' as const, name: 'Bash', input: { command: `sleep 2; echo "after:${SERVED}:\${ROADS_MARK:-none}"`, description: 'let the watch speak' } }]
      return [{ type: 'text' as const, text: 'done' }]
    }
    const drive = async (label: string, seam: Record<string, string>) => {
      const home = join(scratchRoot, `${label}-run-home`)
      const cwd = join(scratchRoot, `${label}-run-work`)
      seedScratchHome(home, cwd)
      const fixture = await startScriptedFixture(script)
      const env: NodeJS.ProcessEnv = childEnv(home, Number(new URL(fixture.base).port))
      for (const name of ['MERCURY_SHELL_ENGINE', 'MERCURY_SHELL_ENGINE_SESSIONS', 'MERCURY_WINDOWS_SHELL_ROAD', 'MERCURY_GIT_BASH_PATH', 'MERCURY_SHELL_PREFIX', 'MERCURY_ENV_FILE']) delete env[name]
      Object.assign(env, seam, { MERCURY_TMPDIR: realpathSync(mkdtempSync(join(scratchRoot, `${label}-run-tmp-`))) })
      const run = await new Promise<{ code: number | null; out: string }>(resolvePromise => {
        const child = spawn(NODE, [DIST, 'run', ASK, '--format', 'rows', '--mode', 'sovereign', '--model', MODEL], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
        })
        child.stderr!.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
        child.on('close', code => {
          clearTimeout(timer)
          resolvePromise({ code, out })
        })
      })
      await fixture.close()
      const ours = fixture.requests.filter(r => r.ask.trim() === ASK)
      const resultAt = (step: number): string => ours.find(r => r.step === step)?.results[0]?.text ?? ''
      const startLine = resultAt(3).split('\n').find(line => line.startsWith('Running in the background')) ?? ''
      const outputPath = /Output: (.+?)\.(?: |$)/.exec(startLine)?.[1] ?? ''
      const backgroundOutput = outputPath !== '' && existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : ''
      const later = ours.filter(r => r.step >= 5).flatMap(r => r.allTexts).join('\n')
      return { run, tools: ours[0]?.toolNames ?? [], plain: resultAt(1), inherit: resultAt(2), startLine, backgroundOutput, monitorStart: resultAt(5), after: resultAt(6), later }
    }
    const roadRun = await drive('road', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash' })
    const evidence = (d: Awaited<ReturnType<typeof drive>>): string => JSON.stringify({ code: d.run.code, tools: d.tools.length, plain: d.plain, inherit: d.inherit, start: d.startLine, background: d.backgroundOutput, monitor: d.monitorStart.slice(0, 120), after: d.after, later: d.later.slice(0, 600), tail: d.run.out.slice(-600) })
    check('road: the run completed with the Bash tool on the roster and no bash.exe', roadRun.run.code === 0 && roadRun.tools.includes('Bash'), evidence(roadRun))
    check('road: the plain Bash call ran in the engine session', roadRun.plain.includes(`plain:${VERSION}`), evidence(roadRun))
    check('road: the inherit_session_env Bash call ran under the engine, in a process of its own', roadRun.inherit.includes(`inherit:${VERSION}:none`), evidence(roadRun))
    check('road: the run_in_background Bash call started in the background and its output file holds the engine\'s answer', roadRun.startLine !== '' && roadRun.backgroundOutput === `background:${VERSION}:none`, evidence(roadRun))
    check('road: the Monitor tool started, and its events came from the engine', roadRun.monitorStart.startsWith('Monitor started (task ') && roadRun.later.includes(`tick1:${VERSION}`) && roadRun.later.includes(`tick3:${VERSION}`), evidence(roadRun))
    check('road: the session kept its state across the other roads', roadRun.after.includes(`after:${VERSION}:kept`), evidence(roadRun))
    const controlRun = await drive('control', {})
    check('control (off the road): the run completed', controlRun.run.code === 0 && controlRun.tools.includes('Bash'), evidence(controlRun))
    check('control: the system shell answered all four, the Monitor included', controlRun.plain.includes('plain:system') && controlRun.inherit.includes('inherit:system:none') && controlRun.backgroundOutput === 'background:system:none' && controlRun.later.includes('tick1:system') && controlRun.after.includes('after:system:none'), evidence(controlRun))
  }
}

rmSync(scratchRoot, { recursive: true, force: true })
rmSync(proofHome, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ ENGINE ROADS PROOF PASS' : `\n❌ ENGINE ROADS PROOF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

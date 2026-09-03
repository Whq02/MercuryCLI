#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-bash-tool-seams.ts — the Bash tool's execution seams,
//  LIVE through the one entry the tool uses (src/utils/Shell.ts exec) and
//  once more on the shipped bundle under node.
//
//  §1 THE SANDBOX LAW. With sandbox.enabled the OS sandbox (macOS seatbelt /
//     Linux bubblewrap) wraps the shell the tool spawns. The provider writes
//     its cwd-tracking record to the product temp root (/tmp/mercury-<uid>/,
//     the directory the executor also hands the child as TMPDIR); that root
//     must be in the sandbox's allow-write set, or every sandboxed command
//     ends on the record's refusal — status 1, "Operation not permitted",
//     and no cd ever propagates — while the user command itself ran. Pinned
//     here: a sandboxed command keeps its own status, a cd propagates, a
//     write inside the session directory lands, a write outside the
//     allow-write set is still refused (the boundary stands), and a child or
//     background process the command leaves behind stays inside it. Then the
//     same law on the ARTIFACT: dist/mercury.mjs under node in print mode,
//     the model played by the fixture server, the tool results read off the
//     wire. Skips honestly where the platform cannot sandbox.
//
//  Run: ~/.bun/bin/bun run scripts/bash/prove-bash-tool-seams.ts
// ============================================================================
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

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
// The bash control: the seam's contract is bash's.
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' Bash tool seams — live through exec, then on the artifact')
console.log('============================================================')

// The hermetic home's settings turn the sandbox on BEFORE the settings
// layer loads; the allow-write set is the session directory by the
// adapter's own rule, so no path list is needed.
const HOME = process.env.MERCURY_CONFIG_DIR as string
mkdirSync(HOME, { recursive: true })
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }, null, 2))

const { exec, setCwd } = await import('../../src/utils/Shell.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
const { shouldUseSandbox } = await import('../../src/tools/BashTool/shouldUseSandbox.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-')))
const PROJECT = join(SCRATCH, 'project')
const OUTSIDE = join(SCRATCH, 'outside')
mkdirSync(join(PROJECT, 'sub'), { recursive: true })
mkdirSync(OUTSIDE)
// The allow-write set is the PROCESS working directory (the adapter hands
// the runtime a literal single dot), the way the product's process starts
// in the session directory: the proof moves both.
process.chdir(PROJECT)
setCwd(PROJECT)

interface Outcome {
  code: number
  out: string
  stderr: string
  cwd: string
}
async function run(command: string, sandboxed: boolean): Promise<Outcome> {
  const handle = await exec(command, new AbortController().signal, 'bash', {
    timeout: 20_000,
    shouldUseSandbox: sandboxed,
    shouldAutoBackground: false,
  })
  const result = await handle.result
  return { code: result.code, out: result.stdout, stderr: result.stderr, cwd: getCwd() }
}

section('§1 the sandbox law — through exec')
const platformOk = process.platform === 'darwin' || process.platform === 'linux'
const enabledInSettings = SandboxManager.isSandboxEnabledInSettings()
check('the hermetic home turned the sandbox on in settings', enabledInSettings)
const unavailable = SandboxManager.getSandboxUnavailableReason()
const ready = platformOk && enabledInSettings && unavailable === null && SandboxManager.isSandboxingEnabled()
if (!ready) {
  console.log(`  [SKIP] live sandbox — platform ${process.platform}, enabled ${enabledInSettings}, reason ${unavailable ?? 'none'}: the boundary cannot be exercised on this machine`)
} else {
  check('shouldUseSandbox says yes for a plain command', shouldUseSandbox({ command: 'ls' }) === true)
  check('shouldUseSandbox honours the explicit override', shouldUseSandbox({ command: 'ls', dangerouslyDisableSandbox: true }) === false)
  const doctor = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the doctor names the mechanism (seatbelt / bubblewrap)', /seatbelt\/bubblewrap/.test(doctor))
  await SandboxManager.initialize()
  const writeSet = SandboxManager.getFsWriteConfig() as { allowWrite?: string[] }
  note(`allow-write set: ${JSON.stringify(writeSet.allowWrite ?? writeSet)}`)

  const echo = await run('echo sandboxed-ok', true)
  check('a sandboxed command runs and keeps its own status (the cwd record landed inside the boundary)', echo.code === 0 && /^sandboxed-ok\s*$/.test(echo.out), `code ${echo.code} ${JSON.stringify(echo.out.slice(0, 160))}`)
  const moved = await run(`cd "${PROJECT}/sub" && echo moved`, true)
  check('a cd inside a sandboxed command propagates to the session', moved.code === 0 && moved.cwd === join(PROJECT, 'sub'), `code ${moved.code} cwd ${moved.cwd} ${JSON.stringify(moved.out.slice(0, 120))}`)
  await run(`cd "${PROJECT}"`, true)
  const inside = await run(`echo in > "${PROJECT}/in.txt"`, true)
  check('a write inside the session directory lands with status 0', inside.code === 0 && existsSync(join(PROJECT, 'in.txt')), `code ${inside.code} ${JSON.stringify(inside.out.slice(0, 120))}`)
  // Observed, not pinned: the shell snapshot sourced ahead of the command
  // restores the login shell's own TMPDIR over the sandbox's, so mktemp
  // lands outside the allow-write set — a seam of its own, recorded here.
  const temp = await run('f=$(mktemp) && echo "$f" && rm -f "$f"; echo "TMPDIR=$TMPDIR"', true)
  note(`mktemp under the sandbox: code ${temp.code} ${JSON.stringify(temp.out.trim().slice(0, 160))}`)
  const outside = await run(`echo out > "${OUTSIDE}/out.txt"`, true)
  check('a write outside the allow-write set is refused and the file never appears', outside.code !== 0 && !existsSync(join(OUTSIDE, 'out.txt')), `code ${outside.code} ${JSON.stringify(outside.out.slice(0, 160))}`)
  note(`refusal text: ${JSON.stringify((outside.out + outside.stderr).trim().slice(0, 160))}`)
  const child = await run(`sh -c 'echo child > "${OUTSIDE}/child.txt"'; echo rc=$?`, true)
  check('a child process of the command is inside the boundary too', !existsSync(join(OUTSIDE, 'child.txt')) && /rc=[1-9]/.test(child.out), JSON.stringify(child.out.slice(0, 160)))
  await run(`(sleep 0.4; echo late > "${OUTSIDE}/late.txt") >/dev/null 2>&1 &`, true)
  await new Promise(resolveWait => setTimeout(resolveWait, 1200))
  check('a process left running in the background stays inside the boundary', !existsSync(join(OUTSIDE, 'late.txt')))
  const control = await run(`echo control > "${OUTSIDE}/control.txt"`, false)
  check('an unsandboxed call writes outside (the control: the sandbox is what refuses)', control.code === 0 && existsSync(join(OUTSIDE, 'control.txt')), `code ${control.code}`)
  const again = await run(`echo again > "${OUTSIDE}/again.txt"`, true)
  check('the next sandboxed call is refused again (the policy is the call\'s)', again.code !== 0 && !existsSync(join(OUTSIDE, 'again.txt')), `code ${again.code}`)
  try {
    SandboxManager.reset()
  } catch {
    // a reset failure only affects this process's teardown
  }
}

// ── the plain seams (no sandbox) ─────────────────────────────────────────────
interface Plain {
  code: number
  out: string
  stderr: string
  interrupted: boolean
  ms: number
  cwd: string
}
async function plain(command: string, opts: { timeout?: number } = {}): Promise<Plain> {
  const started = Date.now()
  const handle = await exec(command, new AbortController().signal, 'bash', {
    timeout: opts.timeout ?? 20_000,
    shouldUseSandbox: false,
    shouldAutoBackground: false,
  })
  const result = await handle.result
  return { code: result.code, out: result.stdout, stderr: result.stderr, interrupted: result.interrupted, ms: Date.now() - started, cwd: getCwd() }
}
const trimmed = (p: Plain): string => p.out.trimEnd()

section('§2 a pipe keeps the special parameters and ANSI-C quoting')
{
  const { rearrangePipeCommand } = await import('../../src/utils/bash/bashPipeCommand.ts')
  const status = await plain('false | true; echo "$?"')
  check('`false | true; echo "$?"` prints the status, not the text $?', status.code === 0 && trimmed(status) === '0', JSON.stringify(status.out.slice(0, 80)))
  const rc = await plain('cat | head -1; echo "rc=$?"')
  check('`cat | head -1; echo "rc=$?"` expands $? after the pipeline', rc.code === 0 && trimmed(rc) === 'rc=0', JSON.stringify(rc.out.slice(0, 80)))
  const pid = await plain('echo "$$" | cat')
  check('`echo "$$" | cat` prints the shell pid', /^\d+$/.test(trimmed(pid)), JSON.stringify(pid.out.slice(0, 80)))
  const positional = await plain(`sh -c 'echo "$1-$#"' _ one two | cat`)
  check('positional parameters survive a pipe', trimmed(positional) === 'one-2', JSON.stringify(positional.out.slice(0, 80)))
  const ansi = await plain(`printf '%s' $'a\\tb' | cat`)
  check("ANSI-C quoting in a piped command carries the tab byte", ansi.out === 'a\tb', JSON.stringify(ansi.out.slice(0, 80)))
  const count = await plain(`printf '%s' $'a\\tb' | wc -c | tr -d ' '`)
  check('…and counts three bytes', trimmed(count) === '3', JSON.stringify(count.out.slice(0, 80)))
  const named = await plain('X=1; echo "$X" | cat')
  check('a named variable in a piped command still expands (the whole-command form)', trimmed(named) === '1', JSON.stringify(named.out.slice(0, 80)))
  const plainPipe = await plain('printf "a\\nb\\n" | head -1')
  check('a pipeline without parameters still works', trimmed(plainPipe) === 'a', JSON.stringify(plainPipe.out.slice(0, 80)))
  check('the rearrangement takes the whole-command form for a special parameter', rearrangePipeCommand('false | true; echo "$?"').endsWith(" < /dev/null") && rearrangePipeCommand('false | true; echo "$?"').includes('"$?"'), rearrangePipeCommand('false | true; echo "$?"'))
  check('…and for ANSI-C quoting', rearrangePipeCommand(`printf '%s' $'a\\tb' | cat`).includes(`$'a\\tb'`), rearrangePipeCommand(`printf '%s' $'a\\tb' | cat`))
  check('…while a parameter-free pipeline is still rearranged onto its first stage', /^'ls < \/dev\/null \| head -1'$/.test(rearrangePipeCommand('ls | head -1')), rearrangePipeCommand('ls | head -1'))
}

section('§1b the sandbox law — the artifact under node')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!ready) {
  console.log('  [SKIP] no live sandbox on this machine')
} else if (!existsSync(DIST) || !nodeBin) {
  console.log(`  [SKIP] ${existsSync(DIST) ? 'no node binary on PATH' : 'dist/mercury.mjs absent — build first (the gate prebuilds)'}`)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-cwd-')))
  const away = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-away-')))
  mkdirSync(join(cwd, 'sub'))
  const configDir = join(home, '.mercury')
  seedFirstRun(configDir, [cwd])
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }, null, 2))
  const MODEL = 'claude-opus-4-8'
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: `cd "${cwd}/sub" && echo moved`, description: 'cd inside the sandbox' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `pwd && echo in > "${cwd}/in.txt" && echo written`, description: 'read the directory, write inside' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `echo out > "${away}/out.txt"`, description: 'write outside' }, whenModel: MODEL },
    { kind: 'text', text: 'sandbox-probe: done', whenModel: MODEL },
  ]
  const fixture = await startFixtureApi(turns)
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    SHELL: '/bin/bash',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_VERIFY_EVIDENCE: '0',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  }
  const outcome = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn(nodeBin, [DIST, '-p', 'sandbox-probe: run the three', '--model', MODEL, '--dangerously-skip-permissions'], { cwd, env, detached: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const deadline = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        // already gone
      }
    }, 90_000)
    child.on('close', exit => {
      clearTimeout(deadline)
      resolveRun({ exit, stdout, stderr })
    })
  })
  await fixture.close()
  interface Seen {
    text: string
    isError: boolean
  }
  const results: Seen[] = []
  for (const request of fixture.messageRequests()) {
    const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? []
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
        if (block.type !== 'tool_result') continue
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
        if (results.length < 3 && !results.some(r => r.text === text && r.isError === (block.is_error === true))) results.push({ text, isError: block.is_error === true })
      }
    }
  }
  note(`print mode exit ${outcome.exit}; ${fixture.messageRequests().length} model requests; stdout ${JSON.stringify(outcome.stdout.trim().slice(0, 80))}`)
  check('the artifact ran the three calls and closed the turn', outcome.exit === 0 && /sandbox-probe: done/.test(outcome.stdout), `exit ${outcome.exit} ${JSON.stringify(outcome.stderr.slice(-300))}`)
  check('the artifact showed the model three tool results', results.length === 3, results.map(r => `${r.isError ? 'ERR' : 'ok'}:${JSON.stringify(r.text.slice(0, 60))}`).join(' '))
  const [first, second, third] = results
  check('artifact: a sandboxed cd keeps its status and its text', first !== undefined && !first.isError && /moved/.test(first.text) && !/Operation not permitted/.test(first.text), JSON.stringify(first?.text.slice(0, 160)))
  check('artifact: the cd propagated and a write inside the session directory landed', second !== undefined && !second.isError && second.text.trim().startsWith(join(cwd, 'sub')) && /written/.test(second.text) && existsSync(join(cwd, 'in.txt')), JSON.stringify(second?.text.slice(0, 160)))
  check('artifact: a write outside the allow-write set is still refused', third !== undefined && third.isError && /Operation not permitted|denied/i.test(third.text) && !existsSync(join(away, 'out.txt')), JSON.stringify(third?.text.slice(0, 160)))
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  rmSync(away, { recursive: true, force: true })
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL BASH TOOL SEAM PROOFS PASS')
else console.log(` ❌ ${failures} BASH TOOL SEAM CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

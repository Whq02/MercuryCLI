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
import { dirname, join, posix, resolve } from 'node:path'
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
const { getMercuryTempDirName } = await import('../../src/utils/permissions/filesystem.ts')
/** The product temp root the executor hands a sandboxed command (POSIX form, unresolved). */
const tempRoot = posix.join(process.env.MERCURY_TMPDIR || '/tmp', getMercuryTempDirName())

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
  // The child's temp directory is the product temp root the executor hands
  // the provider, exported inside the chain so the sandbox wrapper's own
  // TMPDIR prefix (a directory nothing creates) cannot replace it: mktemp
  // lands inside the allow-write set.
  const tempVar = await run('echo "$TMPDIR"', true)
  check("the sandboxed child's TMPDIR is the product temp root", tempVar.code === 0 && tempVar.out.trim() === tempRoot, `${JSON.stringify(tempVar.out.trim())} vs ${tempRoot}`)
  const temp = await run('f=$(mktemp "$TMPDIR/probe.XXXXXX") && echo "$f" && rm -f "$f"', true)
  check('a temp file made under $TMPDIR succeeds inside the sandbox', temp.code === 0 && temp.out.trim().startsWith(`${tempRoot}/probe.`), `code ${temp.code} ${JSON.stringify(temp.out.trim().slice(0, 160))}`)
  // The bare form is the platform's: macOS mktemp prefers the Darwin
  // per-user temp directory to TMPDIR (TMPDIR is its fallback), so a bare
  // mktemp under the sandbox lands wherever that directory is — observed.
  const bare = await run('f=$(mktemp) && echo "$f" && rm -f "$f"', true)
  note(`bare mktemp under the sandbox: code ${bare.code} ${JSON.stringify(bare.out.trim().slice(0, 160))}`)
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
  const ansiForm = rearrangePipeCommand(`printf '%s' $'a\\tb' | cat`)
  check('…and for ANSI-C quoting (the original text, single-quoted whole, the redirect outside)', ansiForm.startsWith("'") && ansiForm.endsWith("' < /dev/null") && ansiForm.includes('a\\tb') && !ansiForm.includes('< /dev/null |'), ansiForm)
  check('…while a parameter-free pipeline is still rearranged onto its first stage', /^'ls < \/dev\/null \| head -1'$/.test(rearrangePipeCommand('ls | head -1')), rearrangePipeCommand('ls | head -1'))
}

section('§3 a here-string feeds stdin')
{
  const { hasStdinRedirect, shouldAddStdinRedirect } = await import('../../src/utils/bash/shellQuoting.ts')
  const here = await plain(`cat <<< 'here string'`)
  check("`cat <<< 'here string'` reads the here-string", here.code === 0 && trimmed(here) === 'here string', JSON.stringify(here.out.slice(0, 80)))
  const piped = await plain(`cat <<< 'here' | tr a-z A-Z`)
  check('a here-string feeding a pipeline', trimmed(piped) === 'HERE', JSON.stringify(piped.out.slice(0, 80)))
  const late = await plain(`echo first; cat <<< 'second'`)
  check('a here-string after another command', trimmed(late) === 'first\nsecond', JSON.stringify(late.out.slice(0, 80)))
  const shift = await plain('echo $((1<<2))')
  check('an arithmetic shift is not mistaken for a here-string or a heredoc', trimmed(shift) === '4', JSON.stringify(shift.out.slice(0, 80)))
  check('the quoting owner adds no stdin redirect for a here-string', shouldAddStdinRedirect("cat <<< 'x'") === false)
  check('…nor for a heredoc', shouldAddStdinRedirect('cat <<EOF\nx\nEOF') === false)
  check('…nor when the command redirects stdin itself', shouldAddStdinRedirect('cat < in.txt') === false && hasStdinRedirect('cat < in.txt'))
  check('…and still adds one for a plain command', shouldAddStdinRedirect('cat') === true)
  const bare = await plain('cat')
  check('a bare stdin reader still meets EOF at once', bare.code === 0 && bare.out === '' && bare.ms < 5000, `${bare.ms}ms ${JSON.stringify(bare.out.slice(0, 40))}`)
}

section("§4 the cwd record never replaces the command's status")
{
  const gone = await plain(`mkdir -p "${SCRATCH}/gone" && cd "${SCRATCH}/gone" && rm -rf "${SCRATCH}/gone"; echo done`)
  check('a command that deletes its own directory keeps its status and prints its text', gone.code === 0 && trimmed(gone) === 'done', `code ${gone.code} ${JSON.stringify(gone.out.slice(0, 120))}`)
  check('…and the session stays in an existing directory', existsSync(gone.cwd) && gone.cwd === PROJECT, gone.cwd)
  const failing = await plain('echo before; exit 3')
  check('a failing command keeps its own status', failing.code === 3 && trimmed(failing) === 'before', `code ${failing.code}`)
  const moved = await plain(`cd "${PROJECT}/sub" && echo moved`)
  check('a successful cd is still recorded', moved.code === 0 && moved.cwd === join(PROJECT, 'sub'), moved.cwd)
  const back = await plain(`cd "${PROJECT}"`)
  check('…and back', back.cwd === PROJECT, back.cwd)
  const provider = readFileSync(join(ROOT, 'src', 'utils', 'shell', 'bashProvider.ts'), 'utf8')
  check('the record step is grouped with || true on the POSIX leg', /\{ pwd -P >\| \$\{quote\(\[cwdFileInShell\]\)\} 2>\/dev\/null \|\| true; \}/.test(provider))
}

section('§5 the timed-out note reaches the result')
{
  const killed = await plain('sleep 3', { timeout: 400 })
  check('a command past its timeout is killed (143) with the note on the result', killed.code === 143 && !killed.interrupted && /Command timed out after/.test(killed.stderr) && killed.ms < 4000, `code ${killed.code} interrupted ${killed.interrupted} stderr ${JSON.stringify(killed.stderr.slice(0, 80))} ${killed.ms}ms`)
  const tool = readFileSync(join(ROOT, 'src', 'tools', 'BashTool', 'BashTool.tsx'), 'utf8')
  check("the tool folds the result's note into the text the model reads (the error path throws that text)", /accumulator\.append\(result\.stderr\.trimEnd\(\) \+ '\\n'\)/.test(tool))
}

section("§6 the sandbox auto-allow keeps the model's whole input")
if (!ready) {
  console.log('  [SKIP] no live sandbox on this machine — the auto-allow road is not taken')
} else {
  const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const input = { command: 'sleep 30', timeout: 3000, description: 'a sleep', run_in_background: false }
  const verdict = await bashToolHasPermission(input, getEmptyToolPermissionContext())
  const updated = ((verdict as { updatedInput?: Record<string, unknown> }).updatedInput ?? {}) as Record<string, unknown>
  const reason = (verdict as { decisionReason?: { reason?: string } }).decisionReason?.reason ?? ''
  check('a sandboxed command is auto-allowed by the sandbox road', verdict.behavior === 'allow' && reason === 'Auto-allowed with sandbox', `${verdict.behavior} ${reason}`)
  check("…and the allow carries the model's timeout, description and background flag", updated.timeout === 3000 && updated.description === 'a sleep' && updated.run_in_background === false && updated.command === 'sleep 30', JSON.stringify(updated))
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
    // The model's own timeout: with the sandbox auto-allow carrying the whole
    // input, the sleep is stopped at three seconds.
    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 30', timeout: 3000, description: 'a command past its timeout' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: 't=$(mktemp "$TMPDIR/probe.XXXXXX") && echo "$t" && rm -f "$t" && echo "TMPDIR=$TMPDIR"', description: 'a temp file under the sandbox' }, whenModel: MODEL },
    { kind: 'text', text: 'sandbox-probe: done', whenModel: MODEL },
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
  const startedAt = Date.now()
  const outcome = await new Promise<{ exit: number | null; stdout: string; stderr: string; ms: number }>(resolveRun => {
    const child = spawn(nodeBin, [DIST, '-p', 'sandbox-probe: run the four', '--model', MODEL, '--dangerously-skip-permissions'], { cwd, env, detached: true })
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
      resolveRun({ exit, stdout, stderr, ms: Date.now() - startedAt })
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
        if (results.length < 5 && !results.some(r => r.text === text && r.isError === (block.is_error === true))) results.push({ text, isError: block.is_error === true })
      }
    }
  }
  note(`print mode exit ${outcome.exit} after ${outcome.ms}ms; ${fixture.messageRequests().length} model requests; stdout ${JSON.stringify(outcome.stdout.trim().slice(0, 80))}`)
  for (const [index, request] of fixture.messageRequests().entries()) {
    const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? []
    const last = messages[messages.length - 1]
    const blocks = Array.isArray(last?.content) ? (last?.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) : []
    const result = blocks.find(b => b.type === 'tool_result')
    if (result) note(`request ${index + 1} carried a tool result${result.is_error ? ' (error)' : ''}: ${JSON.stringify(typeof result.content === 'string' ? result.content.slice(0, 120) : JSON.stringify(result.content).slice(0, 120))}`)
  }
  check('the artifact ran the five calls and closed the turn', outcome.exit === 0 && /sandbox-probe: done/.test(outcome.stdout), `exit ${outcome.exit} ${JSON.stringify(outcome.stderr.slice(-300))}`)
  check('the artifact showed the model five tool results', results.length === 5, results.map(r => `${r.isError ? 'ERR' : 'ok'}:${JSON.stringify(r.text.slice(0, 60))}`).join(' '))
  const [first, second, third, fourth, fifth] = results
  check("artifact: a temp file under $TMPDIR lands inside the product temp root and the child's TMPDIR reads it", fifth !== undefined && !fifth.isError && fifth.text.trim().startsWith(`${tempRoot}/probe.`) && fifth.text.includes(`TMPDIR=${tempRoot}`), JSON.stringify(fifth?.text.slice(0, 160)))
  check("artifact: the model's timeout is honoured under the sandbox — the sleep is stopped at three seconds with the note", fourth !== undefined && /Command timed out after 3s/.test(fourth.text) && outcome.ms < 20_000, `${outcome.ms}ms ${JSON.stringify(fourth?.text.slice(0, 160))}`)
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

#!/usr/bin/env bun

import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
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

if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const shellSpelling = async (native: string): Promise<string> => {
  if (process.platform !== 'win32') return native
  const { locateGitBash } = await import('../../src/utils/windowsPaths.ts')
  const located = locateGitBash()
  if (!('path' in located)) return native
  try {
    return execFileSync(located.path, ['-c', 'cygpath -u -- "$1"', '_', native], { encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return native
  }
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' Bash tool seams — live through exec, then on the artifact')
console.log('============================================================')

const HOME = process.env.MERCURY_CONFIG_DIR as string
mkdirSync(HOME, { recursive: true })
writeFileSync(join(HOME, 'settings.json'), '{}\n')

const { exec, setCwd, getShellCwd } = await import('../../src/utils/Shell.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-')))
const PROJECT = join(SCRATCH, 'project')
mkdirSync(join(PROJECT, 'sub'), { recursive: true })

process.chdir(PROJECT)
setCwd(PROJECT)
setOriginalCwd(PROJECT)

interface Outcome {
  code: number
  out: string
  stderr: string
  cwd: string
}
async function run(command: string): Promise<Outcome> {
  const handle = await exec(command, new AbortController().signal, 'bash', {
    timeout: 20_000,
    shouldAutoBackground: false,
  })
  const result = await handle.result
  return { code: result.code, out: result.stdout, stderr: result.stderr, cwd: getCwd(), shellCwd: getShellCwd() }
}

{
  const probe = await run('echo "${BRUSH_VERSION:-system}"')
  const answered = probe.out.trim()
  note(`the shell that answered: ${answered === 'system' ? 'the system shell' : `brush ${answered}`}`)
}

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
    shouldAutoBackground: false,
  })
  const result = await handle.result
  return { code: result.code, out: result.stdout, stderr: result.stderr, interrupted: result.interrupted, ms: Date.now() - started, cwd: getCwd(), shellCwd: getShellCwd() }
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
  check('a parameter-free pipeline preserves its original program under the input redirect', rearrangePipeCommand('ls | head -1') === "'ls | head -1' < /dev/null", rearrangePipeCommand('ls | head -1'))
}

section('§2b a piped command keeps its quoted glob words')
{
  const { rearrangePipeCommand } = await import('../../src/utils/bash/bashPipeCommand.ts')
  const copyForm = rearrangePipeCommand(`cp "/t/a b&c/"*.m4a "/t/out/" && find "/t/out" -name '*.m4a' | wc -l`)
  check('a quoted path holding a space and an ampersand before a glob keeps the model\'s bytes', copyForm.includes('"/t/a b&c/"*.m4a') && copyForm.endsWith("' < /dev/null") && !copyForm.includes('< /dev/null |'), copyForm)
  const listForm = rearrangePipeCommand('ls "/tmp/a b/"*.txt | head -1')
  check('…and a quoted directory before a glob is never re-emitted bare', listForm.includes('"/tmp/a b/"*.txt') && listForm.endsWith("' < /dev/null"), listForm)
  const bareGlob = rearrangePipeCommand('ls /tmp/a/*.txt | head -1')
  check('…and a bare glob word takes the same whole-command form', bareGlob === `'ls /tmp/a/*.txt | head -1' < /dev/null`, bareGlob)
  const globDir = join(SCRATCH, 'a b&c')
  const globOut = join(SCRATCH, 'glob-out')
  mkdirSync(globDir, { recursive: true })
  mkdirSync(globOut, { recursive: true })
  writeFileSync(join(globDir, 'x.m4a'), 'x')
  const copied = await plain(`cp "${globDir}/"*.m4a "${globOut}/" && echo 'copied:' && find "${globOut}" -name '*.m4a' | wc -l | tr -d ' '`)
  check('the real shell copies the file through the product seam', copied.code === 0 && trimmed(copied) === 'copied:\n1' && existsSync(join(globOut, 'x.m4a')), `code ${copied.code} ${JSON.stringify(copied.out.slice(0, 120))} ${JSON.stringify(copied.stderr.slice(0, 120))}`)
  const listed = await plain(`ls "${globDir}/"*.m4a | head -1`)
  check('…and lists it through a pipe', listed.code === 0 && trimmed(listed) === `${globDir}/x.m4a`, `code ${listed.code} ${JSON.stringify(listed.out.slice(0, 120))}`)
  const noMatch = await plain(`ls "${globDir}/"*.none 2>&1 | head -1`)
  check('…and a glob with no match still reaches the command as its own text', noMatch.out.includes('a b&c/*.none'), JSON.stringify(noMatch.out.slice(0, 160)))
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

section('§3b a bang reaches the command exactly as written')
{

  const { quoteShellCommand } = await import('../../src/utils/bash/shellQuoting.ts')
  const { rearrangePipeCommand } = await import('../../src/utils/bash/bashPipeCommand.ts')
  const BS = String.fromCharCode(92)
  const bangEscape = `${BS}!`
  const hasPython = (() => {
    try {
      return execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim() !== ''
    } catch {
      return false
    }
  })()
  const printfBatch = [
    `printf '%s${BS}n' "A: x !=0"`,
    `printf '%s${BS}n' "B: x!=0"`,
    `printf '%s${BS}n' 'C: x!=0'`,
    `printf '%s${BS}n' "D: hi!"`,
    `printf '%s${BS}n' "E: !x"`,
    `printf '%s${BS}n' "F: a! b"`,
  ].join('; ')
  const rows: Array<[string, string]> = [
    ['echo "hi!"', 'hi!'],
    [`printf '%s${BS}n' "don't break!"`, "don't break!"],
    [`${printfBatch}; printf '%s${BS}n' 'G: done'`, 'A: x !=0\nB: x!=0\nC: x!=0\nD: hi!\nE: !x\nF: a! b\nG: done'],
    [`printf '%s${BS}n' "literal: x]!=0" "it's!"`, "literal: x]!=0\nit's!"],
    ['echo "it\'s `echo x`!"', "it's x!"],
    ['X=5; echo "got $X! and it\'s $((1+1))"', "got 5! and it's 2"],
  ]
  if (hasPython) {
    rows.push(
      ['python3 -c "print(1 != 2)"', 'True'],
      ['python3 -c "print(1!=2)"', 'True'],
      ['python3 -c "x=[1]; print(x[0]!=0)"', 'True'],
      [`python3 -c "print('a'!='b')"`, 'True'],
      [`${printfBatch}; python3 -c 'print(1!=2)'`, 'A: x !=0\nB: x!=0\nC: x!=0\nD: hi!\nE: !x\nF: a! b\nTrue'],
      [`python3 -c "x=[1]; print(x[0]!=0)"; echo "exit=$?"; python3 -c "print([1]!=[2])"; echo "exit=$?"; python3 -c "print('a'!='b')"; echo "exit=$?"; printf '%s${BS}n' "literal: x]!=0"`, 'True\nexit=0\nTrue\nexit=0\nTrue\nexit=0\nliteral: x]!=0'],
    )
  } else {
    console.log('  [SKIP] the python rows — no python3 on PATH (the printf rows pin the same seam)')
  }
  for (const [command, expected] of rows) {
    const got = await plain(command)
    check(`\`${command.length > 60 ? command.slice(0, 57) + '…' : command}\` prints the bang unescaped`, got.code === 0 && trimmed(got) === expected && !got.out.includes(bangEscape), `code ${got.code} ${JSON.stringify(got.out.slice(0, 120))} ${JSON.stringify(got.stderr.slice(0, 120))}`)
  }
  const stage = await plain(`printf "%s" "it's!" | cat`)
  check("a pipe stage holding a single quote and a bang reaches printf as written", stage.code === 0 && stage.out === "it's!", JSON.stringify(stage.out.slice(0, 80)))

  const stageForm = rearrangePipeCommand(`printf "%s" "it's!" | cat`)
  check('…its rearranged form carries no backslash-bang', !stageForm.includes(bangEscape) && stageForm.includes("it'"), stageForm)
  const tokenForm = rearrangePipeCommand('printf "%s" "hi there!" | cat')
  check('quoted words keep their original spelling without token reconstruction', tokenForm === `'printf "%s" "hi there!" | cat' < /dev/null` && !tokenForm.includes(bangEscape), tokenForm)
  const tokenRow = await plain('printf "%s" "hi there!" | cat')
  check('…and prints as written', tokenRow.code === 0 && tokenRow.out === 'hi there!', JSON.stringify(tokenRow.out.slice(0, 80)))

  const bangCommand = `python3 -c "print('a'!='b')"`
  const quoted = quoteShellCommand(bangCommand, false)
  check('the quoting owner writes no backslash before a bang', !quoted.includes(bangEscape), quoted)
  check('…and single-quotes the whole command by close/reopen, so the shell sees the exact text', quoted === `'python3 -c "print('${BS}''a'${BS}''!='${BS}''b'${BS}'')"'`, quoted)
  check('…with the stdin redirect outside the quotes when asked', quoteShellCommand(bangCommand, true) === `${quoted} < /dev/null`, quoteShellCommand(bangCommand, true))
  check('…and never a redirect on a heredoc', !quoteShellCommand("cat <<'EOF'\nhi!\nEOF", true).endsWith('< /dev/null'))
  check('a command without a single quote is quoted the same way', quoteShellCommand('echo "hi!"', false) === `'echo "hi!"'`, quoteShellCommand('echo "hi!"', false))
}

section("§4 the cwd record never replaces the command's status")
{
  const gone = await plain(`mkdir -p "${SCRATCH}/gone" && cd "${SCRATCH}/gone" && rm -rf "${SCRATCH}/gone"; echo done`)
  check('a command that deletes its own directory keeps its status and prints its text', gone.code === 0 && trimmed(gone) === 'done', `code ${gone.code} ${JSON.stringify(gone.out.slice(0, 120))}`)
  check('…and the session stays in an existing directory, the shell recovering to it', existsSync(gone.cwd) && gone.cwd === PROJECT && gone.shellCwd === PROJECT, `session ${gone.cwd} shell ${gone.shellCwd}`)
  const failing = await plain('echo before; exit 3')
  check('a failing command keeps its own status', failing.code === 3 && trimmed(failing) === 'before', `code ${failing.code}`)
  const moved = await plain(`cd "${PROJECT}/sub" && echo moved`)
  check('a successful cd is still recorded — for the shell, not the session', moved.code === 0 && moved.shellCwd === join(PROJECT, 'sub') && moved.cwd === PROJECT, `shell ${moved.shellCwd} session ${moved.cwd}`)
  const back = await plain(`cd "${PROJECT}"`)
  check('…and back', back.shellCwd === PROJECT && back.cwd === PROJECT, `shell ${back.shellCwd} session ${back.cwd}`)
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

section('§7 the never-auto-background list matches the command word')
{
  const { firstCommandWord } = await import('../../src/utils/shell/shellToolUtils.ts')
  check("'sleep 30' → sleep", firstCommandWord('sleep 30') === 'sleep')
  check("'  sleep ' → sleep", firstCommandWord('  sleep ') === 'sleep')
  check("'sleeper 1' → sleeper (no prefix match)", firstCommandWord('sleeper 1') === 'sleeper')
  check("'Start-Sleep -Seconds 5' → Start-Sleep", firstCommandWord('Start-Sleep -Seconds 5') === 'Start-Sleep')
  check("'' → ''", firstCommandWord('') === '')
  const bashTool = readFileSync(join(ROOT, 'src', 'tools', 'BashTool', 'BashTool.tsx'), 'utf8')
  check('the Bash tool compares the command word of the first subcommand', /NEVER_AUTO_BACKGROUND\.has\(firstCommandWord\(firstSubcommand\)\)/.test(bashTool))
  const psTool = readFileSync(join(ROOT, 'src', 'tools', 'PowerShellTool', 'PowerShellTool.tsx'), 'utf8')
  check('the PowerShell tool takes its first token from the same owner', /const firstToken = firstCommandWord\(/.test(psTool) && /NEVER_AUTO_BACKGROUND\.has\(resolveToCanonical\(firstToken\)\)/.test(psTool))
}

section('§1b the execution seams — the artifact under node')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
const nodeBin = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(`  [SKIP] ${existsSync(DIST) ? 'no node binary on PATH' : 'dist/mercury.mjs absent — build first (the gate prebuilds)'}`)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bash-tool-seams-cwd-')))
  const away = realpathSync(mkdtempSync('/tmp/bash-tool-seams-away-'))
  mkdirSync(join(cwd, 'sub'))
  const globDir = join(cwd, 'a b&c')
  const globOut = join(cwd, 'glob-out')
  mkdirSync(globDir)
  mkdirSync(globOut)
  writeFileSync(join(globDir, 'x.m4a'), 'recorded-audio')
  const configDir = join(home, '.mercury')
  seedFirstRun(configDir, [cwd])
  writeFileSync(join(configDir, 'settings.json'), '{}\n')
  const MODEL = 'claude-opus-4-8'
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: `cd "${cwd}/sub" && echo moved`, description: 'cd into a subdirectory' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `pwd && echo in > "${cwd}/in.txt" && echo written`, description: 'read the directory, write inside' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `echo out > "${away}/out.txt"`, description: 'write outside' }, whenModel: MODEL },

    { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 30', timeout: 3000, description: 'a command past its timeout' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: 't=$(mktemp) && echo "$t" && rm -f "$t" && echo "TMPDIR=$TMPDIR"', description: 'a temp file' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `cp "${globDir}/"*.m4a "${globOut}/" && echo 'copied:' && find "${globOut}" -name '*.m4a' | wc -l | tr -d ' '`, description: 'copy a quoted audio glob through a pipe' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `ls "${globDir}/"*.m4a | head -1`, description: 'list a quoted audio glob through a pipe' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `ls "${globDir}/"*.none 2>&1 | head -1`, description: 'retain an unmatched quoted glob in the error text' }, whenModel: MODEL },
    { kind: 'text', text: 'seams-probe: done', whenModel: MODEL },
    { kind: 'text', text: 'seams-probe: done', whenModel: MODEL },
  ]
  const fixture = await startFixtureApi(turns)
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    SHELL: '/bin/bash',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_VERIFY_EVIDENCE: '0',
    ...(process.env.MERCURY_TMPDIR ? { MERCURY_TMPDIR: process.env.MERCURY_TMPDIR } : {}),
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  }
  const { hostRunner } = await import('../lib/runnerHost.ts')
  const { isOutcome } = await import('../lib/rows.ts')
  const startedAt = Date.now()
  const host = hostRunner({ node: nodeBin, dist: DIST, cwd, home: configDir, env, argv: ['--model', MODEL, '--sovereign'] })
  host.onAsk(params => params.kind === 'tool' && params.tool_name === 'Bash'
    ? { outcome: 'allow', input: params.input }
    : { outcome: 'deny', message: 'Only fixture Bash approvals are expected.' })
  await host.initialize()
  await host.prompt('seams-probe: run the eight')
  await host.waitFor('seams probe outcome', isOutcome, 90_000)
  const exit = await host.stop(5_000)
  const outcome = { exit, stdout: host.rows.map(row => JSON.stringify(row)).join('\n'), stderr: host.stderr(), ms: Date.now() - startedAt }
  for (const turn of turns.slice(4, 8)) {
    if (turn.kind !== 'tool_use') continue
    const command = (turn.input as { command: string }).command
    check(`artifact: sovereign ran it without asking the host (an unprovable command is an ordinary ask the mode answers) ${JSON.stringify(command.replaceAll(cwd, '<cwd>'))}`, !host.asks.some(ask => ask.params.kind === 'tool' && ask.params.tool_name === 'Bash' && (ask.params.input as { command?: string }).command === command))
  }
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
        if (results.length < 8 && !results.some(r => r.text === text && r.isError === (block.is_error === true))) results.push({ text, isError: block.is_error === true })
      }
    }
  }
  note(`run exit ${outcome.exit} after ${outcome.ms}ms; ${fixture.messageRequests().length} model requests; stdout ${JSON.stringify(outcome.stdout.trim().slice(0, 80))}`)
  for (const [index, request] of fixture.messageRequests().entries()) {
    const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? []
    const last = messages[messages.length - 1]
    const blocks = Array.isArray(last?.content) ? (last?.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) : []
    const result = blocks.find(b => b.type === 'tool_result')
    if (result) note(`request ${index + 1} carried a tool result${result.is_error ? ' (error)' : ''}: ${JSON.stringify(typeof result.content === 'string' ? result.content.slice(0, 120) : JSON.stringify(result.content).slice(0, 120))}`)
  }
  check('the artifact ran the eight calls and closed the turn', outcome.exit === 0 && /seams-probe: done/.test(outcome.stdout), `exit ${outcome.exit} ${JSON.stringify(outcome.stderr.slice(-300))}`)
  check('the artifact showed the model eight tool results', results.length === 8, results.map(r => `${r.isError ? 'ERR' : 'ok'}:${JSON.stringify(r.text.slice(0, 60))}`).join(' '))
  const [first, second, third, fourth, fifth, copied, listed, noMatch] = results
  check('artifact: a quoted space-and-ampersand audio glob copies through a pipeline', copied !== undefined && !copied.isError && copied.text.split('\n').slice(0, 2).join('\n') === 'copied:\n1' && existsSync(join(globOut, 'x.m4a')) && readFileSync(join(globOut, 'x.m4a'), 'utf8') === 'recorded-audio', JSON.stringify(copied))
  check('artifact: a quoted audio glob lists through a pipeline', listed !== undefined && !listed.isError && listed.text.split('\n')[0] === `${globDir}/x.m4a`, JSON.stringify(listed))
  check('artifact: an unmatched quoted glob retains its complete directory in the error text', noMatch !== undefined && noMatch.text.includes('a b&c/*.none'), JSON.stringify(noMatch))
  const fifthPath = fifth?.text.trim().split('\n')[0] ?? ''
  check("artifact: the model's timeout is honoured — the sleep is stopped at three seconds with the note", fourth !== undefined && /Command timed out after 3s/.test(fourth.text) && outcome.ms < 20_000, `${outcome.ms}ms ${JSON.stringify(fourth?.text.slice(0, 160))}`)
  check('artifact: …on the kill path — an error result, never moved to the background', fourth !== undefined && fourth.isError && !/moved to the background/.test(fourth.text), JSON.stringify(fourth?.text.slice(0, 160)))
  check('artifact: a cd keeps its status and its text', first !== undefined && !first.isError && /moved/.test(first.text) && !/Operation not permitted/.test(first.text), JSON.stringify(first?.text.slice(0, 160)))
  const subAsShellSpells = await shellSpelling(join(cwd, 'sub'))
  check('artifact: the cd propagated and a write inside the session directory landed', second !== undefined && !second.isError && second.text.trim().startsWith(subAsShellSpells) && /written/.test(second.text) && existsSync(join(cwd, 'in.txt')), JSON.stringify(second?.text.slice(0, 160)))
  const descriptions = fixture.messageRequests().map(r => ((r.body as { tools?: Array<{ name?: string; description?: string }> })?.tools ?? []).find(t => t.name === 'Bash')?.description ?? '')
  check("artifact: the tool's description names no sandbox", descriptions.length > 0 && descriptions.every(d => !/sandbox/i.test(d)))
  check('artifact: run mode says nothing about a sandbox', !/sandbox/i.test(outcome.stderr), JSON.stringify(outcome.stderr.slice(0, 300)))
  check('artifact: a write outside the session directory lands with its own status', third !== undefined && !third.isError && existsSync(join(away, 'out.txt')), JSON.stringify(third?.text.slice(0, 160)))
  check('artifact: a bare mktemp succeeds', fifth !== undefined && !fifth.isError && fifthPath.startsWith('/'), JSON.stringify(fifth?.text.slice(0, 160)))
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  rmSync(away, { recursive: true, force: true })
}

process.chdir(ROOT)
rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL BASH TOOL SEAM PROOFS PASS')
else console.log(` ❌ ${failures} BASH TOOL SEAM CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_ENV, ROOT, engineLaneState, resolveEngineUnderTest, type Engine } from './shell-engine-parity.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const engine: Engine = resolveEngineUnderTest()
const lane = engineLaneState()
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' Bash tool execution seam — the engine corpus')
console.log('============================================================')
console.log(`  engine under test: ${engine} (pin ${ENGINE_ENV}=${process.env[ENGINE_ENV] ?? 'unset'}; lane ${lane.state}: ${lane.reason})`)
console.log(`  SHELL for the system lane: ${process.env.SHELL}`)

const { exec, setCwd } = await import('../../src/utils/Shell.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
const { getMaxOutputLength } = await import('../../src/utils/shell/outputLimits.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'shell-engine-exec-')))
setCwd(SCRATCH)

interface Outcome {
  code: number
  out: string
  stderr: string
  interrupted: boolean
  ms: number
  cwd: string
  fileSize: number | undefined
}

interface RunOptions {
  timeout?: number
  abortAfterMs?: number
  owner?: string
}

async function run(command: string, opts: RunOptions = {}): Promise<Outcome> {
  const controller = new AbortController()
  const started = Date.now()
  const handle = await exec(command, controller.signal, 'bash', {
    timeout: opts.timeout ?? 20_000,
    shouldAutoBackground: false,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
  })
  if (opts.abortAfterMs !== undefined) setTimeout(() => controller.abort('stop'), opts.abortAfterMs)
  const result = await handle.result
  return {
    code: result.code,
    out: result.stdout,
    stderr: result.stderr,
    interrupted: result.interrupted,
    ms: Date.now() - started,
    cwd: getCwd(),
    fileSize: result.outputFileSize,
  }
}

interface Expect {
  code?: number
  out?: string
  outMatch?: RegExp
  cwd?: string
  interrupted?: boolean
  stderrMatch?: RegExp
  maxMs?: number
  bytes?: number
}
type PerEngine = { system: Expect; brush: Expect }
const perEngine = (expect: Expect | PerEngine): expect is PerEngine => 'system' in expect && 'brush' in expect

async function row(
  label: string,
  command: string,
  expect: Expect | PerEngine,
  opts: RunOptions = {},
): Promise<Outcome> {
  const want = perEngine(expect) ? expect[engine] : expect
  const got = await run(command, opts)
  const problems: string[] = []
  if (want.code !== undefined && got.code !== want.code) problems.push(`code ${got.code} (want ${want.code})`)
  if (want.out !== undefined && got.out.trimEnd() !== want.out)
    problems.push(`out ${JSON.stringify(got.out.slice(0, 200))} (want ${JSON.stringify(want.out)})`)
  if (want.outMatch !== undefined && !want.outMatch.test(got.out))
    problems.push(`out ${JSON.stringify(got.out.slice(0, 200))} (want /${want.outMatch.source}/)`)
  if (want.cwd !== undefined && got.cwd !== want.cwd) problems.push(`cwd ${got.cwd} (want ${want.cwd})`)
  if (want.interrupted !== undefined && got.interrupted !== want.interrupted) problems.push(`interrupted ${got.interrupted}`)
  if (want.stderrMatch !== undefined && !want.stderrMatch.test(got.stderr))
    problems.push(`stderr ${JSON.stringify(got.stderr.slice(0, 200))} (want /${want.stderrMatch.source}/)`)
  if (want.maxMs !== undefined && got.ms > want.maxMs) problems.push(`${got.ms}ms (max ${want.maxMs})`)
  if (want.bytes !== undefined) {
    const bytes = got.fileSize ?? Buffer.byteLength(got.out)
    if (bytes !== want.bytes) problems.push(`bytes ${bytes} (want ${want.bytes})`)
  }
  check(label, problems.length === 0, problems.join('; '))
  return got
}

const SUB = join(SCRATCH, 'sub')
const DEEP = join(SUB, 'deep')
const GLOB = join(SCRATCH, 'glob')
mkdirSync(DEEP, { recursive: true })
mkdirSync(GLOB, { recursive: true })
writeFileSync(join(GLOB, 'one.txt'), '1\n')
writeFileSync(join(GLOB, 'two.txt'), '2\n')

section('§0 the live engine answers the pin')
{
  const probe = await run('echo "${BRUSH_VERSION:-system}"')
  const answered = probe.out.trim()
  note(`the shell that answered: ${answered === 'system' ? 'the system shell' : `brush ${answered}`}; $BASH_VERSION=${(await run('echo "$BASH_VERSION"')).out.trim() || '(empty)'}`)
  check(
    'the engine under test is the one on the wire (brush answers a version; the system shell answers none)',
    engine === 'brush' ? answered !== 'system' && answered !== '' : answered === 'system',
    `answered ${JSON.stringify(answered)}`,
  )
}

section('§1 quoting')
{
  await row('single quotes are literal', `echo 'single $HOME "dq" back\\slash'`, { code: 0, out: 'single $HOME "dq" back\\slash' })
  await row('double quotes expand a substitution and keep an escaped quote', `echo "double $(echo sub) \\"esc\\" tail"`, { code: 0, out: 'double sub "esc" tail' })
  await row('printf with two quoted operands keeps inner spacing', `printf '%s|%s\\n' 'a b' "c  d"`, { code: 0, out: 'a b|c  d' })
  await row("a backslash-escaped apostrophe survives", `echo it\\'s`, { code: 0, out: "it's" })
  await row('an unquoted variable word-splits; a quoted one does not', `V='x y'; printf '[%s]\\n' "$V"; printf '[%s]' $V; echo`, { code: 0, out: '[x y]\n[x][y]' })
  await row('a multi-line substitution stays multi-line', `echo "$(printf 'a\\nb')" | wc -l | tr -d ' '`, { code: 0, out: '2' })
  await row('adjacent quoted fragments join', `echo 'a'"b"c`, { code: 0, out: 'abc' })
  await row('a backslash-newline continues the line', 'echo one \\\n two', { code: 0, out: 'one two' })
  await row('a bang inside double quotes is literal (no history expansion)', `echo "!bang"`, { code: 0, out: '!bang' })
  await row('a quoted star is literal', `echo '*'; echo "*"`, { code: 0, out: '*\n*' })
  await row('ANSI-C quoting yields the control character', `printf '%s' $'a\\tb' | wc -c | tr -d ' '`, { code: 0, out: '3' })
  await row('a trailing-newline-free print is delivered as written', `printf 'no newline'`, { code: 0, out: 'no newline' })
  await row('non-ASCII text round-trips byte-honestly', `echo 'héllo wörld ✓'`, { code: 0, out: 'héllo wörld ✓' })
}

section('§2 heredocs and here-strings')
{
  await row('a quoted-delimiter heredoc is literal', "cat <<'EOF'\n$literal `tick`\nEOF", { code: 0, out: '$literal `tick`' })
  await row('an unquoted-delimiter heredoc expands', 'cat <<EOF\nexp=$(echo ok) $((1+2))\nEOF', { code: 0, out: 'exp=ok 3' })
  await row('a dash heredoc strips leading tabs', 'cat <<-EOF\n\tindented\n\tEOF', { code: 0, out: 'indented' })
  await row('a heredoc feeds the first pipeline stage', 'cat <<EOF | tr a-z A-Z\nlower\nEOF', { code: 0, out: 'LOWER' })
  await row('a heredoc followed by another command runs both', 'cat <<EOF; echo after\nbody\nEOF', { code: 0, out: 'body\nafter' })
  await row('a here-string feeds stdin', `cat <<< 'here string'`, { code: 0, out: 'here string' })
}

section('§3 pipelines and stdin')
{
  await row('a four-stage grep/sed/awk pipeline', `printf 'a\\nb\\nc\\n' | grep b | sed 's/b/B/' | awk '{print "X" $1}'`, { code: 0, out: 'XB' })
  await row('a command that reads stdin meets EOF at once (no hang)', `cat | head -1; echo "rc=$?"`, { code: 0, out: 'rc=0', maxMs: 5000 })
  await row('a bare stdin reader returns empty', `cat`, { code: 0, out: '', maxMs: 5000 })
  await row("the command's own stdin redirect is honoured", `head -c 3 < /dev/zero | wc -c | tr -d ' '`, { code: 0, out: '3' })
  await row('a subshell stage reads the pipe, not the closed stdin', `echo a | (read x; echo "got $x")`, { code: 0, out: 'got a' })
  await row('a long loop piped to tail delivers the last line', `for i in $(seq 1 2000); do echo "line $i"; done | tail -1`, { code: 0, out: 'line 2000' })
  await row('the pipeline status is the last stage; pipefail flips it, then is reset', `false | true; echo "$?"; set -o pipefail; false | true; echo "$?"; set +o pipefail`, { code: 0, out: '0\n1' })
  await row('a SIGPIPE-terminated producer does not fail the pipeline', `yes | head -2 | wc -l | tr -d ' '`, { code: 0, out: '2' })
  await row('read at EOF returns 1 with an empty value', `read x; rc=$?; echo "[$x] rc=$rc"`, { code: 0, out: '[] rc=1' })
}

section('§4 exit codes and stream order')
{
  await row('exit 0', 'exit 0', { code: 0, out: '' })
  await row('false is 1', 'false', { code: 1 })
  const missing = await row('a missing command is 127 with a not-found line', 'nonexistent-cmd-xyz', { code: 127, outMatch: /not found/ })
  note(`not-found text: ${JSON.stringify(missing.out.trim())}`)
  await row('a child exit status propagates', `sh -c 'exit 42'`, { code: 42 })
  await row('an out-of-range exit wraps modulo 256', 'exit 300', { code: 44 })
  await row('stdout and stderr keep their order in the combined stream', 'echo one; echo two >&2; echo three', { code: 0, out: 'one\ntwo\nthree' })
  await row('a stderr-only failure carries its text and code', 'echo err-only >&2; exit 5', { code: 5, out: 'err-only' })
  await row('a subshell exit is its own', '( exit 7 )', { code: 7 })
  await row('&& then exit short-circuits ||', 'true && exit 9 || echo no', { code: 9, out: '' })
  await row('! negates the status', '! true; echo $?', { code: 0, out: '1' })
  await row('$((…)) arithmetic', 'echo $((6*7))', { code: 0, out: '42' })
  await row('brace expansion', 'echo {a,b}{1,2}', { code: 0, out: 'a1 a2 b1 b2' })
  await row('an indexed array (zero-based) and its length', 'a=(x y z); echo "${a[1]} ${#a[@]}"', { code: 0, out: 'y 3' })
  await row('a function with a local and a case', 'f() { local x=$1; case $x in a) echo A;; *) echo other;; esac; }; f a; f b', { code: 0, out: 'A\nother' })
  await row('[[ =~ ]] with a capture', '[[ "abc" =~ ^a(b)c$ ]] && echo "re=${BASH_REMATCH[1]}"', { code: 0, out: 're=b' })
  await row('an EXIT trap fires at command end on the system shell; at session end under the engine (one persistent shell)', 'trap "echo trapped" EXIT; echo body', {
    system: { code: 0, out: 'body\ntrapped' },
    brush: { code: 0, out: 'body' },
  })
  const bashMajor = engine === 'system' ? Number((await run('echo "${BASH_VERSINFO[0]}"')).out.trim()) : NaN
  if (engine === 'system') note(`the system shell is bash ${bashMajor}: set -e ${bashMajor >= 4 ? 'is ignored inside the tool\'s && chain (the command runs on)' : 'aborts the command'}`)
  await row('set -e inside a command: bash 3 aborts it on the system shell and bash 4+ runs on (errexit is ignored inside the && chain); the engine suppresses it at the boundary (a failure never ends the persistent session)', 'set -e; false; echo not-reached', {
    system: bashMajor >= 4 ? { code: 0, out: 'not-reached' } : { code: 1, out: '' },
    brush: { code: 0, out: 'not-reached' },
  })
}

section('§5 the cwd record')
{
  await row('cd moves the session directory', `cd "${SUB}"`, { code: 0, out: '', cwd: SUB })
  await row('pwd reads the moved directory', 'pwd', { code: 0, out: SUB, cwd: SUB })
  await row('a relative cd resolves against the session directory', 'cd deep && pwd', { code: 0, out: DEEP, cwd: DEEP })
  await row('cd ../.. climbs', 'cd ../..', { code: 0, cwd: SCRATCH })
  await row('a subshell cd never moves the session', `(cd "${SUB}"; pwd); pwd`, { code: 0, out: `${SUB}\n${SCRATCH}`, cwd: SCRATCH })
  await row('a failed cd leaves the session where it was', `cd "${SCRATCH}/nope" 2>/dev/null; echo "rc=$?"`, { code: 0, out: 'rc=1', cwd: SCRATCH })
  const deleted = await row(
    'a command that deletes its own directory leaves the session in an existing one',
    `mkdir -p "${SCRATCH}/gone" && cd "${SCRATCH}/gone" && rm -rf "${SCRATCH}/gone"; echo done`,
    { outMatch: /^done/m },
  )
  note(`deleted-directory row: code ${deleted.code} out ${JSON.stringify(deleted.out.trim().slice(0, 120))}`)
  check('…and that directory exists on disk', existsSync(deleted.cwd), deleted.cwd)
  const after = await run('pwd')
  check('…and the next command runs there', after.code === 0 && after.out.trim() === getCwd(), `pwd ${JSON.stringify(after.out.trim())} vs session ${getCwd()}`)
  await row('cd -P resolves a symlinked directory to its physical path', 'cd -P /tmp && pwd -P', { code: 0, out: realpathSync('/tmp'), cwd: realpathSync('/tmp') })
  const home = realpathSync(homedir())
  await row('a tilde cd lands in the home directory', 'cd ~', { code: 0, cwd: home })
  const odd = join(SCRATCH, 'sp ace', 'ünï')
  await row('a directory with spaces and non-ASCII letters is recorded NFC-normalized', `mkdir -p "${odd}" && cd "${odd}"`, { code: 0, cwd: odd.normalize('NFC') })
  await row('back to the scratch root', `cd "${SCRATCH}"`, { code: 0, cwd: SCRATCH })
}

section('§6 the environment the seam sets')
{
  await row('MERCURY=1 marks the child', 'echo "$MERCURY"', { code: 0, out: '1' })
  await row('GIT_EDITOR=true keeps git non-interactive', 'echo "$GIT_EDITOR"', { code: 0, out: 'true' })
  const shellVar = await row('SHELL names the live shell', '[ -n "$SHELL" ] && echo set', { code: 0, out: 'set' })
  note(`$SHELL=${(await run('echo "$SHELL"')).out.trim()} $0=${(await run('echo "$0"')).out.trim()} (${shellVar.ms}ms)`)
  await row('an export reaches a child process', `export ZED=1; sh -c 'echo "[$ZED]"'`, { code: 0, out: '[1]' })
  await row('the inherited PATH finds tools', 'command -v ls', { code: 0, outMatch: /\/ls\s*$/ })
}

section('§7 the security preamble and globs')
{
  const extglob = await run(`(cd "${GLOB}" && echo +(one.txt|two.txt))`)
  check(
    'extended globs: the preamble disables them on the system shell (the pattern never expands); brush keeps them on (the shopt is a no-op)',
    engine === 'brush' ? /one\.txt two\.txt/.test(extglob.out) : !/one\.txt two\.txt/.test(extglob.out),
    `code ${extglob.code} out ${JSON.stringify(extglob.out.trim())}`,
  )
  check('the extended-glob probe never moved the session directory (the cd was subshell-scoped)', getCwd() === SCRATCH, `cwd ${getCwd()}`)
  note(`extended-pattern row (${engine}): code ${extglob.code} out ${JSON.stringify(extglob.out.trim().slice(0, 80))}`)
  await row('an unmatched glob passes through literally', `echo "${GLOB}"/*.nomatch | sed "s#${SCRATCH}##"`, { code: 0, out: '/glob/*.nomatch' })
  await row('a matched glob expands', `ls "${GLOB}"/*.txt | wc -l | tr -d ' '`, { code: 0, out: '2' })
}

section('§8 state between calls (the engines differ by contract)')
{
  await row('a variable and a function are set in one call', 'STATE_VAR=persisted; state_fn() { echo fn-ok; }; :', { code: 0, out: '' })
  await row('the next call reads them: reset on system, persisted on the vendored engine', 'echo "[${STATE_VAR:-none}]"; state_fn 2>/dev/null || echo fn-missing', {
    system: { code: 0, out: '[none]\nfn-missing' },
    brush: { code: 0, out: '[persisted]\nfn-ok' },
  })
  const opt = await run('set -e; :')
  const leak = await run('false; echo survived')
  note(`a set -e from a previous call: code ${opt.code} then ${JSON.stringify(leak.out.trim())} code ${leak.code} (${engine}: ${leak.out.includes('survived') ? (engine === 'brush' ? 'the option persists but errexit is suppressed at the command boundary' : 'options reset per call') : 'the option persisted and aborted the command'})`)
  check('the cwd persists on both engines', (await run('pwd')).out.trim() === SCRATCH)
}

section('§9 timeouts, aborts, and a shell that dies')
{
  await row('a command past its timeout is killed with the timed-out note', 'sleep 3', { code: 143, interrupted: false, stderrMatch: /timed out/, maxMs: 4000 }, { timeout: 400 })
  await row('the next call runs after a timeout kill', 'echo alive-after-timeout', { code: 0, out: 'alive-after-timeout' })
  const aborted = await run('sleep 3', { abortAfterMs: 300 })
  check('an abort kills the command and marks it interrupted', aborted.interrupted && aborted.code !== 0 && aborted.ms < 2500, `code ${aborted.code} interrupted ${aborted.interrupted} after ${aborted.ms}ms`)
  await row('the next call runs after an abort', 'echo alive-after-abort', { code: 0, out: 'alive-after-abort' })
  await row('exec replaces the shell and the call still settles', 'exec true', { code: 0, out: '' })
  await row('the next call runs after an exec', 'echo alive-after-exec', { code: 0, out: 'alive-after-exec' })
  const killed = await run('kill -TERM $$')
  note(`kill -TERM $$ → code ${killed.code}, interrupted ${killed.interrupted}, stderr ${JSON.stringify(killed.stderr.slice(0, 80))}`)
  check('a shell that kills itself settles non-zero', killed.code !== 0, `code ${killed.code}`)
  await row('the next call runs after the shell killed itself', 'echo alive-after-kill', { code: 0, out: 'alive-after-kill' })
}

section('§10 output bounds')
{
  const budget = getMaxOutputLength()
  const big = await row('200000 bytes of output are delivered in full (off-lined past the budget)', `head -c 200000 /dev/zero | tr '\\0' 'y'`, { code: 0, bytes: 200000 })
  note(`inline stdout ${big.out.length} chars against a ${budget}-char budget; file size ${big.fileSize ?? 'n/a'}`)
  await row('3000 lines count exactly', `for i in $(seq 1 3000); do echo "$i"; done | wc -l | tr -d ' '`, { code: 0, out: '3000' })
  const control = await row('control bytes pass through unmangled', `printf 'A\\033[2J\\007B\\r\\n'`, { code: 0, outMatch: /A\x1b\[2J\x07B/ })
  note(`control-byte row: ${JSON.stringify(control.out)}`)
}

section('§11 concurrent calls')
{
  const started = Date.now()
  const results = await Promise.all([run('sleep 0.4; echo A'), run('echo B'), run('sleep 0.2; echo C')])
  check(
    'three concurrent calls each carry only their own output',
    results[0]!.out.trim() === 'A' && results[1]!.out.trim() === 'B' && results[2]!.out.trim() === 'C',
    results.map(r => JSON.stringify(r.out.trim())).join(' '),
  )
  check('…and all settle within 5s', Date.now() - started < 5000, `${Date.now() - started}ms`)
  note(`concurrency wall time ${Date.now() - started}ms (${engine}: ${Date.now() - started < 550 ? 'parallel' : 'serialized'})`)
}

section('§12 a background-intent call takes its own shell; the session is untouched')
{
  await run('BG_MARK=kept; :')
  const controller = new AbortController()
  const handle = await exec('echo "${BRUSH_VERSION:-system} [${BG_MARK:-none}]"', controller.signal, 'bash', { timeout: 20_000, shouldAutoBackground: false, backgroundIntent: true })
  const bg = await handle.result
  check('a background-intent call is answered by the system shell in its own process — never the shared engine session, whose state it cannot see', bg.stdout.trim() === 'system [none]', JSON.stringify(bg.stdout.slice(0, 80)))
  await row('the next foreground call: the session state stands on the engine, resets on the system shell', 'echo "[${BG_MARK:-none}]"', { system: { code: 0, out: '[none]' }, brush: { code: 0, out: '[kept]' } })
}

section('§13 the live progress view: first lines, a silent command, a stray frame byte')
{
  const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
  const gated = async (label: string, command: (gate: string) => string, seen: (all: string) => boolean): Promise<void> => {
    const gate = join(mkdtempSync(join(tmpdir(), 'progress-gate-')), 'open')
    let sawIt = false
    let resolveSeen!: () => void
    const seenOnce = new Promise<void>(resolve => {
      resolveSeen = resolve
    })
    const controller = new AbortController()
    const handle = await exec(command(gate), controller.signal, 'bash', {
      timeout: 20_000,
      shouldAutoBackground: false,
      onProgress: (_recent, all) => {
        if (!sawIt && seen(all)) {
          sawIt = true
          resolveSeen()
        }
      },
    })
    TaskOutput.startPolling(handle.taskOutput.taskId)
    await Promise.race([seenOnce, new Promise<void>(resolve => setTimeout(resolve, 8_000))])
    writeFileSync(gate, '')
    const result = await handle.result
    TaskOutput.stopPolling(handle.taskOutput.taskId)
    handle.cleanup()
    check(label, sawIt && result.code === 0, `seen=${sawIt} code=${result.code}`)
  }
  const wait = (gate: string): string => `while [ ! -f "${gate}" ]; do sleep 0.05; done`
  await gated('a command that writes one line at a time reaches the live view before it ends', gate => `echo line1; echo line2; ${wait(gate)}; echo line3`, all => all.includes('line1'))
  await gated('a silent command still wakes the live view (the one-second tick)', gate => `${wait(gate)}; echo done`, () => true)
  await gated('a stray frame byte in the output does not stall the live view', gate => `printf '\\001'; echo line1; ${wait(gate)}; echo done`, all => all.includes('line1'))
}

section('§14 two owners through the seam: a process each on the system shell, a session each on the engine')
{
  const order: string[] = []
  const a = run('sleep 2; echo A', { owner: 'owner-a' }).then(r => {
    order.push('a')
    return r
  })
  const b = run('echo B', { owner: 'owner-b' }).then(r => {
    order.push('b')
    return r
  })
  const [ra, rb] = await Promise.all([a, b])
  check("two owners run at the same time: the second owner's short command settles first", order[0] === 'b' && ra.out.trim() === 'A' && rb.out.trim() === 'B', `order ${order.join(',')}`)
  await run('OWNER_VAR=a-only; :', { owner: 'owner-a' })
  await row("an owner's variable is not seen by another owner", 'echo "[${OWNER_VAR:-none}]"', { code: 0, out: '[none]' }, { owner: 'owner-b' })
  await row('…and stays visible to its owner on the engine (the system shell resets it, its own contract)', 'echo "[${OWNER_VAR:-none}]"', { system: { code: 0, out: '[none]' }, brush: { code: 0, out: '[a-only]' } }, { owner: 'owner-a' })
  await run('KEEP_B=kept; :', { owner: 'owner-b' })
  await row("owner A's hung command is killed by its own timeout", 'sleep 3', { code: 143, stderrMatch: /timed out/ }, { timeout: 400, owner: 'owner-a' })
  await row("owner B's shell is untouched by owner A's reset (its state kept on the engine; the system shell never held it) and its result carries no note", 'echo "[${KEEP_B:-gone}]"', { system: { code: 0, out: '[gone]', stderrMatch: /^$/ }, brush: { code: 0, out: '[kept]', stderrMatch: /^$/ } }, { owner: 'owner-b' })
  await row("owner A's next result carries the reset note on the engine (the system shell owes none)", 'echo "[${OWNER_VAR:-gone}]"', { system: { code: 0, out: '[gone]', stderrMatch: /^$/ }, brush: { code: 0, out: '[gone]', stderrMatch: /reset/ } }, { owner: 'owner-a' })
}

section('§15 a new message while a command runs: kept for the background on the system shell; stopped, and said, on the engine')
{
  const { spawnShellTask } = await import('../../src/tasks/LocalShellTask/LocalShellTask.tsx')
  type State = { tasks: Record<string, { status?: string; notified?: boolean }> }
  let state: State = { tasks: {} }
  const setAppState = (f: (prev: State) => State): void => {
    state = f(state)
  }
  const taskContext = { abortController: new AbortController(), getAppState: () => state, setAppState } as never
  const gate = join(mkdtempSync(join(tmpdir(), 'interrupt-gate-')), 'in-flight')
  const turn = new AbortController()
  const handle = await exec(`: > "${gate}"; echo started; sleep 1; echo ended`, turn.signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  const deadline = Date.now() + 10_000
  while (!existsSync(gate) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  check('the command is in flight (its gate file exists)', existsSync(gate))
  turn.abort('interrupt')
  const spawned = await spawnShellTask({ command: 'interrupt probe', description: 'interrupt probe', shellCommand: handle }, taskContext)
  const result = await handle.result
  check(
    "the spawn reports acceptance truthfully: the system shell's running command is accepted; the engine's stopped command is refused",
    engine === 'brush' ? spawned.accepted === false : spawned.accepted === true,
    `accepted=${String(spawned.accepted)} status=${handle.status}`,
  )
  check(
    "the command settles by its engine's contract: run to its end and backgrounded on the system shell; stopped and marked interrupted on the engine",
    engine === 'brush'
      ? result.interrupted && result.code === 137 && result.backgroundTaskId === undefined
      : !result.interrupted && result.code === 0 && result.backgroundTaskId === spawned.taskId,
    JSON.stringify({ code: result.code, interrupted: result.interrupted, backgroundTaskId: result.backgroundTaskId }),
  )
  check('a refused background settles its row from the real result, never a running phantom', engine === 'brush' ? state.tasks[spawned.taskId]?.status === 'failed' && state.tasks[spawned.taskId]?.notified === true : state.tasks[spawned.taskId]?.status !== undefined, JSON.stringify(state.tasks[spawned.taskId] ?? null)?.slice(0, 120))
  if (spawned.accepted === false) handle.cleanup()
  await row("the next call: the engine's result says the session was reset by the interrupt; the system shell owes no note", 'echo next', { system: { code: 0, out: 'next', stderrMatch: /^$/ }, brush: { code: 0, out: 'next', stderrMatch: /interrupted/ } })
  const finished = await exec('echo finished', new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  await finished.result
  const late = await spawnShellTask({ command: 'late probe', description: 'late probe', shellCommand: finished }, taskContext)
  check('a command that already ended is refused on both engines (accepted false)', late.accepted === false, `accepted=${String(late.accepted)}`)
  finished.cleanup()
  const bashSrc = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
  const psSrc = readFileSync(join(ROOT, 'src/tools/PowerShellTool/PowerShellTool.tsx'), 'utf8')
  check('the Bash tool never sets a background id on a refused spawn (the steer and the explicit road)', (bashSrc.match(/if \(handle\.accepted === false\)/g) ?? []).length === 2 && /if \(handle\.accepted === false\) return\n\s*backgroundId = handle\.taskId/.test(bashSrc))
  check('the PowerShell tool keeps the same guard on both roads (parity)', (psSrc.match(/if \(handle\.accepted === false\)/g) ?? []).length === 2 && /if \(handle\.accepted === false\) return\n\s*backgroundId = handle\.taskId/.test(psSrc))
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) console.log(` ✅ ALL SHELL-ENGINE EXEC PROOFS PASS (${engine})`)
else console.log(` ❌ ${failures} SHELL-ENGINE EXEC CHECK(S) FAILED (${engine})`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

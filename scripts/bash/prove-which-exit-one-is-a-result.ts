#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_SHELL_ENGINE
const PROFILE = "fixture_precheck() { printf 'precheck ran\\n'; exit 1; }\nfixture_helper() { return 1; }\n"
const fixtureHome = (home: string): string => {
  mkdirSync(home, { recursive: true })
  for (const name of ['.bash_profile', '.bashrc', '.profile']) writeFileSync(join(home, name), PROFILE)
  return home
}
const STARTS_AGAIN_AT_HOME = process.platform === 'win32'
const AT_HOME = '--at-the-fixture-home'
if (STARTS_AGAIN_AT_HOME && !process.argv.includes(AT_HOME)) {
  const home = fixtureHome(realpathSync(mkdtempSync(join(tmpdir(), 'which-exit-one-home-'))))
  const whole = spawnSync(process.execPath, [import.meta.path, AT_HOME], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home } })
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  process.exit(whole.status ?? 1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'which-exit-one-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
const FRAMES = join(SCRATCH, 'frames')
const HOME = STARTS_AGAIN_AT_HOME ? homedir() : fixtureHome(join(SCRATCH, 'home'))
const WORK_FOLDER = join(SCRATCH, 'work')
for (const dir of [FRAMES, WORK_FOLDER]) mkdirSync(dir)
process.env.TMPDIR = FRAMES
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = FRAMES
process.env.HOME = HOME
const { nativePathToShell, shellPathToNative } = await import('../../src/platform/host-os/paths.ts')
const WORK = nativePathToShell(WORK_FOLDER)
const LEFT = `${WORK}/left`
const EQUAL = `${WORK}/equal`
const DIFFERENT = `${WORK}/different`
writeFileSync(shellPathToNative(LEFT), 'same\n')
writeFileSync(shellPathToNative(EQUAL), 'same\n')
writeFileSync(shellPathToNative(DIFFERENT), 'other\n')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { closingTableCommand, interpretCommandResult } = await import('../../src/tools/shell/commandSemantics.ts')
const { parseCommandRaw, preparedCommandRoot } = await import('../../src/platform/shell/bash/parser.ts')
const rootOf = (command: string) => parseCommandRaw(command)
const table = async (command: string, code: number) => interpretCommandResult(command, code, '', '', undefined, await rootOf(command))
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')

let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'which-exit-one',
} as never
type Out = { stdout: string; code?: number; exitNote?: string; returnCodeInterpretation?: string }
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown; is_error?: boolean } }
type Drive = { ok: true; out: Out; content: string } | { ok: false; error: string }
async function drive(command: string, more: { timeout?: number } = {}): Promise<Drive> {
  try {
    const input = { command, ...more }
    await BashTool.prepare?.(input as never)
    const result = await (BashTool as unknown as Caller).call(input as never, toolContext)
    const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(result.data as never, 'which-exit-one')
    return { ok: true, out: result.data as Out, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (error) {
    const e = error as { message?: string; stderr?: string; stdout?: string }
    return { ok: false, error: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') }
  }
}

section('§1 which: exit 1 is a labelled result, not an error')
const which = await drive('which sh mercury-no-such-tool-0x')
check('the call settles as a result (no ShellError thrown)', which.ok, which.ok ? '' : `${which.error.slice(0, 200)} — exit 1 of which must be read as a result: add it to the table in interpretCommandResult in src/tools/shell/commandSemantics.ts`)
if (which.ok) {
  check('the exit code is 1', which.out.code === 1, `${String(which.out.code)} — the result code is set by BashTool.call in src/tools/shell/BashTool.tsx`)
  check('the output lists the found name (a missing name is printed by some which builds and not others)', which.out.stdout.includes('/sh'), JSON.stringify(which.out.stdout))
  check('the result ends with the label `a name was not found (exit code 1)`', which.content.endsWith('a name was not found (exit code 1)'), `${JSON.stringify(which.content.slice(-120))} — the label comes from interpretCommandResult in src/tools/shell/commandSemantics.ts`)
  check('the result carries no `Exited with code` line', !which.content.includes('Exited with code'), `${JSON.stringify(which.content.slice(-200))} — a which exit 1 is a result, so no exit line is printed; see interpretCommandResult in src/tools/shell/commandSemantics.ts`)
  check('the interpretation on the result is the label', which.out.returnCodeInterpretation === 'a name was not found' && which.out.exitNote === 'a name was not found (exit code 1)', `${JSON.stringify([which.out.returnCodeInterpretation, which.out.exitNote])} — returnCodeInterpretation and exitNote are set from interpretCommandResult in src/tools/shell/commandSemantics.ts`)
}

section('§2 command -v: exit 1 is a labelled result too')
const commandV = await drive('command -v mercury-no-such-tool-0x')
check('the call settles as a result (no ShellError thrown)', commandV.ok, commandV.ok ? '' : `${commandV.error.slice(0, 200)} — exit 1 of command -v must be read as a result in interpretCommandResult in src/tools/shell/commandSemantics.ts`)
if (commandV.ok) {
  check('the exit code is 1', commandV.out.code === 1, String(commandV.out.code))
  check('the result ends with the label `a name was not found (exit code 1)`', commandV.content.endsWith('a name was not found (exit code 1)'), JSON.stringify(commandV.content.slice(-120)))
}
const commandVBig = await drive('command -V mercury-no-such-tool-0x')
check('command -V reads the same way', commandVBig.ok && commandVBig.content.endsWith('a name was not found (exit code 1)'), commandVBig.ok ? JSON.stringify(commandVBig.content.slice(-120)) : commandVBig.error.slice(0, 200))

section("§3 the bench's shape: a list whose LAST command is which, after a successful ls")
const listed = await drive('ls -la; which timeout-no-such-0x gtimeout-no-such-0x sh 2>&1')
check('the whole list is a result, status ok', listed.ok, listed.ok ? '' : `${listed.error.slice(0, 200)} — the exit code of a list is its last command; interpretCommandResult in src/tools/shell/commandSemantics.ts must read the last command, which`)
if (listed.ok) {
  const missed = listed.out.code
  check('the listing and the which lines are both in the output, the label last', listed.content.includes('total ') && listed.content.includes('/sh') && (missed === 1 || missed === 2) && listed.content.endsWith(`a name was not found (exit code ${missed})`), `${JSON.stringify(listed.content.slice(-160))} — two names are missing: a which that counts them leaves with 2 (GNU which, the one in Git Bash), the others with 1, and interpretCommandResult in src/tools/shell/commandSemantics.ts labels both`)
}

section('§4 exit 2 and above stay errors; other words are untouched')
const two = await drive('which() { return 2; }; which x')
check('a which that exits 2 is still an error ending `Exited with code 2`', !two.ok && /Exited with code 2/.test(two.ok ? '' : two.error), `${two.ok ? JSON.stringify(two.content.slice(0, 120)) : two.error.slice(0, 120)} — only exit 1 of which is a result; interpretCommandResult in src/tools/shell/commandSemantics.ts must leave exit 2 an error`)
check('the table reads which exit 2 as an error', (await table('which foo', 2)).isError === true, 'interpretCommandResult in src/tools/shell/commandSemantics.ts must treat which exit 2 as an error')
check('the table reads which exit 1 as a result with the label', JSON.stringify((await table('which foo', 1))) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -v exit 1 as a result with the label', JSON.stringify((await table('command -v foo', 1))) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -V exit 1 the same way', (await table('command -V foo', 1)).isError === false)
check('a bare `command foo` (no -v) keeps the default reading: exit 1 is an error', (await table('command foo', 1)).isError === true)
check('which through env and assignments is still which', (await table('FOO=1 env -i which foo', 1)).isError === false)
check('grep exit 1 keeps its own label', JSON.stringify((await table('grep x y', 1))) === JSON.stringify({ isError: false, message: 'no matches found' }))
const plainFail = await drive('cat /mercury-no-such-file-0x')
check('an ordinary non-zero exit is still an error ending `Exited with code 1`', !plainFail.ok && /Exited with code 1/.test(plainFail.ok ? '' : plainFail.error), `${plainFail.ok ? 'settled as a result' : plainFail.error.slice(-80)} — only the lookup commands in the table in src/tools/shell/commandSemantics.ts may read exit 1 as a result`)

const WIRED_HINT = 'the shell marks that it reached the closing command and that the script then ended on 1 (marksTheClosing and marksAnEndOnOne in src/platform/shell/bashProvider.ts, read by readClosingMarks in src/platform/shell/shellExec.ts); interpretCommandResult in src/tools/shell/commandSemantics.ts reads exit 1 as a result only with both marks'

const { systemShellAt, systemShellRecord } = await import('../../src/platform/shell/shellRecord.ts')
const served = await systemShellRecord()
if (served.origin === 'engine') {
  console.log('\n  [SKIP — LOUD] §5 to §9 run the closing marks in the bashes of this machine, and no bash serves here: the bundled engine carries none')
} else {
  section('§5 compound scripts with variables, substitutions, loops and short-circuit guards')
  const varGrepNoMatch = await drive("F=$(printf 'alpha\\nbeta\\n'); printf '%s\\n' \"$F\" | grep -c nomatch")
  check('variables + command substitution ending in unmatched grep is a labelled result (exit 1)', varGrepNoMatch.ok && varGrepNoMatch.out.code === 1 && varGrepNoMatch.out.returnCodeInterpretation === 'no matches found' && varGrepNoMatch.out.exitNote === 'no matches found (exit code 1)' && varGrepNoMatch.content.endsWith('no matches found (exit code 1)') && !varGrepNoMatch.content.includes('Exited with code') && varGrepNoMatch.out.stdout.trim() === '0', varGrepNoMatch.ok ? JSON.stringify(varGrepNoMatch.out) : varGrepNoMatch.error.slice(0, 200))

  const loopDiffDiffer = await drive("for x in one two; do printf '%s\\n' \"$x\" >/dev/null; done; diff <(printf 'left\\n') <(printf 'right\\n')")
  check('for-loop followed by diff of differing process substitutions is a labelled result (exit 1)', loopDiffDiffer.ok && loopDiffDiffer.out.code === 1 && loopDiffDiffer.out.returnCodeInterpretation === 'files differ' && loopDiffDiffer.out.exitNote === 'files differ (exit code 1)' && loopDiffDiffer.content.endsWith('files differ (exit code 1)') && !loopDiffDiffer.content.includes('Exited with code'), loopDiffDiffer.ok ? JSON.stringify(loopDiffDiffer.out) : loopDiffDiffer.error.slice(0, 200))

  const varGrepMatch = await drive("F=$(printf 'alpha\\nbeta\\n'); printf '%s\\n' \"$F\" | grep -c alpha")
  check('variables + command substitution ending in matching grep exits 0 with no exit note', varGrepMatch.ok && varGrepMatch.out.code === 0 && varGrepMatch.out.exitNote === undefined && varGrepMatch.out.stdout.trim() === '1', varGrepMatch.ok ? JSON.stringify(varGrepMatch.out) : varGrepMatch.error.slice(0, 200))

  const loopDiffSame = await drive("for x in one two; do printf '%s\\n' \"$x\" >/dev/null; done; diff <(printf 'same\\n') <(printf 'same\\n')")
  check('for-loop followed by identical diff exits 0 with no exit note', loopDiffSame.ok && loopDiffSame.out.code === 0 && loopDiffSame.out.exitNote === undefined, loopDiffSame.ok ? JSON.stringify(loopDiffSame.out) : loopDiffSame.error.slice(0, 200))

  const varGrepExit2 = await drive("F=$(printf 'alpha\\n'); printf '%s\\n' \"$F\" | grep --mercury-no-such-flag alpha")
  check('compound script ending in grep exit 2 stays an error', !varGrepExit2.ok && /Exited with code 2/.test(varGrepExit2.error), varGrepExit2.ok ? JSON.stringify(varGrepExit2.out) : varGrepExit2.error.slice(-160))

  const varRealFail = await drive('F=/mercury-no-such-file-0x; cat "$F"')
  check('compound script ending in a real failure stays an error', !varRealFail.ok && /Exited with code 1/.test(varRealFail.error), varRealFail.ok ? JSON.stringify(varRealFail.out) : varRealFail.error.slice(-160))

  const trailingComment = await drive("F=alpha; printf '%s\\n' \"$F\" | grep nomatch;\n# trailing note")
  check('trailing semicolon and comment do not hide closing grep exit 1', trailingComment.ok && trailingComment.out.code === 1 && trailingComment.out.returnCodeInterpretation === 'no matches found', trailingComment.ok ? JSON.stringify(trailingComment.out) : trailingComment.error.slice(0, 200))

  const varTestFalse = await drive('F=/mercury-no-such-file-0x; [ -f "$F" ]')
  check('variable assignment followed by false [ test ] is a labelled result (exit 1)', varTestFalse.ok && varTestFalse.out.code === 1 && varTestFalse.out.returnCodeInterpretation === 'condition is false', varTestFalse.ok ? JSON.stringify(varTestFalse.out) : varTestFalse.error.slice(0, 200))

  const orGrep = await drive("false || printf 'alpha\\n' | grep nomatch")
  check('false || pipeline ending in unmatched grep guarantees grep ran and reads as no matches found', orGrep.ok && orGrep.out.code === 1 && orGrep.out.returnCodeInterpretation === 'no matches found', orGrep.ok ? JSON.stringify(orGrep.out) : orGrep.error.slice(0, 200))

  const simpleAndGrep = await drive('true && grep nomatch /dev/null')
  check('established simple path true && grep keeps no matches found (1.1.0 contract)', simpleAndGrep.ok && simpleAndGrep.out.code === 1 && simpleAndGrep.out.returnCodeInterpretation === 'no matches found', simpleAndGrep.ok ? JSON.stringify(simpleAndGrep.out) : simpleAndGrep.error.slice(0, 200))

  const shortCircuitAndPipe = await drive("F=$(printf 'alpha\\n'); false && printf '%s\\n' \"$F\" | grep nomatch")
  check('compound short-circuited false && pipeline ending in grep stays an error', !shortCircuitAndPipe.ok && /Exited with code 1/.test(shortCircuitAndPipe.error), shortCircuitAndPipe.ok ? JSON.stringify(shortCircuitAndPipe.out) : shortCircuitAndPipe.error.slice(-160))

  const earlyExitCompound = await drive("F=$(printf 'alpha\\n'); exit 1; printf '%s\\n' \"$F\" | grep nomatch")
  check('compound script with earlier exit 1 before closing grep stays an error', !earlyExitCompound.ok && /Exited with code 1/.test(earlyExitCompound.error), earlyExitCompound.ok ? JSON.stringify(earlyExitCompound.out) : earlyExitCompound.error.slice(-160))

  const quotedToken = await drive('cat "/mercury-no-such-file-0x; grep x"')
  check('a grep token inside quotes never turns a failing command into no matches', !quotedToken.ok && /Exited with code 1/.test(quotedToken.error), quotedToken.ok ? JSON.stringify(quotedToken.out) : quotedToken.error.slice(-160))

  const heredocToken = await drive("cat /mercury-no-such-file-0x <<EOF\ngrep nomatch /dev/null\nEOF")
  check('a grep line inside a heredoc never turns a failing command into no matches', !heredocToken.ok && /Exited with code 1/.test(heredocToken.error), heredocToken.ok ? JSON.stringify(heredocToken.out) : heredocToken.error.slice(-160))

  const nestedLoop = await drive("for x in a; do diff <(printf 'a\\n') <(printf 'b\\n'); done")
  check('a compound nested for-loop ending in diff stays an error (executing stage not established at top level)', !nestedLoop.ok && /Exited with code 1/.test(nestedLoop.error), nestedLoop.ok ? JSON.stringify(nestedLoop.out) : nestedLoop.error.slice(-160))

  const errexitSeen = await drive("set -e; false; printf 'the shell went on after false\\n'")
  const errexitHolds = !(errexitSeen.ok && errexitSeen.out.stdout.includes('the shell went on after false'))
  const errexitFail = await drive("F=$(printf 'alpha\\n'); set -e; false; printf '%s\\n' \"$F\" | grep nomatch")
  check(
    `compound set -e earlier failure before closing grep: ${errexitHolds ? 'the shell left at false, so it stays an error' : 'this shell ran on past false (seen through the same tool), so grep ran last and it is no matches found'}`,
    errexitHolds ? !errexitFail.ok && /Exited with code 1/.test(errexitFail.error) : errexitFail.ok && errexitFail.out.code === 1 && errexitFail.out.returnCodeInterpretation === 'no matches found',
    errexitFail.ok ? JSON.stringify(errexitFail.out) : errexitFail.error.slice(-160),
  )

  const pipefailFail = await drive("F=$(printf 'hit\\n'); set -o pipefail; (printf '%s\\n' \"$F\"; exit 1) | grep hit")
  check('compound set -o pipefail earlier pipeline failure before matching grep stays an error', !pipefailFail.ok && /Exited with code 1/.test(pipefailFail.error), pipefailFail.ok ? JSON.stringify(pipefailFail.out) : pipefailFail.error.slice(-160))

  const negatedGrep = await drive("F=$(printf 'hit\\n'); ! printf '%s\\n' \"$F\" | grep hit")
  check('compound negated pipeline ! grep (exit 1 means matched) stays an error', !negatedGrep.ok && /Exited with code 1/.test(negatedGrep.error), negatedGrep.ok ? JSON.stringify(negatedGrep.out) : negatedGrep.error.slice(-160))

  const loopExitBeforeDiff = await drive('for x in a; do exit 1; done; diff <(printf same) <(printf same)')
  check('compound for-loop calling exit 1 before closing diff stays an error (never says files differ)', !loopExitBeforeDiff.ok && /Exited with code 1/.test(loopExitBeforeDiff.error), loopExitBeforeDiff.ok ? JSON.stringify(loopExitBeforeDiff.out) : loopExitBeforeDiff.error.slice(-160))

  const loopColonDiff = await drive('for x in a; do :; done; diff <(printf left) <(printf right)')
  check('compound for-loop with benign : before differing diff reads as files differ (exit 1)', loopColonDiff.ok && loopColonDiff.out.code === 1 && loopColonDiff.out.returnCodeInterpretation === 'files differ', loopColonDiff.ok ? JSON.stringify(loopColonDiff.out) : loopColonDiff.error.slice(0, 200))

  const loopDynamicBeforeDiff = await drive('c=exit; for x in a; do "$c" 1; done; diff <(printf same) <(printf same)')
  check('compound for-loop with dynamic command before closing diff stays an error', !loopDynamicBeforeDiff.ok && /Exited with code 1/.test(loopDynamicBeforeDiff.error), loopDynamicBeforeDiff.ok ? JSON.stringify(loopDynamicBeforeDiff.out) : loopDynamicBeforeDiff.error.slice(-160))

  const paramAbortBeforeDiff = await drive('F=$(printf x); : "${MERCURY_UNSET_PROBE_0X:?missing}"; diff <(printf same) <(printf same)')
  check('compound prefix parameter-error abort before closing diff stays an error', !paramAbortBeforeDiff.ok && /Exited with code 1/.test(paramAbortBeforeDiff.error), paramAbortBeforeDiff.ok ? JSON.stringify(paramAbortBeforeDiff.out) : paramAbortBeforeDiff.error.slice(-160))

  const arithAbortBeforeDiff = await drive('F=$((1/0)); diff <(printf same) <(printf same)')
  check('compound prefix arithmetic-error abort before closing diff stays an error', !arithAbortBeforeDiff.ok && /Exited with code 1/.test(arithAbortBeforeDiff.error), arithAbortBeforeDiff.ok ? JSON.stringify(arithAbortBeforeDiff.out) : arithAbortBeforeDiff.error.slice(-160))

  section('§6 exit 1 is a result only when the closing command ran last (each command runs in the real shell, through the tool)')
  const carried = await drive('declare -F fixture_precheck fixture_helper')
  const snapshots = join(proofHome, 'shell-snapshots')
  check(
    'the two profile functions of the fixture are defined in the shell the tool runs',
    carried.ok && carried.out.code === 0 && carried.out.stdout.includes('fixture_precheck') && carried.out.stdout.includes('fixture_helper'),
    `${JSON.stringify(carried.ok ? carried.out.stdout : carried.error.slice(-160))}; the home is ${homedir()}, the snapshots are ${existsSync(snapshots) ? readdirSync(snapshots).join(', ') || 'none' : 'none'} — the rows below that call them rest on this: a bash of Windows gets a function only from a snapshot, and the snapshot carries functions only when a .bashrc stands in the home os.homedir() names (collectDefinitions in createAndSaveSnapshot, src/platform/shell/bash/shellSnapshot.ts), so this proof must start in its fixture home (the top of this file starts it again there)`,
  )
  const KILLED = 'the shell killed before the closing grep'
  const signalEndReadsAsNothing = spawnSync(served.path, ['-c', 'kill -TERM $$'], { encoding: 'utf8' }).status === 0
  type Want = 'error' | 'ok' | 'no matches found' | 'files differ' | 'condition is false'
  const RAN_LAST: Array<[string, string, Want, { timeout?: number }?]> = [
    ['a profile function that exits before the closing diff', 'fixture_precheck; diff <(printf same) <(printf same)', 'error'],
    ['a profile function that returns 1 before && diff of two equal files', `fixture_helper && diff ${LEFT} ${EQUAL}`, 'error'],
    ['false && grep: grep never ran', 'false && grep missing /dev/null', 'error'],
    ['exit 1 before the closing grep', 'v=$(printf x); exit 1; grep missing /dev/null', 'error'],
    ['true && diff of two different files: diff ran last', `true && diff ${LEFT} ${DIFFERENT}`, 'files differ'],
    ['false || grep: grep ran last', `false || grep missing ${LEFT}`, 'no matches found'],
    ['true || grep: nothing failed', `true || grep missing ${LEFT}`, 'ok'],
    ['a loop, then grep', `for x in a b; do printf '%s\\n' "$x"; done; grep missing ${LEFT}`, 'no matches found'],
    ['a function that returns 1 before && diff', `own_helper() { return 1; }; own_helper && diff ${LEFT} ${EQUAL}`, 'error'],
    ["the user's own grep function is the grep that ran last", `grep() { command grep "$@"; }; grep missing ${LEFT}`, 'no matches found'],
    ['a failing subshell before && grep', `(printf 'sub\\n'; exit 1) && grep missing ${LEFT}`, 'error'],
    ['a failing subshell, then diff of two different files', `(exit 1); diff ${LEFT} ${DIFFERENT}`, 'files differ'],
    ['the same closing command written twice around a failing subshell', `grep missing ${LEFT}; (exit 1) && grep missing ${LEFT}`, 'error'],
    ['pipefail and an earlier stage that fails before a grep that matches', `set -o pipefail; false | grep same ${LEFT}`, 'error'],
    ['pipefail and a last stage that finds nothing', "set -o pipefail; printf 'input\\n' | grep missing", 'no matches found'],
    ['a backgrounded command, then grep', `sleep 0 & grep missing ${LEFT}`, 'no matches found'],
    ['a backgrounded failure waited for before && grep', `false & wait $! && grep missing ${LEFT}`, 'error'],
    ['a here-document read by the closing grep', "grep missing <<'END'\nactual\nEND", 'no matches found'],
    ['a here-document piped to the closing grep', "cat <<'END' | grep missing\nactual\nEND", 'no matches found'],
    ['a here-document whose line goes on with && test: the test ran last', "grep same <<'END' && test -f /mercury-no-such-file-0x\nsame\nEND", 'condition is false'],
    ['a here-document whose line goes on with && grep: the grep ran last', `cat > ${WORK}/written <<'END' && grep -c missing ${WORK}/written\nactual\nEND`, 'no matches found'],
    ['a here-document read by a grep that finds nothing, && test never ran', "grep missing <<'END' && test -f /mercury-no-such-file-0x\nactual\nEND", 'error'],
    ['process substitution in the closing diff', 'diff <(printf a) <(printf b)', 'files differ'],
    ['a script that sets a trap is left unmarked, and reads as on 1.1.0: an EXIT trap that turns a matching grep into exit 1', `trap 'exit 1' EXIT; grep same ${LEFT}`, 'no matches found'],
    [KILLED, `kill -TERM $$; grep missing ${LEFT}`, 'error'],
    ['a timeout before the closing grep', `sleep 5; grep missing ${LEFT}`, 'error', { timeout: 400 }],
    ['--verbose is an everyday word: the profile function that exits before diff is still an error', `fixture_precheck --verbose; diff ${LEFT} ${EQUAL}`, 'error'],
    ['--verbose on a command that fails before && grep', `false --verbose && grep missing ${LEFT}`, 'error'],
    ['DEBUG as a value, then the shape of the field', `LOG_LEVEL=DEBUG; F=$(printf 'alpha\\n'); printf '%s\\n' "$F" | grep -c nomatch`, 'no matches found'],
    ['DEBUG as the pattern searched for, after a profile function that exits', `fixture_precheck; grep DEBUG ${LEFT}`, 'error'],
    ['DEBUG in a comment above false && grep', `# DEBUG\nfalse && grep missing ${LEFT}`, 'error'],
    ['$? inside single quotes is text, not a read of the status', `false && grep -c 'cost: $?' ${LEFT}`, 'error'],
    ['builtin redefined by the script before a grep that exits 2', `builtin() { :; }; grep -e '[' ${LEFT}`, 'error'],
    ['IFS set to a digit before a grep of its own that exits 10', `IFS=0; grep() { return 10; }; grep missing ${LEFT}`, 'error'],
    ['a closing test that reads $? sees the status before it (the command is left unmarked)', '(exit 3); [ $? -eq 3 ]', 'ok'],
    ['a closing test that reads $? and is false is left unmarked, and reads as on 1.1.0', 'false; test $? -eq 0', 'error'],
    ['a function of the script hands $? to the closing test', 'st() { echo $?; }; false; test "$(st)" = 1', 'ok'],
    ['the closing test reads $? through an indirect name', `s='?'; false; test "\${!s}" = 1`, 'ok'],
    ['the closing test reads $? through eval', `false; test "$(eval 'echo $?')" = 1`, 'ok'],
    ['a function of the script, first stage of the closing pipeline, reads $?', 'st() { [ "$?" = 1 ] && echo failed; }; false; st | grep -c failed', 'ok'],
    ['the closing test sources a file that reads $?', `printf 'echo $?\\n' > ${WORK}/reads-status; false; test "$(. ${WORK}/reads-status)" = 1`, 'ok'],
  ]
  for (const [label, command, want, more] of RAN_LAST) {
    if (label === KILLED && signalEndReadsAsNothing) {
      console.log(`  [SKIP — LOUD] ${label}: the runtime this proof runs under reads 0 from a bash that a signal ended (the MSYS runtime leaves with the signal times 256 and bun on Windows hands back the low byte), so the row would read the runtime and not the tool; under node the guard reads that status as 128 plus the signal (statusAnMsysShellLeaves in src/platform/shell/parentGuard.ts, held by prove-win32-shell-tree-ends.ts)`)
      continue
    }
    const ran = await drive(command, more)
    const said = ran.ok ? (ran.out.code === 0 ? 'ok' : (ran.out.returnCodeInterpretation ?? `result with exit ${String(ran.out.code)}`)) : 'error'
    check(`${label}: ${want}`, said === want, `${JSON.stringify(command)} read as ${said}${ran.ok ? '' : ` (${ran.error.slice(-120)})`} — ${WIRED_HINT}`)
  }

  section("§7 the user's traps, options and output are the same with the marks as without them (the same frame twice, in each bash)")
  const { createBashShellProvider } = await import('../../src/platform/shell/bashProvider.ts')
  const SIDE = `${WORK}/side`
  const TRACE = `${WORK}/trace`
  const INSTALL = `${WORK}/install`
  writeFileSync(shellPathToNative(INSTALL), `trap 'echo "$BASH_COMMAND rc=$?" >> ${SIDE}' DEBUG\n`)
  const STATUS = `${WORK}/status`
  writeFileSync(shellPathToNative(STATUS), `fixture_status() { echo "rc=$?" >> ${SIDE}; }\nfixture_run() { "$@"; }\n`)
  type Scene = [string, string, ('unmarked' | 'bound')?]
  const SCENES: Scene[] = [
    ['a plain miss', `grep missing ${LEFT}`],
    ['a plain match', `grep same ${LEFT}`],
    ['an ERR trap that writes a file', `trap 'echo "ERR:$?" >> ${SIDE}' ERR; false; grep missing ${LEFT}`, 'unmarked'],
    ['an ERR trap under errtrace', `set -E; trap 'echo "ERR:$?" >> ${SIDE}' ERR; false; grep missing ${LEFT}`, 'unmarked'],
    ['an EXIT trap that writes the status and the functions it can see', `trap 'echo "EXIT:$? $(declare -F | wc -l | tr -d " ")" >> ${SIDE}' EXIT; grep missing ${LEFT}`, 'unmarked'],
    ['an EXIT trap that exits 3 after a miss', `trap 'exit 3' EXIT; grep missing ${LEFT}`, 'unmarked'],
    ['an EXIT trap that reads $_ after a miss', `trap 'echo "last word: $_" >> ${SIDE}' EXIT; grep missing ${LEFT}`, 'unmarked'],
    ['an EXIT trap that reads PIPESTATUS after exit 2', `trap 'echo "stages: \${PIPESTATUS[*]}" >> ${SIDE}' EXIT; grep -e '[' ${LEFT}`, 'unmarked'],
    ['an EXIT trap that lists the variables after exit 2', `trap 'compgen -v | grep -c mercury >> ${SIDE}' EXIT; grep -e '[' ${LEFT}`, 'unmarked'],
    ['an EXIT trap that only removes a file', `trap 'rm -f ${SIDE}' EXIT; grep missing ${LEFT}`, 'unmarked'],
    ['a RETURN trap', `own() { :; }; trap 'echo RET >> ${SIDE}' RETURN; own; grep missing ${LEFT}`, 'unmarked'],
    ['set -x', `set -x; printf 'shown\\n'; grep missing ${LEFT}`],
    ['set -x and exit 2', `set -x; grep -e '[' ${LEFT}`],
    ['set -e before a miss', `set -e; true; grep missing ${LEFT}`],
    ['set -e and an earlier failure', `set -e; printf 'started\\n'; false; printf 'after\\n'; grep missing ${LEFT}`],
    ['set -e and a pipe', `set -e; cat ${LEFT} | grep missing`],
    ['set -u', `set -u; grep missing ${LEFT}`],
    ['set -o posix', `set -o posix; grep missing ${LEFT}`],
    ['set -C and set -f', `set -C; set -f; grep missing ${LEFT}`],
    ['pipefail, an earlier stage fails', `set -o pipefail; false | grep same ${LEFT}`],
    ['the variables the closing command can list', 'x=1; compgen -v | grep -c __mercury'],
    ['the environment under set -a', 'set -a; env | grep -c __mercury'],
    ["the frame's own names used by the script", '__mercury_none=keep; test "$__mercury_none" = keep'],
    ["the frame's own names made readonly", `readonly __mercury_none=1; grep missing ${LEFT}`],
    ['printf, exit and return redefined by the script', `printf() { echo hijacked; }; exit() { echo hijacked; }; return() { echo hijacked; }; grep missing ${LEFT}`],
    ['$_ read by the closing command', `mkdir -p ${WORK}/made && test -f "$_"`],
    ['exit 2 from the closing command', `grep -e '[' ${LEFT}`],
    ['exit 2 with an ERR trap', `trap 'echo "ERR:$?" >> ${SIDE}' ERR; grep --no-such-flag-0x x ${LEFT}`, 'unmarked'],
    ['builtin redefined before exit 2', `builtin() { :; }; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a builtin of the script that prints what it is called with', `builtin() { echo called "$@"; }; grep -e '[' ${LEFT}`, 'unmarked'],
    ['builtin and exit both redefined before exit 2', `builtin() { :; }; exit() { :; }; grep -e '[' ${LEFT}`, 'unmarked'],
    ['builtin redefined with the function keyword', `function builtin { echo called "$@"; }; grep -e '[' ${LEFT}`, 'unmarked'],
    ['exit switched off by enable -n before exit 2', `enable -n exit; grep -e '[' ${LEFT}`, 'unmarked'],
    ['enable as the word of another command', `true enable --now; grep missing ${LEFT}`],
    ['IFS a digit and exit 10, 101 and 110 from a grep of its own', `IFS=0; grep() { return "$1"; }; grep 10; a=$?; grep 110; b=$?; echo "$a $b"; grep 101`],
    ['IFS a digit and a miss', `IFS=1; grep missing ${LEFT}`],
    ['the closing command skipped by &&', `false && grep missing ${LEFT}`],
    ['the closing command reached by ||', `false || grep missing ${LEFT}`],
    ['the closing command skipped by ||', `true || grep missing ${LEFT}`],
    ['a here-document piped to the closing grep', "cat <<'END' | grep missing\nactual\nEND"],
    ['the closing command reads standard input', 'grep same'],
    ['a backgrounded command before it', `sleep 0 & grep missing ${LEFT}`],
    ['an arithmetic error before it', `F=$((1/0)); diff ${LEFT} ${EQUAL}`],
    ['--verbose as an everyday word', `true --verbose; grep missing ${LEFT}`],
    ['DEBUG as a value', `LOG_LEVEL=DEBUG; grep missing ${LEFT}`],
    ['DEBUG in a comment', `# DEBUG\ngrep missing ${LEFT}`],
    ['$? inside single quotes', `grep -c 'cost: $?' ${LEFT}`],
    ['verbose as a word outside set and shopt', `printf 'verbose\\n'; grep -e '[' ${LEFT}`],
    ['set and -v as the words of another command', `printf '%s\\n' set-url origin -v; grep missing ${LEFT}`],
    ['trap as a word searched for, beside debug', `grep -c trap ${LEFT}; grep debug ${LEFT}`],
    ['set -e ahead of a command with -v', `set -e; grep -v same ${LEFT}`],
    ['PIPESTATUS read by the closing test', 'false; test "${PIPESTATUS[0]}" = 1'],
    ['a function of the script that reads no status, called by the closing test', 'say() { echo ok; }; false; test "$(say)" = ok'],
    ['a function that reads $? after its own command', `run() { "$@"; rc=$?; return $rc; }; run true; grep missing ${LEFT}`],
    ['a function that reads $? in its second statement, called by the closing test', 'st() { :; echo $?; }; false; test "$(st)" = 0'],
    ['a file sourced before the closing command, and a dot in its words', `. ${STATUS}; grep -c 'a . b' ${LEFT}`],
    ['eval and source as words the closing grep searches for', `false; grep -c -e eval -e source ${LEFT}`],
    ['set -euo pipefail ahead of a pipe with --verbose', `set -euo pipefail\ntrue --verbose | grep -c missing`],
    ['--set and a variable in the words of another command', `v=1; true --set image=$v; grep missing ${LEFT}`],
    ['a command held in a variable', `tool=true; $tool --quiet; grep missing ${LEFT}`],
    ['a DEBUG trap that counts commands', `trap 'echo "$BASH_COMMAND rc=$?" >> ${SIDE}' DEBUG; false; grep missing ${LEFT}`, 'unmarked'],
    ['a debug trap in small letters', `trap 'echo "rc=$?" >> ${SIDE}' debug; false; grep missing ${LEFT}`, 'unmarked'],
    ['a Debug trap before exit 2', `trap 'echo seen >> ${SIDE}' Debug; grep -e '[' ${LEFT}`, 'unmarked'],
    ['trap -- with a quoted DEBUG', `trap -- 'echo seen >> ${SIDE}' "DEBUG"; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap whose name is held in a variable', `t=DEBUG; trap 'echo seen >> ${SIDE}' "$t"; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap whose name another command hands over', `read -r t <<< debug; trap 'echo seen >> ${SIDE}' "$t"; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set by a quoted trap', `'trap' 'echo "rc=$?" >> ${SIDE}' DEBUG; false; grep missing ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set by an escaped trap', `\\trap 'echo seen >> ${SIDE}' DEBUG; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set through eval', `eval "trap 'echo seen >> ${SIDE}' DEBUG"; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set by a command held in a variable', `c=trap; $c 'echo seen >> ${SIDE}' DEBUG; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set behind an assignment', `X=1 trap 'echo "rc=$?" >> ${SIDE}' debug; false; grep missing ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set by a function', `watch() { trap 'echo seen >> ${SIDE}' DEBUG; }; watch; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap handed to a function of the script', `run() { "$@"; }; run trap 'echo seen >> ${SIDE}' DEBUG; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a trap word another command hands over', `read -r c <<< trap; $c 'echo seen >> ${SIDE}' DEBUG; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap set through an alias', `shopt -s expand_aliases\nalias watch=trap\nwatch 'echo seen >> ${SIDE}' DEBUG\ngrep -e '[' ${LEFT}`, 'unmarked'],
    ['an EXIT trap that reads $BASH_COMMAND', `trap 'echo "last: $BASH_COMMAND" >> ${SIDE}' EXIT; grep -e '[' ${LEFT}`, 'unmarked'],
    ['$BASH_COMMAND named anywhere', `printf '%s\\n' "$BASH_COMMAND" >> ${SIDE}; grep missing ${LEFT}`, 'unmarked'],
    ['shopt -so verbose', `shopt -so verbose\ngrep missing ${LEFT}`, 'unmarked'],
    ['a closing command that reads $? inside double quotes', `(exit 3); grep -c "$?" ${LEFT}`, 'unmarked'],
    ['a DEBUG trap under functrace', `set -T; trap 'echo "$BASH_COMMAND" >> ${SIDE}; echo seen' DEBUG; true; grep missing ${LEFT}`, 'unmarked'],
    ['set -v', `set -v\ntrue\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -o verbose', `set -o verbose\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -eu -v', `set -eu -v\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -v through eval', `eval 'set -v'\ngrep missing ${LEFT}`, 'unmarked'],
    ['an escaped set -v', `\\set -v\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -v behind builtin', `builtin set -v\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -o with verbose held in a variable', `o=verbose; set -o "$o"\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -v made by printf and run by eval', `printf -v line 'set -v'; eval "$line"\ngrep missing ${LEFT}`, 'unmarked'],
    ['set -v behind time', `TIMEFORMAT=; time set -v\ngrep missing ${LEFT}`, 'unmarked'],
    ['BASH_XTRACEFD', `exec 9>${TRACE}; BASH_XTRACEFD=9; set -x; true; grep missing ${LEFT}`, 'unmarked'],
    ['a PS4 that runs a command at every traced line', `PS4='$(echo traced >> ${SIDE})+ '; set -x; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a closing command that reads $?', '(exit 3); [ $? -eq 3 ]', 'unmarked'],
    ['a closing command that reads ${?}', '(exit 3); [ "${?}" = 3 ]', 'unmarked'],
    ['a closing command that reads $? in a substitution', '(exit 3); test "$(printf %s "$?")" = 3', 'unmarked'],
    ['a function of the script that reads $?, called by the closing test', 'st() { echo $?; }; false; test "$(st)" = 1', 'unmarked'],
    ['a function of the script that reads $?, first stage of the closing pipeline', 'st() { [ "$?" = 1 ] && echo failed; }; false; st | grep -c failed', 'unmarked'],
    ['a function with a redirection of its own that reads $?', 'st() { echo $?; } 2>/dev/null; false; test "$(st)" = 1', 'unmarked'],
    ['a function that reads $? through eval', `st() { eval 'echo $?'; }; false; test "$(st)" = 1`, 'unmarked'],
    ['a closing test that reads $? through an indirect name', `s='?'; false; test "\${!s}" = 1`, 'unmarked'],
    ['a closing test that reads $? through eval', `false; test "$(eval 'echo $?')" = 1`, 'unmarked'],
    ['a closing test that sources a file that reads $?', `printf 'echo $?\\n' > ${WORK}/reads-status; false; test "$(. ${WORK}/reads-status)" = 1`, 'unmarked'],
    ['a closing pipeline whose first stage sources a file', `printf 'echo $?\\n' > ${WORK}/reads-status; false; source ${WORK}/reads-status | grep -c 1`, 'unmarked'],
    ['a closing test that reads $? through eval behind an assignment and command', `false; test "$(X=1 command eval 'echo $?')" = 1`, 'unmarked'],
    ['a trap handed to mapfile as its callback', `mapfile -c 1 -C 'trap "echo seen >> ${SIDE}" DEBUG #' lines < ${LEFT}; grep -e '[' ${LEFT}`, 'unmarked'],
    ['a DEBUG trap installed by a sourced file reads $? as 0 at the closing command, and sees no other command', `. ${INSTALL}; false; grep missing ${LEFT}`, 'bound'],
    ['a DEBUG trap whose name is put together from pieces', `trap 'echo "rc=$?" >> ${SIDE}' DE"BUG"; false; grep missing ${LEFT}`, 'unmarked'],
    ['a trap word put together from pieces sets a DEBUG trap that does the same', `tr"ap" 'echo "rc=$?" >> ${SIDE}' DEBUG; false; grep missing ${LEFT}`, 'bound'],
    ['a function from a sourced file, called by the closing test, reads $? as 0 too', `. ${STATUS}; false; test "$(fixture_status)" = ""`, 'bound'],
    ['a function from a sourced file that runs its words sets a DEBUG trap that does the same', `. ${STATUS}; fixture_run trap 'echo "rc=$?" >> ${SIDE}' DEBUG; false; grep missing ${LEFT}`, 'bound'],
  ]
  const shells = [...new Set([served.path, '/bin/bash'].filter(path => existsSync(path)).map(path => realpathSync(path)))]
  let frames = 0
  for (const shell of shells) {
    const provider = await createBashShellProvider(systemShellAt(shell), { skipSnapshot: process.platform !== 'win32' })
    const version = spawnSync(shell, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' }).stdout
    for (const [label, command, kind] of SCENES) {
      const closing = closingTableCommand(command, await rootOf(command))
      const runs: string[] = []
      let marked = false
      for (const withMarks of [false, true]) {
        for (const file of [SIDE, TRACE]) rmSync(shellPathToNative(file), { force: true })
        const id = `frame${++frames}`
        const built = await provider.buildExecCommand(command, { id, ...(withMarks && closing !== undefined ? { closing } : {}) })
        if (withMarks) marked = built.closingMarks !== undefined
        const start = built.handOver?.({ ...process.env }, WORK_FOLDER)
        if (start?.file !== undefined) writeFileSync(start.file.path, start.file.text)
        const ran = spawnSync(shell, start?.args ?? ['-c', built.commandString], { cwd: start?.startIn ?? WORK_FOLDER, encoding: 'utf8', timeout: 10_000 })
        const written = [SIDE, TRACE].map(file => (existsSync(shellPathToNative(file)) ? readFileSync(shellPathToNative(file), 'utf8') : ''))
        for (const file of [built.cwdFilePath, built.pipelineStatusPath, built.jobsPath, built.closingMarks?.reached, built.closingMarks?.endedOnOne]) if (file !== undefined) rmSync(shellPathToNative(file), { force: true })
        if (start?.file !== undefined) rmSync(start.file.path, { force: true })
        runs.push(JSON.stringify({ stdout: ran.stdout, stderr: ran.stderr, status: ran.status, signal: ran.signal, written }).replaceAll(id, 'ID'))
      }
      const hint = `bash ${version}: ${JSON.stringify(command)}\n      without: ${runs[0]}\n      with:    ${runs[1]}\n      the marks are marksTheClosing and marksAnEndOnOne in src/platform/shell/bashProvider.ts; a script that can see them is left unmarked by closingTableCommand in src/tools/shell/commandSemantics.ts, which asks watchesItsShell in src/permissions/rules/decision/command-analysis/commandSpans.ts`
      if (kind === 'bound') {
        const seen = runs[0]!.lastIndexOf('rc=1\\n')
        check(`bash ${version} · stated bound: ${label}`, marked && seen !== -1 && runs[1] === `${runs[0]!.slice(0, seen)}rc=0\\n${runs[0]!.slice(seen + 6)}`, hint)
      } else if (kind === 'unmarked') {
        check(`bash ${version} · ${label}: the script can see a mark, so the frame carries none and runs the same`, !marked && runs[0] === runs[1], hint)
      } else {
        check(`bash ${version} · ${label}: marked, and the same output, exit code and files written`, marked && runs[0] === runs[1], hint)
      }
    }
  }

  const engine = await createBashShellProvider({ ...systemShellAt(served.path), origin: 'engine' }, { skipSnapshot: true })
  const plain = `grep missing ${LEFT}`
  const underEngine = await engine.buildExecCommand(plain, { id: 'engine', closing: closingTableCommand(plain, await rootOf(plain)) })
  check('a frame built for the bundled engine carries no marks (it has no pipeline record to read them with)', underEngine.closingMarks === undefined, `${underEngine.commandString} — buildExecCommand in src/platform/shell/bashProvider.ts marks only a bash, never a record whose origin is engine`)

  section('§8 the marks are gone when the command has settled')
  await new Promise(resolve => setTimeout(resolve, 500))
  const left = readdirSync(FRAMES).filter(name => name.startsWith('mercury-cwd-'))
  check('no frame file is left in the temp folder after every command above', left.length === 0, `${left.join(', ')} — afterTheCommand in src/platform/shell/shellExec.ts drops the closing marks with the other frame files`)

  section('§9 a bash of Windows gets the same two statements (a child that stands in for win32 builds its frames; they are read, and run, here)')
  const STAND_IN = join(SCRATCH, 'win32')
  mkdirSync(join(STAND_IN, 'home'), { recursive: true })
  const standIn = join(STAND_IN, 'frames.ts')
  const fromSrc = (...parts: string[]): string => JSON.stringify(join(ROOT, 'src', ...parts))
  writeFileSync(
    standIn,
    [
      `Object.defineProperty(process, 'platform', { value: 'win32' })`,
      `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }`,
      `const { readFileSync } = await import('node:fs')`,
      `const { join } = await import('node:path')`,
      `const { createBashShellProvider } = await import(${fromSrc('platform', 'shell', 'bashProvider.ts')})`,
      `const { systemShellAt } = await import(${fromSrc('platform', 'shell', 'shellRecord.ts')})`,
      `const { shellPathToNative } = await import(${fromSrc('platform', 'host-os', 'paths.ts')})`,
      `const gone = systemShellAt(join(process.cwd(), 'no-bash.exe'))`,
      `const roads = {`,
      `  plain: await createBashShellProvider(gone),`,
      `  login: await createBashShellProvider(systemShellAt('/bin/bash'), { skipSnapshot: true }),`,
      `  engine: await createBashShellProvider({ ...gone, origin: 'engine' }, { skipSnapshot: true }),`,
      `}`,
      `const rows = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as Array<{ id: string; command: string; closing?: object }>`,
      `const frames = []`,
      `for (const { id, command, closing } of rows) {`,
      `  const built = async (road: keyof typeof roads, marks: boolean) => {`,
      `    const frame = await roads[road].buildExecCommand(command, { id, ...(marks && closing !== undefined ? { closing } : {}) })`,
      `    const file = frame.handOver?.({ MSYS: 'noglob' })`,
      `    const native = [frame.cwdFilePath, frame.closingMarks?.reached, frame.closingMarks?.endedOnOne].map(path => (path === undefined ? undefined : shellPathToNative(path)))`,
      `    return { text: frame.commandString, cwd: frame.cwdFilePath, pipeline: frame.pipelineStatusPath, marks: frame.closingMarks, native, start: frame.handOver?.({}).args.slice(0, -1), line: frame.handOver?.({}).args.at(-1), far: frame.handOver?.({}, process.argv[3]).args.at(-1), carried: file?.file, loader: file?.args }`,
      `  }`,
      `  frames.push({ id, command, closing, bare: await built('plain', false), plain: await built('plain', true), login: await built('login', true), engine: await built('engine', true) })`,
      `}`,
      `console.log('FRAMES ' + JSON.stringify(frames))`,
      `process.exit(0)`,
    ].join('\n'),
  )
  type Built = { text: string; cwd: string; pipeline?: string; marks?: { reached: string; endedOnOne: string }; native: Array<string | null>; start?: string[]; line?: string; far?: string; carried?: { path: string; text: string }; loader?: string[] }
  type Framed = { id: string; command: string; closing?: { at: number }; bare: Built; plain: Built; login: Built; engine: Built }
  const framedOnWindows = async (temp: string, far: string, tag: string, commands: string[]): Promise<{ rows: Framed[]; detail: string }> => {
    const asked: Array<{ id: string; command: string; closing: ReturnType<typeof closingTableCommand> }> = []
    for (const [i, command] of commands.entries()) {
      asked.push({ id: `${tag}${i}`, command, closing: closingTableCommand(command, await rootOf(command)) })
    }
    const inputs = join(STAND_IN, `${tag}.json`)
    writeFileSync(inputs, JSON.stringify(asked))
    const child = spawnSync(process.execPath, ['run', standIn, inputs, far], { cwd: STAND_IN, encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, MERCURY_CONFIG_DIR: 'home' } })
    const line = (child.stdout ?? '').split('\n').find(l => l.startsWith('FRAMES '))
    return { rows: line === undefined ? [] : (JSON.parse(line.slice(7)) as Framed[]), detail: `the child ended ${String(child.status)}: ${String(child.stderr ?? '').trim().slice(-400)}` }
  }
  const WINDOWS_HINT = 'buildExecCommand in src/platform/shell/bashProvider.ts gives a bash of Windows the two statements of marksTheClosing and marksAnEndOnOne, their files spelled beside its cwd file as that bash spells it (windowsPathToPosixPath), except for the bundled engine and for a bash the hand-over starts with -l'
  const WINDOWS_TEMP = 'C:\\Users\\Box User\\AppData\\Local\\Temp'
  const TEMP_IN_BASH = '/c/Users/Box User/AppData/Local/Temp'
  const FAR_THERE = `C:\\far\\${'d'.repeat(270)}`
  const MARKED_THERE = ['grep missing left', "cd sub; printf 'x\\n' | grep -c y", 'false || test -f absent', 'true && diff left other', "cat <<'END' | grep missing\nactual\nEND", "grep same <<'END' && test -f absent\nsame\nEND", 'sleep 0 & grep missing left']
  const UNMARKED_THERE = ["trap 'rm -f held' EXIT; grep missing left", 'st() { echo $?; }; false; test "$(st)" = 1', 'set -v\ngrep missing left', 'grep missing left; true']
  const there = await framedOnWindows(WINDOWS_TEMP, FAR_THERE, 'there', [...MARKED_THERE, ...UNMARKED_THERE])
  check('the child that stands in for win32 answers with a frame for every command', there.rows.length === MARKED_THERE.length + UNMARKED_THERE.length, there.detail)
  const count = (text: string, part: string): number => text.split(part).length - 1
  const asHanded = (frame: Built): string => (process.platform === 'win32' ? (frame.line ?? frame.text) : frame.text)
  const inEval = (text: string): string => text.replaceAll("'", "'\\''")
  for (const { id, command, closing, bare, plain, login, engine } of there.rows) {
    const cwd = `${TEMP_IN_BASH}/mercury-cwd-${id}`
    const show = `\n      without: ${bare.text}\n      with:    ${plain.text}\n      ${WINDOWS_HINT}`
    if (!MARKED_THERE.includes(command)) {
      check(`${JSON.stringify(command)} can see a mark or closes on another command, so its frame is the frame without them`, plain.marks === undefined && plain.text === bare.text, show)
      continue
    }
    let shared = 0
    while (shared < bare.text.length && bare.text[shared] === plain.text[shared]) shared++
    const tail = bare.text.slice(shared)
    const at = plain.text.indexOf(tail, shared)
    const reached = at === -1 ? '' : plain.text.slice(shared, at)
    const ended = at === -1 ? '' : plain.text.slice(at + tail.length)
    const stands = closing !== undefined && plain.text.slice(0, shared).endsWith(inEval(command.slice(0, closing.at))) && tail.startsWith(inEval(command.slice(closing.at)))
    check(`${JSON.stringify(command)}: the frame is the frame without marks plus two statements, one right before the closing command and one after the whole frame`, stands && at !== -1 && reached !== '' && ended.startsWith(' || ') && !`${reached}${ended}`.includes('\n'), show)
    check('…each names one file of its own beside the cwd file, in the form that bash spells that file, single-quoted for the blank', bare.cwd === cwd && plain.marks?.reached === `${cwd}-closing` && plain.marks.endedOnOne === `${cwd}-closing-1` && count(reached, `${cwd}-closing'`) === 1 && count(ended, `'${cwd}-closing-1'`) === 1 && count(plain.text, `${cwd}-closing`) === 2 && !plain.text.includes('C:\\'), `${JSON.stringify([bare.cwd, plain.marks])}${show}`)
    check('…and read back as native paths they stand in the temp folder beside the cwd file, where the tool looks for them', JSON.stringify(plain.native) === JSON.stringify(['', '-closing', '-closing-1'].map(end => `${WINDOWS_TEMP}\\mercury-cwd-${id}${end}`)), `${JSON.stringify(plain.native)} — readClosingMarks in src/platform/shell/shellExec.ts is handed shellPathToNative of each mark`)
    check('…the bash that gets them is started with -c alone; a frame the command line cannot carry rides whole in its file, and one for a start folder too long for Windows rides whole behind its cd', JSON.stringify(plain.start) === '["-c"]' && plain.marks !== undefined && plain.carried?.text.endsWith(`\n${plain.text}`) === true && plain.far?.startsWith(`cd -- /c/far/${'d'.repeat(270)} || exit; `) === true && plain.far.endsWith(plain.text), `${JSON.stringify([plain.start, plain.carried?.text.slice(-200), plain.far?.slice(0, 400)])} — ${WINDOWS_HINT}`)
    check('…a bash started with -l gets the frame without them, and so does the bundled engine', JSON.stringify(login.start) === '["-c","-l"]' && login.marks === undefined && login.text === bare.text && engine.marks === undefined && !engine.text.includes('-closing'), `${JSON.stringify([login.start, login.marks, engine.marks])} — ${WINDOWS_HINT}`)
    for (const shell of shells) {
      const carried = join(STAND_IN, 'carried')
      writeFileSync(carried, plain.carried?.text ?? plain.text)
      const parsed = [spawnSync(shell, ['-n', '-c', asHanded(plain)], { encoding: 'utf8', timeout: 10_000 }), spawnSync(shell, ['-n', nativePathToShell(carried)], { encoding: 'utf8', timeout: 10_000 })]
      check(`…${shell} reads that frame, and the file that carries it, without a syntax error`, plain.marks !== undefined && parsed.every(run => run.status === 0 && run.stderr === ''), `${parsed.map(run => run.stderr).join('')}${show}`)
    }
  }

  const LOGOUT_HOME = join(STAND_IN, 'login-home')
  const LOGOUT_READ = join(STAND_IN, 'logout-read')
  mkdirSync(LOGOUT_HOME)
  writeFileSync(join(LOGOUT_HOME, '.bash_logout'), `echo read >> ${nativePathToShell(LOGOUT_READ)}\n`)
  const RUN_HERE: Array<[string, string, number, boolean, boolean]> = [
    ['a miss', `grep missing ${LEFT}`, 1, true, true],
    ['a match', `grep same ${LEFT}`, 0, true, false],
    ['a closing command that && skips', `false && grep missing ${LEFT}`, 1, false, true],
    ['a closing command that ends on 2', `grep -e '[' ${LEFT}`, 2, true, false],
    ['a pipe that ends in a miss', "printf 'x\\n' | grep -c y", 1, true, true],
  ]
  const FAR_HERE = join(STAND_IN, 'd'.repeat(100), 'e'.repeat(100), 'f'.repeat(100))
  mkdirSync(FAR_HERE, { recursive: true })
  const here = await framedOnWindows(FRAMES, FAR_HERE, 'here', RUN_HERE.map(([, command]) => command))
  check("the child answers again, its temp folder now this proof's own", here.rows.length === RUN_HERE.length, here.detail)
  for (const shell of shells) {
    const version = spawnSync(shell, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' }).stdout
    const ranIn = (frame: Built, args: string[], env?: NodeJS.ProcessEnv): { said: string; status: number | null; marks: boolean[] } => {
      if (frame.carried !== undefined) writeFileSync(frame.carried.path, frame.carried.text)
      const run = spawnSync(shell, args, { cwd: WORK_FOLDER, encoding: 'utf8', timeout: 10_000, ...(env === undefined ? {} : { env }) })
      const marks = [frame.marks?.reached, frame.marks?.endedOnOne].map(file => file !== undefined && existsSync(shellPathToNative(file)))
      for (const file of [frame.cwd, frame.pipeline, frame.marks?.reached, frame.marks?.endedOnOne]) if (file !== undefined) rmSync(shellPathToNative(file), { force: true })
      if (frame.carried !== undefined) rmSync(frame.carried.path, { force: true })
      return { said: JSON.stringify({ stdout: run.stdout, stderr: run.stderr, status: run.status }), status: run.status, marks }
    }
    for (const [i, { command, bare, plain, login }] of here.rows.entries()) {
      const [label, , status, reached, endedOnOne] = RUN_HERE[i]!
      const want = JSON.stringify([reached, endedOnOne])
      const onTheLine = [ranIn(bare, [...(bare.start ?? []), asHanded(bare)]), ranIn(plain, [...(plain.start ?? []), asHanded(plain)])]
      const byFile = [ranIn(bare, bare.loader ?? []), ranIn(plain, plain.loader ?? [])]
      const behindCd = [ranIn(bare, [...(bare.start ?? []), bare.far ?? '']), ranIn(plain, [...(plain.start ?? []), plain.far ?? ''])]
      const roads: Array<[string, typeof onTheLine]> = [['on the command line', onTheLine], ['carried by its file', byFile], ['behind the cd of a long start folder', behindCd]]
      const told = `${JSON.stringify(command)}${roads.map(([road, [without, withMarks]]) => `\n      ${road}, without: ${without!.said}\n      with: ${withMarks!.said} marks ${JSON.stringify(withMarks!.marks)}`).join('')}\n      ${WINDOWS_HINT}`
      check(`bash ${version} · the Windows frame, ${label}: exit ${status}, the same output with the marks as without, on the command line, carried by its file and behind the cd of a long start folder; reached ${String(reached)}, ended on 1 ${String(endedOnOne)}`, plain.far?.startsWith(`cd -- ${nativePathToShell(FAR_HERE)} `) === true && [onTheLine, byFile, behindCd].every(([without, withMarks]) => without!.status === status && without!.said === withMarks!.said && JSON.stringify(withMarks!.marks) === want), told)
      if (status !== 2) continue
      rmSync(LOGOUT_READ, { force: true })
      const asLogin = ranIn(login, [...(login.start ?? []), asHanded(login)], { ...process.env, HOME: LOGOUT_HOME })
      check(`bash ${version} · the frame a bash started with -l gets ends on 2 without calling exit, so the user's ~/.bash_logout is not read (the marks leave a status of 2 or more through exit, which a login shell answers by reading that file)`, JSON.stringify(login.start) === '["-c","-l"]' && asLogin.status === 2 && !existsSync(LOGOUT_READ), `${asLogin.said}; the logout file was ${existsSync(LOGOUT_READ) ? 'read' : 'not read'} — ${WINDOWS_HINT}`)
    }
  }

  section('§10 the reading rests on the tree the call itself holds: a collection between the permission check and the call changes no reading')
  const ROOT_HINT = 'runShellCommand in src/tools/shell/BashTool.tsx hands the tree its own parse answered to closingTableCommand and interpretCommandResult (src/tools/shell/commandSemantics.ts); neither may look the command up by its text, whose entry names the newest parse and is gone when that tree is collected'
  type Asker = { checkPermissions: (input: never, context: never) => Promise<{ behavior: string }> }
  const NOT_TAKEN = 'sixty collections over five seconds did not take the tree, so this check shows nothing'
  const turn = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const entryGoes = async (command: string): Promise<boolean> => {
    for (let round = 0; round < 60; round++) {
      await turn(round < 12 ? 5 : 100)
      Bun.gc(true)
      await turn()
      const stands = preparedCommandRoot(command) !== null
      await turn()
      if (!stands) return true
    }
    return false
  }
  const readAs = (ran: Drive): string => (ran.ok ? (ran.out.code === 0 ? 'ok' : (ran.out.returnCodeInterpretation ?? `result with exit ${String(ran.out.code)}`)) : 'error')
  const askedThenCalled = async (command: string): Promise<{ gone: boolean; said: string }> => {
    const input = { command }
    await BashTool.prepare?.(input as never)
    await (BashTool as unknown as Asker).checkPermissions(input as never, toolContext)
    const gone = await entryGoes(command)
    try {
      const result = await (BashTool as unknown as Caller).call(input as never, toolContext)
      return { gone, said: readAs({ ok: true, out: result.data as Out, content: '' }) }
    } catch {
      return { gone, said: 'error' }
    }
  }
  const HELD: Array<[string, string, Want]> = [
    ['a variable, a pipe and a closing grep that misses', "F=$(printf 'alpha\\nbeta\\n'); printf '%s\\n' \"$F\" | grep -c nomatch", 'no matches found'],
    ['a loop, then a closing grep', `for x in a b; do printf '%s\\n' "$x" >/dev/null; done; grep missing ${LEFT}`, 'no matches found'],
    ['a job, then a closing grep', `sleep 0 & grep missing ${LEFT}`, 'no matches found'],
    ['a script that sets a trap, which carries no marks', `trap 'exit 1' EXIT; grep same ${LEFT}`, 'no matches found'],
    ['a script that turns verbose on, which carries no marks', `set -v\ngrep missing ${LEFT}`, 'no matches found'],
    ['pipefail and a first stage that fails', `set -o pipefail; false | grep same ${LEFT}`, 'error'],
    ['a closing grep that && skips', `false && grep missing ${LEFT}`, 'error'],
  ]
  for (const [label, command, want] of HELD) {
    const before = readAs(await drive(command))
    const again = await askedThenCalled(command)
    check(`${label}: asked for again, its tree collected between the permission check and the call, it reads ${want} as the call before it did`, before === want && again.gone && again.said === want, `${JSON.stringify(command)} read ${before}, then ${again.said}${again.gone ? '' : ` (${NOT_TAKEN})`} — ${ROOT_HINT}`)
  }
  const handed = `true; grep missing ${LEFT}`
  const kept = await rootOf(handed)
  await (BashTool as unknown as Asker).checkPermissions({ command: handed } as never, toolContext)
  const handedGone = await entryGoes(handed)
  check("with the text's own entry gone, the closing statement is found in the tree that was handed over", handedGone && closingTableCommand(handed, kept)?.stage === `grep missing ${LEFT}`, `${handedGone ? JSON.stringify(closingTableCommand(handed, kept)) : NOT_TAKEN} — ${ROOT_HINT}`)
  check('no tree at all leaves a script unmarked', closingTableCommand(handed, null) === undefined, ROOT_HINT)
  check("…and its exit 1 is read by the whole text's first word", interpretCommandResult(`grep missing ${LEFT}`, 1, '', '', undefined, null).message === 'no matches found' && interpretCommandResult(handed, 1, '', '', undefined, null).isError === true, ROOT_HINT)
  const pad = `# ${'x'.repeat(10_000)}`
  check('a command longer than the parser reads has no tree', (await rootOf(`grep missing ${LEFT} ${pad}`)) === null)
  const longMiss = readAs(await drive(`grep missing ${LEFT} ${pad}`))
  const longScript = readAs(await drive(`true; grep missing ${LEFT} ${pad}`))
  check("…and through the tool it is read by its first word: a grep that misses is a result, a longer script is an error", longMiss === 'no matches found' && longScript === 'error', `${longMiss}, ${longScript} — ${ROOT_HINT}`)
}

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)

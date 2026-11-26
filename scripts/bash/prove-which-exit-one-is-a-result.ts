#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'which-exit-one-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
const FRAMES = join(SCRATCH, 'frames')
const HOME = join(SCRATCH, 'home')
const WORK = join(SCRATCH, 'work')
for (const dir of [FRAMES, HOME, WORK]) mkdirSync(dir)
process.env.TMPDIR = FRAMES
process.env.HOME = HOME
const PROFILE = "fixture_precheck() { printf 'precheck ran\\n'; exit 1; }\nfixture_helper() { return 1; }\n"
for (const name of ['.bash_profile', '.bashrc', '.profile']) writeFileSync(join(HOME, name), PROFILE)
const LEFT = join(WORK, 'left')
const EQUAL = join(WORK, 'equal')
const DIFFERENT = join(WORK, 'different')
writeFileSync(LEFT, 'same\n')
writeFileSync(EQUAL, 'same\n')
writeFileSync(DIFFERENT, 'other\n')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { interpretCommandResult } = await import('../../src/tools/shell/commandSemantics.ts')
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
  check('the listing and the which lines are both in the output, the label last', listed.content.includes('total ') && listed.content.includes('/sh') && listed.content.endsWith('a name was not found (exit code 1)'), JSON.stringify(listed.content.slice(-160)))
}

section('§4 exit 2 and above stay errors; other words are untouched')
const two = await drive('which() { return 2; }; which x')
check('a which that exits 2 is still an error ending `Exited with code 2`', !two.ok && /Exited with code 2/.test(two.ok ? '' : two.error), `${two.ok ? JSON.stringify(two.content.slice(0, 120)) : two.error.slice(0, 120)} — only exit 1 of which is a result; interpretCommandResult in src/tools/shell/commandSemantics.ts must leave exit 2 an error`)
check('the table reads which exit 2 as an error', interpretCommandResult('which foo', 2, '', '').isError === true, 'interpretCommandResult in src/tools/shell/commandSemantics.ts must treat which exit 2 as an error')
check('the table reads which exit 1 as a result with the label', JSON.stringify(interpretCommandResult('which foo', 1, '', '')) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -v exit 1 as a result with the label', JSON.stringify(interpretCommandResult('command -v foo', 1, '', '')) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -V exit 1 the same way', interpretCommandResult('command -V foo', 1, '', '').isError === false)
check('a bare `command foo` (no -v) keeps the default reading: exit 1 is an error', interpretCommandResult('command foo', 1, '', '').isError === true)
check('which through env and assignments is still which', interpretCommandResult('FOO=1 env -i which foo', 1, '', '').isError === false)
check('grep exit 1 keeps its own label', JSON.stringify(interpretCommandResult('grep x y', 1, '', '')) === JSON.stringify({ isError: false, message: 'no matches found' }))
const plainFail = await drive('cat /mercury-no-such-file-0x')
check('an ordinary non-zero exit is still an error ending `Exited with code 1`', !plainFail.ok && /Exited with code 1/.test(plainFail.ok ? '' : plainFail.error), `${plainFail.ok ? 'settled as a result' : plainFail.error.slice(-80)} — only the lookup commands in the table in src/tools/shell/commandSemantics.ts may read exit 1 as a result`)

const WIRED_HINT = 'the shell marks that it reached the closing command and that the script then ended on 1 (marksTheClosing and marksAnEndOnOne in src/platform/shell/bashProvider.ts, read by readClosingMarks in src/platform/shell/shellExec.ts); interpretCommandResult in src/tools/shell/commandSemantics.ts reads exit 1 as a result only with both marks'

if (process.platform === 'win32') {
  console.log('\n  [SKIP — LOUD] the bash road of Windows carries no closing marks: its readings are those of §1 to §4')
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

  const quotedToken = await drive('cat /mercury-no-such-file-0x "foo; grep x"')
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
    ['the shell killed before the closing grep', `kill -TERM $$; grep missing ${LEFT}`, 'error'],
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
  ]
  for (const [label, command, want, more] of RAN_LAST) {
    const ran = await drive(command, more)
    const said = ran.ok ? (ran.out.code === 0 ? 'ok' : (ran.out.returnCodeInterpretation ?? `result with exit ${String(ran.out.code)}`)) : 'error'
    check(`${label}: ${want}`, said === want, `${JSON.stringify(command)} read as ${said}${ran.ok ? '' : ` (${ran.error.slice(-120)})`} — ${WIRED_HINT}`)
  }

  section("§7 the user's traps, options and output are the same with the marks as without them (the same frame twice, in each bash)")
  const { createBashShellProvider } = await import('../../src/platform/shell/bashProvider.ts')
  const { systemShellAt, systemShellRecord } = await import('../../src/platform/shell/shellRecord.ts')
  const { closingTableCommand } = await import('../../src/tools/shell/commandSemantics.ts')
  const SIDE = join(WORK, 'side')
  const TRACE = join(WORK, 'trace')
  const INSTALL = join(WORK, 'install')
  writeFileSync(INSTALL, `trap 'echo "$BASH_COMMAND rc=$?" >> ${SIDE}' DEBUG\n`)
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
    ['a DEBUG trap installed by a sourced file reads $? as 0 at the closing command, and sees no other command', `. ${INSTALL}; false; grep missing ${LEFT}`, 'bound'],
    ['a DEBUG trap whose name is put together from pieces', `trap 'echo "rc=$?" >> ${SIDE}' DE"BUG"; false; grep missing ${LEFT}`, 'unmarked'],
    ['a trap word put together from pieces sets a DEBUG trap that does the same', `tr"ap" 'echo "rc=$?" >> ${SIDE}' DEBUG; false; grep missing ${LEFT}`, 'bound'],
  ]
  const served = await systemShellRecord()
  const shells = [...new Set([served.path, '/bin/bash'].filter(path => existsSync(path)).map(path => realpathSync(path)))]
  let frames = 0
  for (const shell of shells) {
    const provider = await createBashShellProvider(systemShellAt(shell), { skipSnapshot: true })
    const version = spawnSync(shell, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' }).stdout
    for (const [label, command, kind] of SCENES) {
      await BashTool.prepare?.({ command } as never)
      const closing = closingTableCommand(command)
      const runs: string[] = []
      let marked = false
      for (const withMarks of [false, true]) {
        for (const file of [SIDE, TRACE]) rmSync(file, { force: true })
        const id = `frame${++frames}`
        const built = await provider.buildExecCommand(command, { id, ...(withMarks && closing !== undefined ? { closing } : {}) })
        if (withMarks) marked = built.closingMarks !== undefined
        const ran = spawnSync(shell, ['-c', built.commandString], { cwd: WORK, encoding: 'utf8', timeout: 10_000 })
        const written = [SIDE, TRACE].map(file => (existsSync(file) ? readFileSync(file, 'utf8') : ''))
        for (const file of [built.cwdFilePath, built.pipelineStatusPath, built.closingMarks?.reached, built.closingMarks?.endedOnOne]) if (file !== undefined) rmSync(file, { force: true })
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
  await BashTool.prepare?.({ command: plain } as never)
  const underEngine = await engine.buildExecCommand(plain, { id: 'engine', closing: closingTableCommand(plain) })
  check('a frame built for the bundled engine carries no marks (it has no pipeline record to read them with)', underEngine.closingMarks === undefined, `${underEngine.commandString} — buildExecCommand in src/platform/shell/bashProvider.ts marks only a bash, never a record whose origin is engine`)

  section('§8 the marks are gone when the command has settled')
  await new Promise(resolve => setTimeout(resolve, 500))
  const left = readdirSync(FRAMES).filter(name => name.startsWith('mercury-cwd-'))
  check('no frame file is left in the temp folder after every command above', left.length === 0, `${left.join(', ')} — afterTheCommand in src/platform/shell/shellExec.ts drops the closing marks with the other frame files`)
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

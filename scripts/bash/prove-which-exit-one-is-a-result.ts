#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { interpretCommandResult } = await import('../../src/tools/BashTool/commandSemantics.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

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
async function drive(command: string): Promise<Drive> {
  try {
    const result = await (BashTool as unknown as Caller).call({ command } as never, toolContext)
    const block = (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(result.data as never, 'which-exit-one')
    return { ok: true, out: result.data as Out, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (error) {
    const e = error as { message?: string; stderr?: string; stdout?: string }
    return { ok: false, error: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') }
  }
}

section('§1 which: exit 1 is a labelled result, not an error')
const which = await drive('which sh mercury-no-such-tool-0x')
check('the call settles as a result (no ShellError thrown)', which.ok, which.ok ? '' : which.error.slice(0, 200))
if (which.ok) {
  check('the exit code is 1', which.out.code === 1, String(which.out.code))
  check('the output lists the found name (a missing name is printed by some which builds and not others)', which.out.stdout.includes('/sh'), JSON.stringify(which.out.stdout))
  check('the result ends with the label `a name was not found (exit code 1)`', which.content.endsWith('a name was not found (exit code 1)'), JSON.stringify(which.content.slice(-120)))
  check('the result carries no `Exited with code` line', !which.content.includes('Exited with code'), JSON.stringify(which.content.slice(-200)))
  check('the interpretation on the result is the label', which.out.returnCodeInterpretation === 'a name was not found' && which.out.exitNote === 'a name was not found (exit code 1)', JSON.stringify([which.out.returnCodeInterpretation, which.out.exitNote]))
}

section('§2 command -v: exit 1 is a labelled result too')
const commandV = await drive('command -v mercury-no-such-tool-0x')
check('the call settles as a result (no ShellError thrown)', commandV.ok, commandV.ok ? '' : commandV.error.slice(0, 200))
if (commandV.ok) {
  check('the exit code is 1', commandV.out.code === 1, String(commandV.out.code))
  check('the result ends with the label `a name was not found (exit code 1)`', commandV.content.endsWith('a name was not found (exit code 1)'), JSON.stringify(commandV.content.slice(-120)))
}
const commandVBig = await drive('command -V mercury-no-such-tool-0x')
check('command -V reads the same way', commandVBig.ok && commandVBig.content.endsWith('a name was not found (exit code 1)'), commandVBig.ok ? JSON.stringify(commandVBig.content.slice(-120)) : commandVBig.error.slice(0, 200))

section("§3 the bench's shape: a list whose LAST command is which, after a successful ls")
const listed = await drive('ls -la; which timeout-no-such-0x gtimeout-no-such-0x sh 2>&1')
check('the whole list is a result, status ok', listed.ok, listed.ok ? '' : listed.error.slice(0, 200))
if (listed.ok) {
  check('the listing and the which lines are both in the output, the label last', listed.content.includes('total ') && listed.content.includes('/sh') && listed.content.endsWith('a name was not found (exit code 1)'), JSON.stringify(listed.content.slice(-160)))
}

section('§4 exit 2 and above stay errors; other words are untouched')
const two = await drive('which() { return 2; }; which x')
check('a which that exits 2 is still an error ending `Exited with code 2`', !two.ok && /Exited with code 2/.test(two.ok ? '' : two.error), two.ok ? JSON.stringify(two.content.slice(0, 120)) : two.error.slice(0, 120))
check('the table reads which exit 2 as an error', interpretCommandResult('which foo', 2, '', '').isError === true)
check('the table reads which exit 1 as a result with the label', JSON.stringify(interpretCommandResult('which foo', 1, '', '')) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -v exit 1 as a result with the label', JSON.stringify(interpretCommandResult('command -v foo', 1, '', '')) === JSON.stringify({ isError: false, message: 'a name was not found' }))
check('the table reads command -V exit 1 the same way', interpretCommandResult('command -V foo', 1, '', '').isError === false)
check('a bare `command foo` (no -v) keeps the default reading: exit 1 is an error', interpretCommandResult('command foo', 1, '', '').isError === true)
check('which through env and assignments is still which', interpretCommandResult('FOO=1 env -i which foo', 1, '', '').isError === false)
check('grep exit 1 keeps its own label', JSON.stringify(interpretCommandResult('grep x y', 1, '', '')) === JSON.stringify({ isError: false, message: 'no matches found' }))
const plainFail = await drive('cat /mercury-no-such-file-0x')
check('an ordinary non-zero exit is still an error ending `Exited with code 1`', !plainFail.ok && /Exited with code 1/.test(plainFail.ok ? '' : plainFail.error), plainFail.ok ? 'settled as a result' : plainFail.error.slice(-80))

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'control-character-paths-')))
const PROJ = join(SCRATCH, 'proj')
mkdirSync(PROJ, { recursive: true })
process.chdir(PROJ)
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { NotebookEditTool } = await import('../../src/tools/NotebookEditTool/NotebookEditTool.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { AstSearchTool } = await import('../../src/tools/AstSearchTool/AstSearchTool.ts')
const { AstEditTool } = await import('../../src/tools/AstEditTool/AstEditTool.ts')
const { StructureTool } = await import('../../src/tools/StructureTool/StructureTool.ts')
const { LspReadTool, LspRenameTool } = await import('../../src/tools/LSPTool/LSPTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { resolveAgentCwd } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const pathModule = (await import('../../src/utils/path.ts')) as { CONTROL_PATH_MESSAGE?: string; NUL_PATH_MESSAGE: string; controlCharacterPathRefusal?: (path: string | undefined) => string | null; hasControlCharacter?: (path: string) => boolean }
const { NUL_PATH_MESSAGE } = pathModule
const CONTROL_PATH_MESSAGE = pathModule.CONTROL_PATH_MESSAGE ?? '(absent)'
const controlCharacterPathRefusal = pathModule.controlCharacterPathRefusal ?? (() => '(absent)')
const hasControlCharacter = pathModule.hasControlCharacter ?? (() => false)

writeFileSync(join(PROJ, 'xy.txt'), 'a plain line\n')
const OSC = `x\u001b]0;x\u0007y.txt`
const planted = join(SCRATCH, 'absent-folder', OSC)
const appState = getDefaultAppState()
const context = { getAppState: () => appState, abortController: new AbortController(), options: { tools: [] } } as never

type Verdict = { result: boolean; message?: string } | undefined
type ToolLike = { validateInput?: (input: never, context: never) => Promise<Verdict> | Verdict; backfillObservableInput?: (input: never) => void }
const validate = async (tool: ToolLike, input: Record<string, unknown>): Promise<{ verdict: Verdict; threw: string | null }> => {
  try {
    return { verdict: await tool.validateInput?.(input as never, context), threw: null }
  } catch (err) {
    return { verdict: undefined, threw: err instanceof Error ? err.message : String(err) }
  }
}

console.log('[1] the shared check')
{
  check('the NUL sentence is unchanged', NUL_PATH_MESSAGE === 'Path contains null bytes', NUL_PATH_MESSAGE)
  check('the control-character sentence has the same form', CONTROL_PATH_MESSAGE === 'Path contains control characters', CONTROL_PATH_MESSAGE)
  for (const [name, text] of [['ESC', '\u001b'], ['BEL', '\u0007'], ['OSC', OSC], ['DEL', '\u007f'], ['TAB', '\t'], ['LF', '\n'], ['NUL', '\0']] as const) {
    check(`${name} is a control character`, hasControlCharacter(`/tmp/a${text}b`))
  }
  check('a NUL path keeps the NUL sentence', controlCharacterPathRefusal('/tmp/a\0b') === NUL_PATH_MESSAGE)
  check('an OSC path gets the control-character sentence', controlCharacterPathRefusal(planted) === CONTROL_PATH_MESSAGE)
  for (const text of ['/tmp/plain.txt', 'café/naïve.txt', 'C:\\Users\\x\\file.txt', 'a b.txt', 'emoji-😀.txt', '']) {
    check(`${j(text)} is clean`, controlCharacterPathRefusal(text) === null && !hasControlCharacter(text))
  }
  check('an absent path is not a refusal', controlCharacterPathRefusal(undefined) === null)
}

console.log('[2] every path-taking tool refuses the planted path as a verdict with the shared sentence, before any filesystem access (its folder does not exist)')
const cases: Array<[string, ToolLike, Record<string, unknown>]> = [
  ['Read', FileReadTool as never, { file_path: planted }],
  ['Edit', FileEditTool as never, { file_path: planted, old_string: 'a', new_string: 'b', replace_all: false }],
  ['Write', FileWriteTool as never, { file_path: planted, content: 'x' }],
  ['Grep', GrepTool as never, { pattern: 'plain', path: planted }],
  ['Glob', GlobTool as never, { pattern: '*.txt', path: planted }],
  ['NotebookEdit', NotebookEditTool as never, { notebook_path: `${planted}.ipynb`, cell_id: 'c1', new_source: 'x', edit_mode: 'replace' }],
  ['ChangeSet (file_path)', ChangeSetTool as never, { op: 'apply', changes: [{ file_path: planted, expected_anchor: 'fa:0', edits: [{ old_string: 'a', new_string: 'b' }] }] }],
  ['ChangeSet (new_path)', ChangeSetTool as never, { op: 'apply', changes: [{ file_path: join(PROJ, 'xy.txt'), expected_anchor: 'fa:0', op: 'move', new_path: planted }] }],
  ['AstSearch', AstSearchTool as never, { pattern: '$FN($$$ARGS)', path: planted }],
  ['AstEdit', AstEditTool as never, { pattern: '$FN($$$ARGS)', rewrite: '$FN()', path: planted }],
  ['Structure', StructureTool as never, { op: 'query', select: 'imports', files: [planted] }],
  ['LspRead', LspReadTool as never, { operation: 'documentSymbol', filePath: planted }],
  ['LspRename', LspRenameTool as never, { filePath: planted, line: 1, character: 1, newName: 'x' }],
  ['Bash (cwd)', BashTool as never, { command: 'pwd', cwd: planted }],
  ['PowerShell (cwd)', PowerShellTool as never, { command: 'pwd', cwd: planted }],
]
for (const [name, tool, input] of cases) {
  const { verdict, threw } = await validate(tool, input)
  check(`${name}.validateInput refuses the planted path as a verdict`, threw === null && verdict !== undefined && verdict.result === false, threw ?? j(verdict))
  check(`${name}'s refusal carries the shared sentence`, verdict?.message === CONTROL_PATH_MESSAGE, verdict?.message ?? threw ?? 'none')
}
{
  let threw: string | null = null
  try {
    resolveAgentCwd(planted, appState.toolPermissionContext as never)
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('Agent (cwd) refuses the planted path with its own existing cwd sentence', threw !== null && threw.startsWith('cwd must be an absolute directory: '), threw ?? 'no throw')
}

console.log('[3] the observable-input backfill is total over the planted path')
for (const [name, tool, input] of cases) {
  if (typeof tool.backfillObservableInput !== 'function') continue
  const copy = { ...input }
  let threw: string | null = null
  try {
    tool.backfillObservableInput(copy as never)
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check(`${name}.backfillObservableInput never throws on the planted path`, threw === null, threw ?? '')
  check(`${name}'s backfill leaves the spelling as the model gave it`, copy.file_path === input.file_path && copy.path === input.path)
}

console.log('[4] a clean path still passes the same check in each tool')
{
  const clean = join(PROJ, 'xy.txt')
  const read = await validate(FileReadTool as never, { file_path: clean })
  check('Read accepts the clean path', read.verdict?.result === true, j(read))
  const grep = await validate(GrepTool as never, { pattern: 'plain', path: PROJ })
  check('Grep accepts the clean folder', grep.verdict?.result === true, j(grep))
  const bash = await validate(BashTool as never, { command: 'pwd', cwd: PROJ })
  check('Bash accepts the clean cwd', bash.verdict?.result === true, j(bash))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-control-character-paths: ALL LAWS HOLD' : `\nprove-control-character-paths: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

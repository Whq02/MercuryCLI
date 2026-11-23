#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'nul-path-tool-result-')))
const PROJ = join(SCRATCH, 'proj')
mkdirSync(PROJ, { recursive: true })
process.chdir(PROJ)
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log('    where to look: the named tool validateInput (src/tools/<Tool>/<Tool>.ts) must return result false with NUL_PATH_MESSAGE from src/platform/files/path.ts for a path holding a NUL byte instead of throwing; its backfillObservableInput and backfillCloneForYield in src/engine/loop/model-lane.ts must not throw on it; BashTool checkPermissions (src/tools/shell/BashTool.tsx) must deny a cd with a NUL operand')
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { FileReadTool } = await import('../../src/tools/read/ReadTool.ts')
const { FileEditTool } = await import('../../src/tools/edit/EditTool.ts')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.ts')
const { GrepTool } = await import('../../src/tools/grep/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/glob/GlobTool.ts')
const { backfillCloneForYield } = await import('../../src/engine/loop/model-lane.ts')
const { NUL_PATH_MESSAGE } = await import('../../src/platform/files/path.ts')

writeFileSync(join(PROJ, 'xy.txt'), 'a plain line\n')
const nulPath = join(PROJ, `x${String.fromCharCode(0)}y.txt`)
const appState = getDefaultAppState()
const context = { getAppState: () => appState, abortController: new AbortController(), options: { tools: [] } } as never

type Verdict = { result: boolean; message?: string } | undefined
const validate = async (tool: { validateInput?: (input: never, context: never) => Promise<Verdict> | Verdict }, input: Record<string, unknown>): Promise<{ verdict: Verdict; threw: string | null }> => {
  try {
    return { verdict: await tool.validateInput?.(input as never, context), threw: null }
  } catch (err) {
    return { verdict: undefined, threw: err instanceof Error ? err.message : String(err) }
  }
}

console.log('[1] each file tool refuses a NUL path as a verdict, never a throw')
const cases: Array<[string, { validateInput?: never; backfillObservableInput?: (input: never) => void } & Record<string, unknown>, Record<string, unknown>]> = [
  ['Read', FileReadTool as never, { file_path: nulPath }],
  ['Edit', FileEditTool as never, { file_path: nulPath, old_string: 'a', new_string: 'b', replace_all: false }],
  ['Write', FileWriteTool as never, { file_path: nulPath, content: 'x' }],
  ['Grep', GrepTool as never, { pattern: 'plain', path: nulPath }],
  ['Glob', GlobTool as never, { pattern: '*.txt', path: nulPath }],
  ['Glob pattern', GlobTool as never, { pattern: `*${String.fromCharCode(0)}.txt` }],
]
for (const [name, tool, input] of cases) {
  const { verdict, threw } = await validate(tool as never, input)
  console.log(`  ${name}: ${threw !== null ? `threw ${JSON.stringify(threw)}` : JSON.stringify(verdict)}`)
  check(`${name}.validateInput answers a refusal for a NUL path`, threw === null && verdict !== undefined && verdict.result === false, threw ?? JSON.stringify(verdict))
  check(`${name}'s refusal carries the product's own sentence`, verdict?.message === NUL_PATH_MESSAGE, verdict?.message ?? threw ?? 'none')
}

console.log('[2] the observable-input backfill is total over a NUL path (the settlement clone walks it before any tool runs)')
for (const [name, tool, input] of cases) {
  if (typeof tool.backfillObservableInput !== 'function') {
    console.log(`  ${name}: no backfill`)
    continue
  }
  const copy = { ...input }
  let threw: string | null = null
  try {
    tool.backfillObservableInput(copy as never)
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check(`${name}.backfillObservableInput never throws on a NUL path`, threw === null, threw ?? '')
  check(`${name}'s backfill leaves the NUL spelling as the model gave it`, copy.file_path === input.file_path)
}
{
  const message = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: nulPath } }] } }
  let threw: string | null = null
  try {
    backfillCloneForYield(message, name => (name === 'Read' ? (FileReadTool as never) : undefined))
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('the settlement clone of an assistant message carrying a NUL Read path survives', threw === null, threw ?? '')
}

console.log('[3] an ordinary path still passes the guard')
{
  const { verdict, threw } = await validate(FileReadTool as never, { file_path: join(PROJ, 'xy.txt') })
  check('a plain Read path validates as before', threw === null && verdict !== undefined && verdict.result === true, threw ?? JSON.stringify(verdict))
  const copy = { file_path: 'xy.txt' }
  ;(FileReadTool as { backfillObservableInput: (input: { file_path: string }) => void }).backfillObservableInput(copy)
  check('a relative Read path is still expanded by the backfill', copy.file_path === join(PROJ, 'xy.txt'), copy.file_path)
}

console.log('[4] a cd whose operand holds a NUL byte is answered by the Bash tool\'s own check, never thrown')
{
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const nul = String.fromCharCode(0)
  const checked = BashTool as never as { checkPermissions(input: unknown, context: unknown): Promise<{ behavior?: string; message?: string }> }
  for (const command of [`cat xy.txt; cd x${nul}y`, `cd x${nul}y && cat xy.txt`, `pushd x${nul}y; cat xy.txt`]) {
    let threw: string | null = null
    let verdict: { behavior?: string; message?: string } | undefined
    try {
      verdict = await checked.checkPermissions({ command }, context)
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err)
    }
    check(`the check of ${JSON.stringify(command.replaceAll(nul, '<NUL>'))} answers a refusal`, threw === null && verdict?.behavior === 'deny', threw ?? JSON.stringify(verdict))
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

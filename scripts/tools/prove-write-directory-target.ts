#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'write-directory-target-')))
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
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { findActualString } = await import('../../src/tools/FileEditTool/utils.ts')

const appState = getDefaultAppState()
const context = { getAppState: () => appState, abortController: new AbortController(), options: { tools: [] } } as never
type Verdict = { result: boolean; message?: string } | undefined
const validate = async (input: Record<string, unknown>): Promise<{ verdict: Verdict; threw: string | null }> => {
  try {
    return { verdict: await (FileWriteTool as { validateInput: (input: never, context: never) => Promise<Verdict> }).validateInput(input as never, context), threw: null }
  } catch (err) {
    return { verdict: undefined, threw: err instanceof Error ? err.message : String(err) }
  }
}

console.log('[1] a Write whose target is an existing directory is refused before the write, in plain words')
{
  const directory = join(PROJ, 'a-directory')
  mkdirSync(directory)
  const { verdict, threw } = await validate({ file_path: directory, content: 'x' })
  console.log(`  verdict: ${threw !== null ? `threw ${JSON.stringify(threw)}` : JSON.stringify(verdict)}`)
  check('validateInput answers a refusal, not a pass that leaves the errno to the write', threw === null && verdict !== undefined && verdict.result === false, threw ?? JSON.stringify(verdict))
  check('the refusal names the path a directory in plain words', /the path is a directory, not a file/i.test(verdict?.message ?? ''), verdict?.message ?? threw ?? 'none')
  check('the refusal carries no bare errno', !/EISDIR/.test(verdict?.message ?? ''), verdict?.message ?? '')
  check('the refusal names the path the model gave', (verdict?.message ?? '').includes(directory), verdict?.message ?? '')
  const relative = await validate({ file_path: 'a-directory', content: 'x' })
  check('a relative spelling of the directory is refused the same way', relative.threw === null && relative.verdict?.result === false && /the path is a directory, not a file/i.test(relative.verdict?.message ?? ''), relative.threw ?? JSON.stringify(relative.verdict))
}

console.log('[2] a file target and a fresh target still pass')
{
  const file = join(PROJ, 'notes.txt')
  writeFileSync(file, 'a line\n')
  const existing = await validate({ file_path: file, content: 'x' })
  check('an existing file passes validation', existing.threw === null && existing.verdict?.result === true, existing.threw ?? JSON.stringify(existing.verdict))
  const fresh = await validate({ file_path: join(PROJ, 'new-dir', 'new.txt'), content: 'x' })
  check('a path that does not exist yet passes validation (the write creates it)', fresh.threw === null && fresh.verdict?.result === true, fresh.threw ?? JSON.stringify(fresh.verdict))
  const unc = await validate({ file_path: '\\\\server\\share\\file.txt', content: 'x' })
  check('a UNC path is not touched by the check (no filesystem call before permission)', unc.threw === null && unc.verdict?.result === true, unc.threw ?? JSON.stringify(unc.verdict))
}

console.log('[3] a very large non-ASCII edit miss is a clean not-found, never a regular-expression error')
{
  const content = 'a plain ascii line\nanother plain line\n'
  const bigMissing = `${'ü'.repeat(70_000)}∅ never in the file`
  let editThrew: unknown = null
  let found: string | null | undefined
  try {
    found = findActualString(content, bigMissing)
  } catch (err) {
    editThrew = err
  }
  check('the matcher answers null for the miss and throws nothing', editThrew === null && found === null, editThrew === null ? String(found) : String((editThrew as Error).message).slice(0, 120))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

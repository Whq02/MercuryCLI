#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hook-runner-write-')))
const run = join(scratch, 'run')
mkdirSync(join(run, '.git', 'hooks'), { recursive: true })
mkdirSync(join(run, '.husky'))
mkdirSync(join(run, 'src'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(run, '.husky', 'pre-commit'), 'npm test\n')
writeFileSync(join(run, 'Makefile'), 'all:\n')
writeFileSync(join(run, 'src', 'a.ts'), 'export {}\n')
writeFileSync(join(run, 'a'), 'a\n')
const previousCwd = process.cwd()
process.chdir(run)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkWritePermissionForTool, checkReadPermissionForTool, checkPathSafetyForAutoEdit } = await import('../../src/utils/permissions/filesystem.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

type Decision = { behavior: string; message?: string }
const permissionContext = (mode: string) => ({ ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign' })
const useContext = (mode: string) => {
  const state = { toolPermissionContext: permissionContext(mode) }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
}
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode: string): Promise<Decision> =>
  (await decideToolPermissionWithModes(bash, { command }, useContext(mode), { message: { id: 'hook' } } as never, 'hook')).decision as Decision
const writeThroughTool = async (path: string, mode: string): Promise<Decision> =>
  (await decideToolPermissionWithModes(FileWriteTool as never, { file_path: path, content: 'x\n' }, useContext(mode), { message: { id: 'hook' } } as never, 'hook')).decision as Decision
const writeTool = { name: 'Write', getPath: (input: { file_path: string }) => input.file_path }
const readTool = { name: 'Read', getPath: (input: { file_path: string }) => input.file_path }
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const SENSITIVE = 'which is a sensitive file.'
const hook = join(run, '.husky', 'pre-commit')

console.log('prove-hook-runner-write-ask — Implement mode asks before writing a file git runs on the next commit')

section('§1 Implement mode: a write under .husky asks as it does under .git/hooks')
check('the path-safety check holds .husky/pre-commit', checkPathSafetyForAutoEdit(hook).safe === false)
check('the path-safety check holds .git/hooks/pre-commit (the road that already asked)', checkPathSafetyForAutoEdit(join(run, '.git', 'hooks', 'pre-commit')).safe === false)
for (const command of ['echo x > .husky/pre-commit', 'echo x >> .husky/pre-commit', 'cp a .husky/pre-commit', 'touch .husky/pre-commit', 'mkdir -p .husky/_', 'echo x > .husky/post-checkout']) {
  const verdict = await decide(command, 'implement')
  check(`implement: ${command} → ask, naming the sensitive file`, verdict.behavior === 'ask' && String(verdict.message).includes(SENSITIVE), shown(verdict))
}
{
  const piped = await decide('echo x | tee .husky/pre-commit', 'implement')
  check('implement: echo x | tee .husky/pre-commit → ask, naming the tee part', piped.behavior === 'ask' && String(piped.message).includes('tee .husky/pre-commit'), shown(piped))
}
{
  const direct = checkWritePermissionForTool(writeTool, { file_path: hook }, permissionContext('implement') as never) as Decision
  check('implement: the Write tool on .husky/pre-commit → ask, naming the sensitive file', direct.behavior === 'ask' && String(direct.message).includes(SENSITIVE), shown(direct))
  const chain = await writeThroughTool(hook, 'implement')
  check('implement: the Write tool through the decision chain → ask', chain.behavior === 'ask', shown(chain))
  const gitHook = await decide('echo x > .git/hooks/pre-commit', 'implement')
  check('implement: echo x > .git/hooks/pre-commit → ask (unchanged)', gitHook.behavior === 'ask' && String(gitHook.message).includes(SENSITIVE), shown(gitHook))
}

section('§2 the ask reaches no further: ordinary files and reads are untouched')
for (const command of ['echo x > Makefile', 'echo x > src/a.ts', 'cp a src/b.ts', 'cat .husky/pre-commit']) {
  const verdict = await decide(command, 'implement')
  check(`implement: ${command} → allow`, verdict.behavior === 'allow', shown(verdict))
}
check('implement: the Read tool on .husky/pre-commit → allow', (checkReadPermissionForTool(readTool, { file_path: hook }, permissionContext('implement') as never) as Decision).behavior === 'allow')
check('implement: the Write tool on src/a.ts → allow', (checkWritePermissionForTool(writeTool, { file_path: join(run, 'src', 'a.ts') }, permissionContext('implement') as never) as Decision).behavior === 'allow')

section('§3 default mode asks for every write, the hook included; sovereign asks nothing and is unchanged for the same edit')
{
  const plain = await decide('echo x > .husky/pre-commit', 'default')
  check('default: echo x > .husky/pre-commit → ask', plain.behavior === 'ask', shown(plain))
  for (const command of ['echo x > .husky/pre-commit', 'cp a .husky/pre-commit', 'echo x > Makefile']) {
    const verdict = await decide(command, 'sovereign')
    check(`sovereign: ${command} → allow (not ask)`, verdict.behavior === 'allow', shown(verdict))
  }
  const chain = await writeThroughTool(hook, 'sovereign')
  check('sovereign: the Write tool on .husky/pre-commit → allow (not ask)', chain.behavior === 'allow', shown(chain))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

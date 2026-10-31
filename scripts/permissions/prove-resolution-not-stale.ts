#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'resolution-not-stale-')))
const run = join(scratch, 'run')
const outside = join(scratch, 'outside')
mkdirSync(join(run, 'dir'), { recursive: true })
mkdirSync(outside)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(run, 'dir', 'secret.txt'), 'inside\n')
writeFileSync(join(outside, 'secret.txt'), 'outside\n')
writeFileSync(join(outside, 'other.txt'), 'outside\n')
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
const { checkReadPermissionForTool, getResolvedWorkingDirPaths } = await import('../../src/utils/permissions/filesystem.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')

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
const readTool = { name: 'Read', getPath: (input: { file_path: string }) => input.file_path }
const read = (path: string, mode = 'default'): Decision => checkReadPermissionForTool(readTool, { file_path: path }, permissionContext(mode) as never) as Decision
const readThroughTool = async (path: string, mode = 'default'): Promise<Decision> => {
  const state = { toolPermissionContext: permissionContext(mode) }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  return (await decideToolPermissionWithModes(FileReadTool as never, { file_path: path }, context, { message: { id: 'stale' } } as never, 'stale')).decision as Decision
}
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode = 'default'): Promise<Decision> => {
  const state = { toolPermissionContext: permissionContext(mode) }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  return (await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'stale' } } as never, 'stale')).decision as Decision
}
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const laterCall = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const file = join(run, 'dir', 'secret.txt')
const linkOut = (): void => symlinkSync(outside, join(run, 'dir'), process.platform === 'win32' ? 'junction' : 'dir')
const unlinkDir = (): void => { if (process.platform === 'win32') rmdirSync(join(run, 'dir')); else unlinkSync(join(run, 'dir')) }

console.log('prove-resolution-not-stale — a path judged inside the starting folder is judged again once the folder becomes a link out of it')

section('§1 before the swap: the file under the real folder is read without a question')
check('Read tool: dir/secret.txt → allow', read(file).behavior === 'allow', shown(read(file)))
check('Read tool through the decision chain: dir/secret.txt → allow', (await readThroughTool(file)).behavior === 'allow')
check('Bash: cat dir/secret.txt → allow', (await decide('cat dir/secret.txt')).behavior === 'allow')

rmSync(join(run, 'dir'), { recursive: true })
linkOut()
check('the folder is now a link to the outside folder and the same path reads the outside file', readFileSync(file, 'utf8') === 'outside\n')
await laterCall()

section('§2 after the swap, on the next call: the same path is outside the starting folder and asks')
{
  const verdict = read(file)
  check('Read tool: dir/secret.txt → ask, naming the outside folder', verdict.behavior === 'ask' && String(verdict.message).includes('has not been granted'), shown(verdict))
  const chain = await readThroughTool(file)
  check('Read tool through the decision chain: dir/secret.txt → ask', chain.behavior === 'ask', shown(chain))
  const never = read(join(run, 'dir', 'other.txt'))
  check('a path never seen before through the link asks too', never.behavior === 'ask', shown(never))
  const shell = await decide('cat dir/secret.txt')
  check('Bash: cat dir/secret.txt → ask, naming the outside file', shell.behavior === 'ask' && String(shell.message).includes(join(outside, 'secret.txt')), shown(shell))
}

section('§3 the cache still serves one burst of checks and clearCache() still empties it')
{
  const first = getResolvedWorkingDirPaths(file)
  const second = getResolvedWorkingDirPaths(file)
  check('two resolutions in one burst share one answer', first === second)
  getResolvedWorkingDirPaths.clearCache()
  const third = getResolvedWorkingDirPaths(file)
  check('after clearCache() the path is resolved afresh with the same forms', third !== first && JSON.stringify(third) === JSON.stringify(first))
  await laterCall()
  const fourth = getResolvedWorkingDirPaths(file)
  check('after the loop turns, the path is resolved afresh', fourth !== third && JSON.stringify(fourth) === JSON.stringify(third))
}

section('§4 sovereign asks nothing: the same reads before and after the swap are allowed, never a question')
{
  unlinkDir()
  mkdirSync(join(run, 'dir'))
  writeFileSync(file, 'inside\n')
  await laterCall()
  check('sovereign: Read tool dir/secret.txt (real folder) → allow', read(file, 'sovereign').behavior === 'allow')
  check('sovereign: Bash cat dir/secret.txt (real folder) → allow', (await decide('cat dir/secret.txt', 'sovereign')).behavior === 'allow')
  rmSync(join(run, 'dir'), { recursive: true })
  linkOut()
  await laterCall()
  const later = await readThroughTool(file, 'sovereign')
  check('sovereign: Read tool dir/secret.txt (linked out) → allow, not ask', later.behavior === 'allow', shown(later))
  const shell = await decide('cat dir/secret.txt', 'sovereign')
  check('sovereign: Bash cat dir/secret.txt (linked out) → allow, not ask', shell.behavior === 'allow', shown(shell))
}

process.chdir(previousCwd)
unlinkDir()
removeScratch(scratch)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

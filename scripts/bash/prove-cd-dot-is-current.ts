#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/bashCommandHelpers.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cd-dot-is-current-')))
const root = join(scratch, 'run')
mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(join(root, '.git'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'README'), 'hello\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission, isCurrentFolderSpelling } = await import('../../src/tools/BashTool/bashPermissions.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

type Decision = { behavior: string; message?: string }
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode: string): Promise<Decision> => {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign' } }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  return (await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'cd-dot' } } as never, 'cd-dot')).decision as Decision
}
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`

console.log('prove-cd-dot-is-current — cd . names the folder the command already runs in, so it changes nothing')

section('§1 the spelling check: dots and separators alone name the current folder')
for (const spelled of ['.', './', './.', '././', '.\\']) check(`${JSON.stringify(spelled)} is the current folder`, isCurrentFolderSpelling(spelled, root))
for (const spelled of ['..', './..', './sub', 'sub', '.hidden', '', '.;', '$PWD']) check(`${JSON.stringify(spelled)} is not`, !isCurrentFolderSpelling(spelled, root))
check('the absolute spelling of the folder still counts', isCurrentFolderSpelling(root, root))

section('§2 default and implement: a read after cd . is allowed as the read alone would be')
for (const command of ['cd . && git status', 'cd ./ && git status', 'cd . && ls', 'cd .; git log --oneline -1', 'cd ././ && cat README']) {
  for (const mode of ['default', 'implement']) {
    const verdict = await decide(command, mode)
    check(`${mode}: ${command} → allow`, verdict.behavior === 'allow', shown(verdict))
  }
}

section('§3 a real change of folder keeps asking in the asking modes')
for (const command of ['cd .. && git status', 'cd ./sub && git status', 'cd -P . && git status', 'cd . && cd sub && git status']) {
  for (const mode of ['default', 'implement']) {
    const verdict = await decide(command, mode)
    check(`${mode}: ${command} → ask`, verdict.behavior === 'ask', shown(verdict))
  }
}

section('§4 a write after cd . is judged as the write alone: default asks, implement allows inside the folder')
{
  const plain = await decide('cd . && echo hi > out.txt', 'default')
  check('default: cd . && echo hi > out.txt → ask', plain.behavior === 'ask', shown(plain))
  const writing = await decide('cd . && echo hi > out.txt', 'implement')
  const alone = await decide('echo hi > out.txt', 'implement')
  check('implement: cd . && echo hi > out.txt answers as echo hi > out.txt does', writing.behavior === alone.behavior && alone.behavior === 'allow', `${writing.behavior} vs ${alone.behavior}`)
}

section('§5 sovereign asks nothing: every command above is allowed')
for (const command of ['cd . && git status', 'cd .. && git status', 'cd ./sub && git status', 'cd -P . && git status', 'cd . && echo hi > out.txt']) {
  const verdict = await decide(command, 'sovereign')
  check(`sovereign: ${command} → allow (not ask)`, verdict.behavior === 'allow', shown(verdict))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

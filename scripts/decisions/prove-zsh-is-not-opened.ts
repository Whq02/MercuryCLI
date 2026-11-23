#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zsh-is-not-opened-')))
const runRoot = join(scratch, 'run')
mkdirSync(join(runRoot, '.git'), { recursive: true })
mkdirSync(join(scratch, 'home'))
const startedIn = process.cwd()
process.chdir(runRoot)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]

const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/shell/bashPermissions.ts')
const { extractShellCScript, parseForSecurity, shellCCommands } = await import('../../src/permissions/rules/decision/commandAnalysis.ts')

let failures = 0
let checks = 0
const READER_HINT = 'fix extractShellCScript in src/permissions/rules/decision/commandAnalysis.ts (opens only sh and bash with -c or -lc, never zsh)'
const DECISION_HINT = 'fix the zsh handling in bashToolHasPermission (src/tools/shell/bashPermissions.ts) or decideToolPermissionWithModes (src/permissions/rules/decision/wrapper.ts)'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Decision = { behavior: string; message?: string }
const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never

async function decide(command: string): Promise<Decision> {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default', isBypassPermissionsModeAvailable: false } }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'zsh-is-not-opened' } } as never, 'zsh-is-not-opened')
  return outcome.decision as Decision
}
const said = (decision: Decision): string => `${decision.behavior}${decision.message ? `: ${decision.message.replaceAll('\n', ' ').slice(0, 220)}` : ''}`

async function opened(command: string): Promise<{ script: string | null; inner: string[] }> {
  const parsed = await parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return { script: null, inner: [] }
  const script = extractShellCScript(parsed.commands[0]!)
  if (script !== null) await parseForSecurity(script)
  return { script, inner: shellCCommands(parsed.commands).slice(1).map(simple => simple.argv.join(' ')) }
}

section('(1) the reader opens sh and bash, and does not open zsh: a script zsh will run is not read as bash')
const NOT_OPENED = ["zsh -c 'echo hi'", "zsh -lc 'echo hi'", "/bin/zsh -c 'echo hi'", "/usr/bin/zsh -c 'echo hi'", "zsh -c 'echo =ls'", "zsh -c 'zmodload zsh/files; zf_rm -rf build'"]
for (const command of NOT_OPENED) {
  const read = await opened(command)
  check(`${JSON.stringify(command)} is not opened`, read.script === null && read.inner.length === 0, `${READER_HINT}; got ${JSON.stringify(read)}`)
}
const OPENED: Array<[string, string]> = [
  ["sh -c 'echo hi'", 'echo hi'],
  ["bash -c 'echo hi'", 'echo hi'],
  ["bash -lc 'echo hi'", 'echo hi'],
  ["/bin/bash -c 'echo hi'", 'echo hi'],
  ["/usr/bin/sh -c 'echo hi'", 'echo hi'],
]
for (const [command, script] of OPENED) {
  const read = await opened(command)
  check(`${JSON.stringify(command)} is opened and its script read`, read.script === script && read.inner.join('|') === script, `${READER_HINT}; got ${JSON.stringify(read)}`)
}

section('(2) the decision: a command that starts zsh is asked about, whatever its script holds')
const ASKED = ["zsh -c 'echo =ls'", "zsh -c 'echo hi'", "zsh -lc 'echo hi'", "/bin/zsh -c 'echo ~[x]'", "zsh -c 'cat =ls'", "zsh -c 'zmodload zsh/files'"]
for (const command of ASKED) {
  const decision = await decide(command)
  check(`default mode asks about ${JSON.stringify(command)}`, decision.behavior === 'ask', `${DECISION_HINT}; got ${said(decision)}`)
}
const zshLine = await decide("zsh -c 'echo =ls'")
check('the question names zsh as the program it cannot read, not a word inside the script', /zsh/.test(zshLine.message ?? ''), `${DECISION_HINT}; got ${said(zshLine)}`)

section('(3) what stays: a script sh or bash will run is read as before')
for (const command of ["bash -c 'echo hi'", "sh -c 'echo hi'", 'echo =ls', 'echo hi']) {
  const decision = await decide(command)
  check(`default mode allows ${JSON.stringify(command)} with no rule`, decision.behavior === 'allow', `${DECISION_HINT}; got ${said(decision)}`)
}
for (const command of ["bash -c 'rm -rf build'", "sh -c 'rm -rf build'"]) {
  const decision = await decide(command)
  check(`default mode asks about ${JSON.stringify(command)}: the script inside is read`, decision.behavior === 'ask', `${DECISION_HINT}; got ${said(decision)}`)
}
for (const command of ["zsh -c 'rm -rf build'", "bash -c 'zsh -c \"rm -rf build\"'"]) {
  const decision = await decide(command)
  check(`default mode asks about ${JSON.stringify(command)}, as it did when the script was read`, decision.behavior === 'ask', `${DECISION_HINT}; got ${said(decision)}`)
}

console.log('\n  [NOTE] every row is a decision through decideToolPermissionWithModes or a reading through the command-analysis door; no command is run')
console.log(`\nprove-zsh-is-not-opened: ${checks} checks, ${failures} failed`)
process.chdir(startedIn)
rmSync(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)

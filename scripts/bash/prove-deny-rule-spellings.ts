#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/utils/git/spawnArgs.ts src/utils/bash/ast.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'deny-rule-spellings-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'x'), 'x\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

type Decision = { behavior: string; message?: string; decisionReason?: { type?: string } }
const RULES = ['Bash(rm *)', 'Bash(git commit *)']
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode: string, deny: string[] = RULES): Promise<Decision> => {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: { localSettings: deny }, alwaysAllowRules: {}, alwaysAskRules: {} } }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'spelling' } } as never, 'spelling')
  return outcome.decision as Decision
}
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const deniedBy = (decision: Decision, rule: string): boolean => decision.behavior === 'deny' && String(decision.message).includes(`denied by the rule ${rule}`)
const ASKING_MODES = ['default', 'implement', 'flow']

const variants: Array<[string, string, string]> = [
  ['rm x', 'Bash(rm *)', 'the plain spelling'],
  ['"rm" x', 'Bash(rm *)', 'a double-quoted name'],
  ['\\rm x', 'Bash(rm *)', 'a backslash-escaped name'],
  ["$'rm' x", 'Bash(rm *)', 'an ANSI-C quoted name'],
  ["$'\\x72m' x", 'Bash(rm *)', 'an ANSI-C quoted name spelled in hex'],
  ['r\\\nm x', 'Bash(rm *)', 'a name split by a line continuation'],
  ['/bin/rm x', 'Bash(rm *)', 'the program named by its path'],
  ['/usr/bin/git commit -m x', 'Bash(git commit *)', 'git named by its path'],
  ['eval "rm x"', 'Bash(rm *)', 'the command handed to eval'],
  ['sudo rm x', 'Bash(rm *)', 'the command under sudo'],
  ['sudo -u root rm x', 'Bash(rm *)', 'sudo with a valued option'],
  ['sudo -E -u root -- rm x', 'Bash(rm *)', 'sudo with options and the option end'],
  ['sudo FOO=1 rm x', 'Bash(rm *)', 'sudo with an environment assignment'],
  ['doas rm x', 'Bash(rm *)', 'the command under doas'],
  ['busybox rm x', 'Bash(rm *)', 'the busybox applet'],
  ['git -C . commit -m x', 'Bash(git commit *)', 'git with -C before the subcommand'],
  ['git --no-pager commit -m x', 'Bash(git commit *)', 'git with --no-pager before the subcommand'],
  ['git -c a=b commit -m x', 'Bash(git commit *)', 'git with -c before the subcommand'],
  ['git --git-dir=.git --work-tree=. commit -m x', 'Bash(git commit *)', 'git with repository options before the subcommand'],
  ['sudo git -C . commit -m x', 'Bash(git commit *)', 'a wrapper and git options together'],
  ['env rm x', 'Bash(rm *)', 'the command under env'],
  ['FOO=1 rm x', 'Bash(rm *)', 'an environment prefix'],
  ['nice -n 5 rm x', 'Bash(rm *)', 'the command under nice'],
  ['xargs rm', 'Bash(rm *)', 'the command under xargs'],
  ['bash -c "rm x"', 'Bash(rm *)', 'the command inside bash -c'],
  ['ls && rm x', 'Bash(rm *)', 'the command after &&'],
]

console.log('prove-deny-rule-spellings — a Bash deny rule holds against the spellings the shell reads as the same command')

section('§1 in every asking mode each spelling is refused by the rule, not merely held for approval')
for (const [command, rule, label] of variants) {
  for (const mode of ASKING_MODES) {
    const verdict = await decide(command, mode)
    check(`${mode}: ${JSON.stringify(command)} — ${label} → deny by ${rule}`, deniedBy(verdict, rule), shown(verdict))
  }
}

section('§2 the rule reaches no further than its prefix')
for (const [command, label] of [
  ['echo rm x', 'a word that is an argument, not the command'],
  ['rmdir x', 'a different program sharing the prefix letters'],
  ['git status', 'another git subcommand'],
  ['git -C . status', 'another git subcommand behind an option'],
  ['sudo ls', 'another program under sudo'],
  ['/bin/ls', 'another program by its path'],
  ['ls', 'a plain read'],
] as Array<[string, string]>) {
  for (const mode of ASKING_MODES) {
    const verdict = await decide(command, mode)
    check(`${mode}: ${command} — ${label} → not denied`, verdict.behavior !== 'deny', shown(verdict))
  }
}
for (const command of ['echo rm x', 'git status', 'ls']) {
  const verdict = await decide(command, 'default')
  check(`default: ${command} stays allowed`, verdict.behavior === 'allow', shown(verdict))
}

section('§3 sovereign asks nothing: the same spellings refuse there by the rule, the rest run, and nothing is asked')
{
  for (const [command, rule] of variants) {
    const verdict = await decide(command, 'sovereign')
    check(`sovereign: ${JSON.stringify(command)} → deny by ${rule} (not ask)`, deniedBy(verdict, rule), shown(verdict))
  }
  for (const command of ['echo rm x', 'rmdir x', 'git status', 'sudo ls', 'ls', 'find . -delete']) {
    const verdict = await decide(command, 'sovereign')
    check(`sovereign: ${command} → allow (not ask)`, verdict.behavior === 'allow', shown(verdict))
  }
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

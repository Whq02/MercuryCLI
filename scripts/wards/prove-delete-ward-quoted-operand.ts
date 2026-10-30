#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'delete-ward-quoted-home-'))
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
mkdirSync(process.env.HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_SPAWNED_BY = 'proof:delete-ward-quoted#1'
delete process.env.NODE_ENV

type PendingToolCall = import('../../src/utils/wards/wards.js').PendingToolCall
const { AUTONOMOUS_WARDS, REFUSAL_WARDS, evaluateWards } = await import('../../src/utils/wards/wards.js')
const { deleteWardActive, makeTargetResolver } = await import('../../src/guards/wardsGuard.js')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const home = homedir()
mkdirSync(join(home, 'Developer'), { recursive: true })
const realHome = realpathSync(home)
const project = realpathSync(mkdtempSync(join(home, 'Developer', '.delete-ward-quoted-proof-')))
const plainProject = realpathSync(mkdtempSync(join(tmpdir(), 'delete-ward-quoted-plain-')))
for (const root of [project, plainProject]) {
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'build dir'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# proof\n')
}

type Verdict = 'warded' | 'refused' | 'allowed'
function verdictOf(command: string, root: string): Verdict {
  const pending: PendingToolCall = { toolName: 'Bash', input: { command }, shellCommand: command, resolvePath: makeTargetResolver(root) }
  const ward = evaluateWards(AUTONOMOUS_WARDS, pending)
  if (!ward.allow) return 'warded'
  const refusal = evaluateWards(REFUSAL_WARDS, pending)
  return refusal.allow ? 'allowed' : 'refused'
}
const stopped = (v: Verdict): boolean => v !== 'allowed'

console.log('============================================================')
console.log(' the home-delete ward of an autonomous session fires on a quoted operand as it does on a bare one, and an in-project quoted delete still passes')
console.log('============================================================')
console.log(` home ${home} · project under the home ${project} · plain project ${plainProject}`)
check('the autonomous delete ward is armed (MERCURY_SPAWNED_BY set)', deleteWardActive())

console.log('\n§1 a quoted home path is stopped as the bare one is (RED on 015ac050c0 and on the base: every quoted form was allowed)')
const homeDeletes: Array<[string, string]> = [
  ['double quotes', `rm -rf "${home}/Documents"`],
  ['single quotes', `rm -rf '${home}/Documents'`],
  ['a quoted path with a space', `rm -rf "${home}/My Documents"`],
  ['a quoted $HOME path', 'rm -rf "$HOME/Documents"'],
  ['a quoted ${HOME} path', 'rm -rf "${HOME}/Documents"'],
  ['a quoted ~ path', 'rm -rf "~/Documents"'],
  ['-r alone, quoted', `rm -r "${home}/Library"`],
  ['-fr, quoted', `rm -fr "${home}/Library"`],
  ['--recursive, quoted', `rm --recursive --force "${home}/Library"`],
  ['the quoted path after --', `rm -rf -- "${home}/Documents"`],
  ['find -delete on a quoted home path', `find "${home}" -name '*.o' -delete`],
  ['find -delete on a quoted $HOME', 'find "$HOME/Library" -delete'],
]
for (const [label, command] of homeDeletes) {
  const bare = verdictOf(command.replace(/["']/g, ''), plainProject)
  const quoted = verdictOf(command, plainProject)
  check(`${label}: stopped (${quoted}); the bare spelling reads ${bare}`, stopped(quoted), command.replace(home, '<home>'))
}

console.log('\n§2 an in-project delete passes whether quoted or not, spaces included (the resolved path, not the spelling, decides)')
const inProject: Array<[string, string, string]> = [
  ['absolute, bare', project, `rm -rf ${project}/build`],
  ['absolute, quoted', project, `rm -rf "${project}/build"`],
  ['absolute, quoted, the folder has a space', project, `rm -rf "${project}/build dir"`],
  ['absolute, single-quoted, the folder has a space', project, `rm -rf '${project}/build dir'`],
  ['via ~, quoted', project, `rm -rf "~/${project.slice(realHome.length + 1)}/build"`],
  ['relative', project, 'rm -rf ./build'],
  ['relative with a space, quoted', project, 'rm -rf "./build dir"'],
  ['a $TMPDIR path, quoted', plainProject, 'rm -rf "$TMPDIR/x"'],
  ['find -delete inside the project, quoted', project, `find "${project}/build dir" -name '*.o' -delete`],
]
for (const [label, root, command] of inProject) {
  const v = verdictOf(command, root)
  check(`${label}: allowed (${v})`, v === 'allowed', command.replace(home, '<home>'))
}

console.log('\n§3 the refusal list and the whole-home spellings are unchanged')
check('rm -rf / is refused', verdictOf('rm -rf /', plainProject) === 'refused')
check('rm -rf "$HOME" is stopped', stopped(verdictOf('rm -rf "$HOME"', plainProject)))
check(`rm -rf <home> is stopped`, stopped(verdictOf(`rm -rf ${home}`, plainProject)))
check('rm -rf ~ is stopped', stopped(verdictOf('rm -rf ~', plainProject)))
check('an rm without a recursive flag is not the ward\'s business', verdictOf(`rm "${home}/Documents/one.txt"`, plainProject) === 'allowed')
check('a quoted home path in an echo is not a delete', verdictOf(`echo "${home}/Documents" && ls -R "${home}"`, plainProject) === 'allowed')

for (const root of [scratch, plainProject]) rmSync(root, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'delete-ward-quoted-operand: ALL LAWS HOLD' : `delete-ward-quoted-operand: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)

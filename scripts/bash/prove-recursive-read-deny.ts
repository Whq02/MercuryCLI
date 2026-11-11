#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/pathValidation.ts src/Tool.ts
// gate-watch: src/utils/permissions/filesystem.ts src/utils/verification/scanCeiling.ts
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'recursive-read-deny-')))
const root = join(scratch, 'run')
mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(join(root, 'plain'))
mkdirSync(join(root, 'secrets'))
mkdirSync(join(root, 'linked'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'README'), 'hello K\n')
writeFileSync(join(root, 'hidden.key'), 'K\n')
writeFileSync(join(root, 'sub', 'hidden.key'), 'K\n')
writeFileSync(join(root, 'sub', 'notes.txt'), 'K\n')
writeFileSync(join(root, 'plain', 'notes.txt'), 'K\n')
writeFileSync(join(root, 'secrets', 'k.txt'), 'K\n')
let linked = true
try {
  symlinkSync(join(root, 'README'), join(root, 'linked', 'hidden.key'))
} catch (error) {
  if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  linked = false
}
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_TREE_SCAN_CEILING
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

type Rules = { deny?: string[]; allow?: string[] }
type Decision = { behavior: string; message?: string }
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode: string, rules: Rules = {}): Promise<Decision> => {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAllowRules: { localSettings: rules.allow ?? [] }, alwaysAskRules: {} } }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'recursive' } } as never, 'recursive')
  return outcome.decision as Decision
}
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const MODES = ['default', 'implement', 'sovereign']
const keyRule: Rules = { deny: ['Read(**/hidden.key)'] }
const dirRule: Rules = { deny: ['Read(secrets/**)'] }
const deniedBy = (decision: Decision, rule: string, path: string): boolean =>
  decision.behavior === 'deny' && String(decision.message).includes(`denied by the rule ${rule}`) && String(decision.message).includes(path)

console.log('prove-recursive-read-deny — a recursive read over a folder is refused when a Read deny rule names a file beneath it')

section('§1 a file-name rule: every recursive form over the folder is refused, naming the file the rule covers')
for (const [command, path] of [
  ['grep -r K .', join(root, 'hidden.key')], ['grep -R K .', join(root, 'hidden.key')], ['grep --recursive K .', join(root, 'hidden.key')],
  ['grep -rn K sub', join(root, 'sub', 'hidden.key')], ['grep -r K sub plain', join(root, 'sub', 'hidden.key')],
  ['rg K', join(root, 'hidden.key')], ['rg K sub', join(root, 'sub', 'hidden.key')], ['rg -n K .', join(root, 'hidden.key')],
  ['diff -r sub plain', join(root, 'sub', 'hidden.key')],
] as Array<[string, string]>) {
  for (const mode of MODES) {
    const verdict = await decide(command, mode, keyRule)
    check(`${mode}: ${command} → deny by Read(**/hidden.key) naming ${path.slice(root.length + 1)}`, deniedBy(verdict, 'Read(**/hidden.key)', path), shown(verdict))
  }
}

section('§2 a folder rule: a recursive read over the parent is refused at the folder')
for (const command of ['grep -r K .', 'rg K', 'rg K .']) {
  for (const mode of MODES) {
    const verdict = await decide(command, mode, dirRule)
    check(`${mode}: ${command} → deny by Read(secrets/**)`, deniedBy(verdict, 'Read(secrets/**)', join(root, 'secrets')), shown(verdict))
  }
}

section('§3 the refusal reaches no further than the rule')
for (const [command, rules, label] of [
  ['grep -r K plain', keyRule, 'a folder without the file is searched'],
  ['grep K README', keyRule, 'a plain grep of one file is not recursive'],
  ['grep -r K README', keyRule, 'a recursive flag over a file operand reads that file alone'],
  ['rg K README', keyRule, 'rg over a file operand reads that file alone'],
  ['grep -r K sub', dirRule, 'the folder rule does not reach a sibling folder'],
  ['grep -r K .', {}, 'with no Read deny rule the walk does not run'],
] as Array<[string, Rules, string]>) {
  const verdict = await decide(command, 'default', rules)
  check(`default: ${command} — ${label}`, verdict.behavior !== 'deny', shown(verdict))
}
{
  const plain = await decide('grep -r K plain', 'default', keyRule)
  check('default: grep -r K plain stays read-only (allow)', plain.behavior === 'allow', shown(plain))
  const bare = await decide('grep -r K .', 'default')
  check('default: grep -r K . with no rule stays read-only (allow)', bare.behavior === 'allow', shown(bare))
}

section('§4 links: a link named like the rule is refused when the command follows links')
if (!linked) console.log('  (skip) this account may not create a file symlink (EPERM on win32); the link rows are not run')
else {
  const followed = await decide('grep -R K linked', 'default', keyRule)
  check('grep -R over a link named hidden.key → deny by the rule', deniedBy(followed, 'Read(**/hidden.key)', join(root, 'linked', 'hidden.key')), shown(followed))
}

section('§5 the walk is bounded by the tree-fingerprint ceiling; past it default mode asks and sovereign asks nothing')
{
  mkdirSync(join(root, 'big'))
  for (const name of ['f1', 'f2', 'f3', 'f4', 'f5']) writeFileSync(join(root, 'big', name), 'K\n')
  process.env.MERCURY_TREE_SCAN_CEILING = '2'
  const over = await decide('grep -r K big', 'default', keyRule)
  check('over the ceiling, default mode asks to narrow the search', over.behavior === 'ask' && over.message === `grep reads under ${join(root, 'big')}, a tree of more than 2 entries; narrow the search, or approve`, shown(over))
  const sovereign = await decide('grep -r K big', 'sovereign', keyRule)
  check('over the ceiling, sovereign asks nothing', sovereign.behavior === 'allow', shown(sovereign))
  const unruled = await decide('grep -r K big', 'default')
  check('without a Read deny rule the ceiling is never met: the walk does not run', unruled.behavior === 'allow', shown(unruled))
  delete process.env.MERCURY_TREE_SCAN_CEILING
  const within = await decide('grep -r K big', 'default', keyRule)
  check('with the ceiling back, the folder without the file is searched', within.behavior === 'allow', shown(within))
}

section('§6 sovereign asks nothing: each command is a deny by the rule or an allow')
for (const [command, rules] of [
  ['grep -r K .', keyRule], ['rg K', keyRule], ['grep -r K plain', keyRule], ['grep -r K .', dirRule], ['grep -r K sub', dirRule], ['rg K README', keyRule], ['grep -r K .', {}], ...(linked ? [['grep -R K linked', keyRule]] : []),
] as Array<[string, Rules]>) {
  const verdict = await decide(command, 'sovereign', rules)
  check(`sovereign: ${command} → ${verdict.behavior} (not ask)`, verdict.behavior !== 'ask', shown(verdict))
}

section('§7 git prints a file too: a reader of a denied path is refused by the rule in every mode, and a form with no path is read as a recursive grep over the folder is')
{
  const patch = `-${'p'}`
  const key = join(root, 'secrets', 'k.txt')
  const named: Array<[string, string]> = [
    ['git show HEAD:secrets/k.txt', key], ['git show :secrets/k.txt', key], ['git show :0:secrets/k.txt', key], [`git cat-file ${patch} HEAD:secrets/k.txt`, key], ['git cat-file blob HEAD:secrets/k.txt', key],
    ['git blame secrets/k.txt', key], ['git blame HEAD -- secrets/k.txt', key], ['git diff HEAD -- secrets/k.txt', key], ['git diff HEAD secrets/k.txt', key], ['git diff -- secrets', join(root, 'secrets')],
    [`git log ${patch} -- secrets/k.txt`, key], ['git log --patch --follow secrets/k.txt', key], ['git grep K -- secrets', join(root, 'secrets')], ['git grep -n K secrets/k.txt', key], ['git -C . show HEAD:secrets/k.txt', key],
    ['git grep K', join(root, 'secrets')], ['git grep -e K', join(root, 'secrets')], [`git log ${patch}`, join(root, 'secrets')], [`git log ${patch} -3`, join(root, 'secrets')],
  ]
  for (const [command, path] of named) {
    for (const mode of MODES) {
      const verdict = await decide(command, mode, dirRule)
      check(`${mode}: ${command} → deny by Read(secrets/**) naming ${path.slice(root.length + 1)}`, deniedBy(verdict, 'Read(secrets/**)', path), shown(verdict))
    }
  }
  for (const [command, label] of [
    ['git show HEAD:plain/notes.txt', 'another file is shown'], ['git blame README', 'another file is blamed'], ['git diff HEAD -- plain', 'another folder is compared'],
    [`git log ${patch} -- plain/notes.txt`, 'another file\'s history is printed'], ['git grep K -- plain sub', 'a search of folders without the path runs'],
    ['git log --oneline', 'a log with no patch prints no file'], ['git status', 'the status prints no file'], ['git show HEAD', 'a commit with no path named is left as it was'], ['git diff', 'a diff with no path named is left as it was'],
  ] as Array<[string, string]>) {
    for (const mode of MODES) {
      const verdict = await decide(command, mode, dirRule)
      check(`${mode}: ${command} — ${label}`, verdict.behavior !== 'deny', shown(verdict))
    }
  }
  for (const command of ['git grep K', `git log ${patch}`, 'git show HEAD:secrets/k.txt']) {
    const bare = await decide(command, 'sovereign')
    check(`sovereign: ${command} with no Read deny rule is allowed as before`, bare.behavior === 'allow', shown(bare))
  }
}

process.chdir(previousCwd)
removeScratch(scratch)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

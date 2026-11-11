#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { slashed } from '../lib/platformPath.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rule-path-alias-')))
const run = join(scratch, 'run')
const real = join(scratch, 'real')
const alias = join(scratch, 'alias')
mkdirSync(run)
mkdirSync(real)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(real, 'secret.txt'), 'S\n')
writeFileSync(join(real, 'other.txt'), 'O\n')
writeFileSync(join(run, 'a.txt'), 'a\n')
symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
const previousCwd = process.cwd()
process.chdir(run)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')

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
const ruleSpelling = (path: string): string => (process.platform === 'win32' ? `//${path[0]}/${slashed(path.slice(3))}` : `/${path}`)
const permissionContext = (mode: string, rules: Rules = {}) => ({
  ...getEmptyToolPermissionContext(),
  mode,
  isBypassPermissionsModeAvailable: mode === 'sovereign',
  alwaysDenyRules: { localSettings: rules.deny ?? [] },
  alwaysAllowRules: { localSettings: rules.allow ?? [] },
  alwaysAskRules: {},
})
const bash = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const decide = async (command: string, mode: string, rules: Rules = {}): Promise<Decision> => {
  const state = { toolPermissionContext: permissionContext(mode, rules) }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'alias' } } as never, 'alias')
  return outcome.decision as Decision
}
const readTool = { name: 'Read', getPath: (input: { file_path: string }) => input.file_path }
const writeTool = { name: 'Write', getPath: (input: { file_path: string }) => input.file_path }
const readVerdict = (path: string, rules: Rules): string => checkReadPermissionForTool(readTool, { file_path: path }, permissionContext('default', rules) as never).behavior
const writeVerdict = (path: string, rules: Rules): string => checkWritePermissionForTool(writeTool, { file_path: path }, permissionContext('default', rules) as never).behavior
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const A = slashed(alias)
const R = slashed(real)

console.log('prove-rule-path-alias — a file rule written through a path alias holds for the resolved path and back')

const denyReadAlias: Rules = { deny: [`Read(${ruleSpelling(alias)}/**)`] }
const denyEditAlias: Rules = { deny: [`Edit(${ruleSpelling(alias)}/**)`] }
const denyReadReal: Rules = { deny: [`Read(${ruleSpelling(real)}/**)`] }
const denyReadOne: Rules = { deny: [`Read(${ruleSpelling(alias)}/other.txt)`] }

section('§1 Bash: a Read deny rule written through the alias refuses the file by either spelling, in every mode')
for (const mode of ['default', 'implement', 'sovereign']) {
  for (const spelled of [`${A}/secret.txt`, `${R}/secret.txt`]) {
    const verdict = await decide(`cat ${spelled}`, mode, denyReadAlias)
    check(`${mode}: cat ${spelled.startsWith(A) ? '<alias>' : '<real>'}/secret.txt → deny`, verdict.behavior === 'deny' && String(verdict.message).includes('denied by the rule Read('), shown(verdict))
  }
}

section('§2 Bash: an Edit deny rule written through the alias refuses writes to the resolved path')
for (const mode of ['default', 'implement', 'sovereign']) {
  for (const command of [`echo x > ${R}/secret.txt`, `touch ${R}/secret.txt`, `cp a.txt ${R}/secret.txt`]) {
    const verdict = await decide(command, mode, denyEditAlias)
    check(`${mode}: ${command.replace(R, '<real>')} → deny`, verdict.behavior === 'deny' && String(verdict.message).includes('denied by the rule Edit('), shown(verdict))
  }
}

section('§3 the Read and Write tools agree with Bash: the resolved path is refused under the alias rule, and the alias under the resolved rule')
check('Read tool: the alias spelling under the alias rule → deny', readVerdict(`${alias}/secret.txt`.replace(/\//g, process.platform === 'win32' ? '\\' : '/'), denyReadAlias) === 'deny')
check('Read tool: the resolved path under the alias rule → deny', readVerdict(join(real, 'secret.txt'), denyReadAlias) === 'deny', readVerdict(join(real, 'secret.txt'), denyReadAlias))
check('Read tool: the alias spelling under the resolved rule → deny', readVerdict(join(alias, 'secret.txt'), denyReadReal) === 'deny', readVerdict(join(alias, 'secret.txt'), denyReadReal))
check('Write tool: the resolved path under the alias rule → deny', writeVerdict(join(real, 'secret.txt'), denyEditAlias) === 'deny', writeVerdict(join(real, 'secret.txt'), denyEditAlias))
check('Write tool: the alias spelling under the alias rule → deny', writeVerdict(join(alias, 'secret.txt'), denyEditAlias) === 'deny', writeVerdict(join(alias, 'secret.txt'), denyEditAlias))

section('§4 the rule written through the resolved path keeps refusing the alias spelling (the road that already worked)')
for (const mode of ['default', 'sovereign']) {
  const verdict = await decide(`cat ${A}/secret.txt`, mode, denyReadReal)
  check(`${mode}: cat <alias>/secret.txt under the resolved rule → deny`, verdict.behavior === 'deny', shown(verdict))
}

section('§5 no over-reach: a rule naming one file through the alias leaves the other file alone')
check('Read tool: secret.txt is not covered by a rule for other.txt', readVerdict(join(real, 'secret.txt'), denyReadOne) !== 'deny')
{
  const verdict = await decide(`cat ${R}/secret.txt`, 'default', denyReadOne)
  check('Bash: cat <real>/secret.txt is not denied by a rule for other.txt', verdict.behavior !== 'deny', shown(verdict))
  const covered = await decide(`cat ${R}/other.txt`, 'default', denyReadOne)
  check('Bash: cat <real>/other.txt is denied by that rule', covered.behavior === 'deny', shown(covered))
}

if (process.platform === 'darwin') {
  section('§6 the system alias on this platform: /etc and /private/etc name the same file')
  for (const [rule, spelled] of [['//etc/hosts', '/private/etc/hosts'], ['//private/etc/hosts', '/etc/hosts'], ['//etc/hosts', '/etc/hosts']]) {
    for (const mode of ['default', 'sovereign']) {
      const verdict = await decide(`cat ${spelled}`, mode, { deny: [`Read(${rule})`] })
      check(`${mode}: cat ${spelled} under Read(${rule}) → deny`, verdict.behavior === 'deny', shown(verdict))
    }
    check(`Read tool: ${spelled} under Read(${rule}) → deny`, readVerdict(spelled, { deny: [`Read(${rule})`] }) === 'deny')
  }
}

section('§7 sovereign asks nothing: every command above is a deny by the rule or an allow, never a question')
for (const [command, rules] of [
  [`cat ${A}/secret.txt`, denyReadAlias], [`cat ${R}/secret.txt`, denyReadAlias], [`cat ${R}/other.txt`, denyReadOne],
  [`echo x > ${R}/secret.txt`, denyEditAlias], [`cp a.txt ${R}/secret.txt`, denyEditAlias], [`cat ${R}/secret.txt`, {}], [`cat a.txt`, denyReadAlias],
] as Array<[string, Rules]>) {
  const verdict = await decide(command, 'sovereign', rules)
  check(`sovereign: ${command.replace(R, '<real>').replace(A, '<alias>')} → ${verdict.behavior} (not ask)`, verdict.behavior !== 'ask', shown(verdict))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

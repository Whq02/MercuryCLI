#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'deny-every-operand-')))
const run = join(scratch, 'run')
mkdirSync(run)
mkdirSync(join(run, 'sub'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(run, 'secret.txt'), 'S\n')
writeFileSync(join(run, 'a.txt'), 'a\n')
writeFileSync(join(run, 'b.txt'), 'b\n')
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
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'operand' } } as never, 'operand')
  return outcome.decision as Decision
}
const shown = (decision: Decision): string => `${decision.behavior}: ${decision.message ?? ''}`
const MODES = ['default', 'implement', 'sovereign']
const editDeny: Rules = { deny: ['Edit(secret.txt)'] }
const readDeny: Rules = { deny: ['Read(secret.txt)'] }

console.log('prove-deny-every-operand — a file deny rule holds for every operand of a shell command, not only the first')

section('§1 an Edit deny on the last operand refuses the command in every mode, whatever stood before it')
for (const command of ['cp a.txt secret.txt', 'mv a.txt secret.txt', 'touch a.txt secret.txt', 'rm a.txt secret.txt', 'mkdir sub/new secret.txt', 'echo x | tee a.txt secret.txt', 'cp a.txt b.txt secret.txt', 'touch secret.txt a.txt']) {
  for (const mode of MODES) {
    const verdict = await decide(command, mode, editDeny)
    check(`${mode}: ${command} → deny by Edit(secret.txt)`, verdict.behavior === 'deny' && String(verdict.message).includes('denied by the rule Edit(secret.txt)'), shown(verdict))
  }
}

section('§2 a Read deny on the source of a copy or move refuses it: the content would reach a readable name')
for (const command of ['cp secret.txt copy.txt', 'mv secret.txt copy.txt', 'cp secret.txt sub/', 'cp a.txt secret.txt sub/']) {
  for (const mode of MODES) {
    const verdict = await decide(command, mode, readDeny)
    check(`${mode}: ${command} → deny by Read(secret.txt)`, verdict.behavior === 'deny' && String(verdict.message).includes('denied by the rule Read(secret.txt)'), shown(verdict))
  }
}

section('§3 the rules reach no further than they say')
for (const [command, rules, label] of [
  ['cp a.txt copy.txt', readDeny, 'a copy of another file is not caught by Read(secret.txt)'],
  ['cp a.txt secret.txt', readDeny, 'a Read rule on the destination does not refuse a write onto it'],
  ['cp a.txt copy.txt', editDeny, 'a copy to another file is not caught by Edit(secret.txt)'],
  ['cat secret.txt', editDeny, 'reading the file is not caught by an Edit rule'],
] as Array<[string, Rules, string]>) {
  const verdict = await decide(command, 'implement', rules)
  check(`implement: ${command} — ${label}`, verdict.behavior !== 'deny', shown(verdict))
}

section('§4 an operand that merely needs approval does not hide a denied one behind it; without a deny the first such operand still decides')
{
  const outside = `..${process.platform === 'win32' ? '\\' : '/'}outside.txt`
  for (const mode of MODES) {
    const verdict = await decide(`touch ${outside} secret.txt`, mode, editDeny)
    check(`${mode}: touch ${outside} secret.txt → deny`, verdict.behavior === 'deny', shown(verdict))
  }
  const plain = await decide(`touch ${outside} a.txt`, 'default')
  check('default: touch <outside> a.txt → asks naming the outside file', plain.behavior === 'ask' && String(plain.message).includes('outside.txt'), shown(plain))
}

section('§5 sovereign asks nothing: each command is a deny by the rule or an allow')
for (const [command, rules] of [
  ['cp a.txt secret.txt', editDeny], ['mv a.txt secret.txt', editDeny], ['touch a.txt secret.txt', editDeny], ['echo x | tee a.txt secret.txt', editDeny],
  ['cp secret.txt copy.txt', readDeny], ['mv secret.txt copy.txt', readDeny],
  ['cp a.txt copy.txt', readDeny], ['cp a.txt copy.txt', editDeny], ['touch a.txt b.txt', editDeny], ['cp a.txt secret.txt', {}],
] as Array<[string, Rules]>) {
  const verdict = await decide(command, 'sovereign', rules)
  check(`sovereign: ${command} → ${verdict.behavior} (not ask)`, verdict.behavior !== 'ask', shown(verdict))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

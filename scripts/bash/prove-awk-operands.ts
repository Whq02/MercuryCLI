#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/pathValidation.ts src/Tool.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'awk-operands-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(scratch, 'outside'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 's.txt'), 'zzz\n')
const outsideWords = join(scratch, 'outside', 'words')
writeFileSync(outsideWords, 'alpha\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { checkPathConstraints, PATH_EXTRACTORS } = await import('../../src/tools/BashTool/pathValidation.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)
type Verdict = { behavior: string; message?: string }
const context = (extra: Record<string, unknown> = {}) => ({ ...getEmptyToolPermissionContext(), mode: 'default', ...extra })
const decide = async (command: string, extra: Record<string, unknown> = {}): Promise<Verdict> =>
  (await bashToolHasPermission({ command } as never, context(extra) as never)) as Verdict
const shown = (v: Verdict): string => `${v.behavior}: ${v.message ?? ''}`
const AWK_RULE = { alwaysAllowRules: { userSettings: ['Bash(awk *)'] } }

console.log('prove-awk-operands — the awk program is never a path; its real operands are')

console.log('\n1. the program text is not an operand')
{
  const got = PATH_EXTRACTORS.awk(['/zzz/{f=1} END{exit !f}', 's.txt'])
  check(`awk(['/zzz/{f=1} END{exit !f}', 's.txt']) → ['s.txt']`, j(got) === j(['s.txt']), j(got))
}

console.log('\n2. the option table')
{
  const rows: Array<[string[], string[]]> = [
    [['-F', ':', '{print $1}', '/etc/passwd'], ['/etc/passwd']],
    [['-f', 'prog.awk', 'in.txt'], ['prog.awk', 'in.txt']],
    [['-v', 'n=3', '$1>n', 'a.txt', 'OFS=,', 'b.txt', '-'], ['a.txt', 'b.txt']],
    [['--', '{print}', 'x'], ['x']],
    [['-fprog.awk', 'in.txt'], ['prog.awk', 'in.txt']],
    [['--file=prog.awk', 'in.txt'], ['prog.awk', 'in.txt']],
    [['-E', 'prog.awk', '-v', 'in.txt'], ['prog.awk', '-v', 'in.txt']],
    [['-e', '{print}', 'in.txt'], ['in.txt']],
    [['-i', 'lib.awk', '{print}', 'in.txt'], ['lib.awk', 'in.txt']],
    [['-F:', '{print $1}'], []],
    [['-va=b', '{print a}', 'in.txt'], ['in.txt']],
  ]
  for (const [args, want] of rows) {
    const got = PATH_EXTRACTORS.awk(args)
    check(`awk(${j(args)}) → ${j(want)}`, j(got) === j(want), j(got))
  }
}

console.log('\n3. the path check passes a program that only looks like a path')
{
  const slash = checkPathConstraints({ command: 'awk "/zzz/{f=1} END{exit !f}" s.txt' }, root, context() as never) as Verdict
  check('awk "/zzz/{f=1} END{exit !f}" s.txt → passthrough', slash.behavior === 'passthrough', shown(slash))
  const dollar = checkPathConstraints({ command: "awk '{print $1}' s.txt" }, root, context() as never) as Verdict
  check("awk '{print $1}' s.txt → passthrough", dollar.behavior === 'passthrough', shown(dollar))
}

console.log('\n4. with Bash(awk *) allowed, an awk whose operands pass the path check runs')
{
  const v = await decide('awk "/zzz/{f=1} END{exit !f}" s.txt', AWK_RULE)
  check('awk "/zzz/{f=1} END{exit !f}" s.txt → allow', v.behavior === 'allow', shown(v))
  const dollar = await decide("awk '{print $1}' s.txt", AWK_RULE)
  check("awk '{print $1}' s.txt → allow", dollar.behavior === 'allow', shown(dollar))
}

console.log('\n5. what keeps refusing')
{
  const noRule = await decide('awk "/zzz/{f=1} END{exit !f}" s.txt')
  check('no rule, mode default → not allow', noRule.behavior !== 'allow', shown(noRule))
  check('the words name the part as written and the word awk', noRule.message === '`awk "/zzz/{f=1} END{exit !f}" s.txt` requires approval: `awk` is not a command Mercury can verify as read-only.', shown(noRule))
  const outside = await decide(`awk '{print}' ${outsideWords}`, AWK_RULE)
  check('a real input file outside the starting folder asks naming it', outside.behavior === 'ask' && outside.message === `Mercury needs permission to process ${outsideWords}, outside the starting folder ('${root}').`, shown(outside))
  const program = await decide(`awk -f ${join(scratch, 'outside', 'prog.awk')} s.txt`, AWK_RULE)
  check('a program file outside the starting folder asks naming it', program.behavior === 'ask' && (program.message ?? '').startsWith(`Mercury needs permission to process ${join(scratch, 'outside', 'prog.awk')}, outside the starting folder`), shown(program))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-awk-operands: ALL LAWS HOLD' : `\nprove-awk-operands: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

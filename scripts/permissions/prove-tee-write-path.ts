#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'tee-write-path-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.ts')
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'tee-write-path-out-')))
const out = join(OUTSIDE, 'written.txt')
const cwd = process.cwd()
const inside = join(cwd, 'tee-write-path-probe.txt')
const insideCopy = join(cwd, 'tee-write-path-copy.txt')
const ctxIn = (mode: string, denyRules: string[] = []): Ctx =>
  ({ mode, alwaysAllowRules: {}, alwaysDenyRules: denyRules.length > 0 ? { session: denyRules } : {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() }) as unknown as Ctx
const decideIn = (ctx: Ctx, command: string): string => (checkPathConstraints({ command }, cwd, ctx) as { behavior: string }).behavior
const implement = ctxIn('implement')
const plain = ctxIn('default')
const decide = (command: string): string => decideIn(implement, command)

section('§1 tee is a writer: its file operands take the redirection road (the mode that writes inside the working directory on its own)')
check('control: a redirection to a file outside the working directory is held for approval', decide(`echo x > ${out}`) === 'ask', decide(`echo x > ${out}`))
check('control: a redirection to a file inside the working directory passes through', decide(`echo x > ${inside}`) === 'passthrough', decide(`echo x > ${inside}`))
check('tee writing the outside file is held the way the redirection is', decide(`echo x | tee ${out}`) === 'ask', decide(`echo x | tee ${out}`))
check('tee -a (append) to the outside file is held the same way', decide(`echo x | tee -a ${out}`) === 'ask', decide(`echo x | tee -a ${out}`))
check('tee with several files holds on the outside one', decide(`echo x | tee ${inside} ${out}`) === 'ask', decide(`echo x | tee ${inside} ${out}`))
check('tee to a file inside the working directory passes through', decide(`echo x | tee ${inside}`) === 'passthrough', decide(`echo x | tee ${inside}`))
check('tee -a to a file inside the working directory passes through', decide(`echo x | tee -a ${inside}`) === 'passthrough', decide(`echo x | tee -a ${inside}`))
check('tee to /dev/null passes through (the redirection road exempts it too)', decide('echo x | tee /dev/null') === 'passthrough', decide('echo x | tee /dev/null'))
check('tee inside a compound command with a cd is held (the final directory is unknown)', decide(`cd ${OUTSIDE} && echo x | tee written.txt`) !== 'passthrough', decide(`cd ${OUTSIDE} && echo x | tee written.txt`))
check("in the mode that asks before every write, tee inside the working directory answers as the redirection does", decideIn(plain, `echo x | tee ${inside}`) === decideIn(plain, `echo x > ${inside}`), `${decideIn(plain, `echo x | tee ${inside}`)} vs ${decideIn(plain, `echo x > ${inside}`)}`)

section('§2 dd writes through of=: the same road')
check('dd of= an outside file is held for approval', decide(`dd if=/dev/zero of=${out} bs=1 count=1`) === 'ask', decide(`dd if=/dev/zero of=${out} bs=1 count=1`))
check('dd of= a file inside the working directory passes through', decide(`dd if=/dev/zero of=${inside} bs=1 count=1`) === 'passthrough', decide(`dd if=/dev/zero of=${inside} bs=1 count=1`))
check('dd without of= writes to stdout and passes through', decide(`dd if=${inside} bs=1 count=1`) === 'passthrough', decide(`dd if=${inside} bs=1 count=1`))

section('§3 the other writers the same seam already covers: cp and mv')
check('cp to an outside file is held for approval', decide(`cp ${inside} ${out}`) === 'ask', decide(`cp ${inside} ${out}`))
check('mv to an outside file is held for approval', decide(`mv ${inside} ${out}`) === 'ask', decide(`mv ${inside} ${out}`))
check('cp inside the working directory passes through', decide(`cp ${inside} ${insideCopy}`) === 'passthrough', decide(`cp ${inside} ${insideCopy}`))

section('§4 a deny rule on the target refuses tee and dd as it refuses a redirection')
const denied = ctxIn('implement', [`Edit(//${OUTSIDE.replace(/^\/+/, '')}/**)`])
check('control: the redirection to the denied directory is refused by the rule', decideIn(denied, `echo x > ${out}`) === 'deny', decideIn(denied, `echo x > ${out}`))
check('tee to the denied directory is refused by the rule', decideIn(denied, `echo x | tee ${out}`) === 'deny', decideIn(denied, `echo x | tee ${out}`))
check('dd of= the denied directory is refused by the rule', decideIn(denied, `dd if=/dev/zero of=${out}`) === 'deny', decideIn(denied, `dd if=/dev/zero of=${out}`))

rmSync(HOME, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

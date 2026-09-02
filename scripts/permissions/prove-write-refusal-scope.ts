#!/usr/bin/env bun
// prove-write-refusal-scope — the write refusal stops contradicting itself
// (field card FC-059, re-rated S2: the grant fails closed; what was wrong
// is the sentence and the unnamed read-only scope). An added working
// directory carries READ scope, but the refusal listed it among "the
// allowed directories" while refusing a write to its own child. A write
// into an added directory now names the read-only scope and both write
// roads; an ordinary outside write names the working directory alone.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-scope-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.ts')
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const ADDED = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-scope-added-')))
const ctx = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  additionalWorkingDirectories: new Map([[ADDED, { path: ADDED, source: 'session' }]]),
} as unknown as Ctx

const inAdded = checkPathConstraints({ command: `touch ${join(ADDED, 'f.txt')}` }, process.cwd(), ctx) as {
  behavior: string
  message?: string
}
check('a write into the added directory still asks (fails closed)', inAdded.behavior === 'ask', inAdded.behavior)
check(
  'and the sentence NAMES the read-only scope (FC-059)',
  /grants reads only/.test(inAdded.message ?? ''),
  JSON.stringify(inAdded.message?.slice(0, 160)),
)
check('and never lists the added dir as write-allowed', !/allowed directories \(.*${ADDED}/.test(inAdded.message ?? ''))
check('and teaches a write road', /Edit\(/.test(inAdded.message ?? ''))

const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-scope-out-')))
const outside = checkPathConstraints({ command: `touch ${join(OUTSIDE, 'f.txt')}` }, process.cwd(), ctx) as {
  behavior: string
  message?: string
}
check('an ordinary outside write names the working directory alone', /working directory/.test(outside.message ?? ''), JSON.stringify(outside.message?.slice(0, 140)))
check('and does not list the added directory', !(outside.message ?? '').includes(ADDED))

rmSync(HOME, { recursive: true, force: true })
rmSync(ADDED, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-write-refusal-scope: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-write-refusal-scope: all green')

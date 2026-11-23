#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launchDir = process.cwd()
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'file-rule-family-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'file-rule-family-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const { matchingRuleForInput, getFileReadIgnorePatterns } = await import(
  '../../src/permissions/rules/filesystem.ts'
)
type Ctx = import('../../src/permissions/rules/permissionDoor.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ctxWithDeny = (rules: string[]): Ctx =>
  ({
    alwaysDenyRules: { session: rules },
    alwaysAllowRules: {},
    alwaysAskRules: {},
  }) as unknown as Ctx

const inScratch = join(PROJ, 'scratch', 'x.ts')

section('§1 EDIT FAMILY')
{
  const writeDeny = matchingRuleForInput(inScratch, ctxWithDeny(['Write(scratch/**)']), 'edit', 'deny')
  check('a Write(<glob>) deny covers an edit-type path (FC-003)', writeDeny !== null, JSON.stringify(writeDeny), 'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor / matchingRuleForInput must treat a Write rule as part of the edit family')
  const nbDeny = matchingRuleForInput(inScratch, ctxWithDeny(['NotebookEdit(scratch/**)']), 'edit', 'deny')
  check('a NotebookEdit(<glob>) deny covers an edit-type path', nbDeny !== null, '', 'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor / matchingRuleForInput must treat a NotebookEdit rule as part of the edit family')
  const editControl = matchingRuleForInput(inScratch, ctxWithDeny(['Edit(scratch/**)']), 'edit', 'deny')
  check('control: an Edit(<glob>) deny still covers', editControl !== null, '', 'fix in src/permissions/rules/filesystem.ts: matchingRuleForInput must still match a plain Edit(scratch/**) deny for an edit-type path')
  const outside = matchingRuleForInput(join(PROJ, 'other', 'y.ts'), ctxWithDeny(['Write(scratch/**)']), 'edit', 'deny')
  check('a non-matching path stays uncovered (no over-reach)', outside === null, '', 'fix in src/permissions/rules/filesystem.ts: matchingRuleForInput must return null for a path outside the rule glob')
  const readTypeMiss = matchingRuleForInput(inScratch, ctxWithDeny(['Write(scratch/**)']), 'read', 'deny')
  check('a Write rule does NOT govern read-type paths (families stay split)', readTypeMiss === null, '', 'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor must keep Write rules out of the read family')
}

section('§2 READ FAMILY')
{
  const globDeny = matchingRuleForInput(inScratch, ctxWithDeny(['Glob(scratch/**)']), 'read', 'deny')
  check('a Glob(<glob>) deny covers a read-type path (FC-003)', globDeny !== null, JSON.stringify(globDeny), 'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor / matchingRuleForInput must treat a Glob rule as part of the read family')
  const nbReadDeny = matchingRuleForInput(inScratch, ctxWithDeny(['NotebookRead(scratch/**)']), 'read', 'deny')
  check('a NotebookRead(<glob>) deny covers a read-type path', nbReadDeny !== null, '', 'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor / matchingRuleForInput must treat a NotebookRead rule as part of the read family')
  const readControl = matchingRuleForInput(inScratch, ctxWithDeny(['Read(scratch/**)']), 'read', 'deny')
  check('control: a Read(<glob>) deny still covers', readControl !== null, '', 'fix in src/permissions/rules/filesystem.ts: matchingRuleForInput must still match a plain Read(scratch/**) deny for a read-type path')

  const patterns = getFileReadIgnorePatterns(ctxWithDeny(['Glob(scratch/**)', 'Read(hidden/**)']))
  const flat = [...patterns.values()].flat()
  check(
    'the search-tool ignore patterns carry Glob deny rules too',
    flat.includes('scratch/**') && flat.includes('hidden/**'),
    JSON.stringify(flat),
    'fix in src/permissions/rules/filesystem.ts: getFileReadIgnorePatterns must collect Glob deny rules as well as Read deny rules',
  )
}

section('§3 COLLISION PRECEDENCE')
{
  const collided = matchingRuleForInput(
    inScratch,
    ctxWithDeny(['Write(scratch/**)', 'Edit(scratch/**)']),
    'edit',
    'deny',
  )
  check(
    'the canonical member (Edit) wins a same-pattern collision',
    collided !== null && collided.ruleValue.toolName === 'Edit',
    JSON.stringify(collided?.ruleValue),
    'fix in src/permissions/rules/filesystem.ts: ruleMatcherFor / matchingRuleForInput must return the canonical Edit rule first when Write and Edit share a pattern',
  )
}

process.chdir(launchDir)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-file-rule-family: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-file-rule-family: all green')

#!/usr/bin/env bun
// prove-file-rule-family — file-pattern rules by family (field card FC-003).
// The validator declares Write(<glob>), NotebookEdit(<glob>), Glob(<glob>)
// and NotebookRead(<glob>) valid and hands them out as examples, but the path
// matcher resolved only Edit and Read — every other member's rule was inert:
// as an allow it granted nothing, as a deny it denied nothing. The matcher
// now consults the whole family per capability (edit: Write · NotebookEdit ·
// Edit; read: Glob · NotebookRead · Read), canonical member winning
// same-pattern collisions.
//
//   §1 edit-family deny rules cover edit-type paths.
//   §2 read-family deny rules cover read-type paths + the ignore patterns.
//   §3 the canonical member wins a same-pattern collision.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// realpath both roots: macOS tmpdir is a symlink and getCwd() resolves it.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'file-rule-family-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'file-rule-family-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const { matchingRuleForInput, getFileReadIgnorePatterns } = await import(
  '../../src/utils/permissions/filesystem.ts'
)
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
  check('a Write(<glob>) deny covers an edit-type path (FC-003)', writeDeny !== null, JSON.stringify(writeDeny))
  const nbDeny = matchingRuleForInput(inScratch, ctxWithDeny(['NotebookEdit(scratch/**)']), 'edit', 'deny')
  check('a NotebookEdit(<glob>) deny covers an edit-type path', nbDeny !== null)
  const editControl = matchingRuleForInput(inScratch, ctxWithDeny(['Edit(scratch/**)']), 'edit', 'deny')
  check('control: an Edit(<glob>) deny still covers', editControl !== null)
  const outside = matchingRuleForInput(join(PROJ, 'other', 'y.ts'), ctxWithDeny(['Write(scratch/**)']), 'edit', 'deny')
  check('a non-matching path stays uncovered (no over-reach)', outside === null)
  const readTypeMiss = matchingRuleForInput(inScratch, ctxWithDeny(['Write(scratch/**)']), 'read', 'deny')
  check('a Write rule does NOT govern read-type paths (families stay split)', readTypeMiss === null)
}

section('§2 READ FAMILY')
{
  const globDeny = matchingRuleForInput(inScratch, ctxWithDeny(['Glob(scratch/**)']), 'read', 'deny')
  check('a Glob(<glob>) deny covers a read-type path (FC-003)', globDeny !== null, JSON.stringify(globDeny))
  const nbReadDeny = matchingRuleForInput(inScratch, ctxWithDeny(['NotebookRead(scratch/**)']), 'read', 'deny')
  check('a NotebookRead(<glob>) deny covers a read-type path', nbReadDeny !== null)
  const readControl = matchingRuleForInput(inScratch, ctxWithDeny(['Read(scratch/**)']), 'read', 'deny')
  check('control: a Read(<glob>) deny still covers', readControl !== null)

  const patterns = getFileReadIgnorePatterns(ctxWithDeny(['Glob(scratch/**)', 'Read(hidden/**)']))
  const flat = [...patterns.values()].flat()
  check(
    'the search-tool ignore patterns carry Glob deny rules too',
    flat.includes('scratch/**') && flat.includes('hidden/**'),
    JSON.stringify(flat),
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
  )
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-file-rule-family: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-file-rule-family: all green')

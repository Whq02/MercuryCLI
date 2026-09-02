#!/usr/bin/env bun
// prove-grant-matches-label — the Bash card's directory option grants what
// its label names (field card FC-022). "Yes, and allow access to <dir> in
// this project" ALSO switched the whole session into implement mode — one
// keystroke aimed at one directory turned off the ask for every write in the
// cwd for the rest of the session, unnamed on the card. The suggestion now
// grants the directory itself: addDirectories plus session-scoped
// edit-family allow rules on that directory (the FC-003 family matcher
// honours them); no setMode rides along.
//
//   §1 the write-arm suggestions: no setMode; an edit-family rule instead.
//   §2 the minted rule actually unblocks a write in that directory
//      (validatePath step-7 allow-rule consult).
//   §3 the read arm is untouched (Read rule, no setMode).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'grant-label-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { createEditRuleSuggestion, createReadRuleSuggestion } = (await import(
  '../../src/utils/permissions/PermissionUpdate.ts'
)) as {
  createEditRuleSuggestion?: (dir: string) => unknown
  createReadRuleSuggestion: (dir: string) => unknown
}
const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.ts')
const { validatePath } = await import('../../src/utils/permissions/pathValidation.ts')
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'grant-label-outside-')))
const emptyCtx = (): Ctx =>
  ({
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }) as unknown as Ctx

section('§1 THE WRITE-ARM SUGGESTIONS')
{
  // The OPERAND write arm (attachSuggestions) is the one that bundled the
  // mode flip; the redirect arm never carried it.
  const result = checkPathConstraints(
    { command: `touch ${join(OUTSIDE, 't3.txt')}` },
    process.cwd(),
    emptyCtx(),
  ) as { behavior: string; suggestions?: Array<{ type: string; rules?: Array<{ toolName: string }> }> }
  check('an operand write outside the cwd still asks', result.behavior === 'ask', result.behavior)
  const suggestions = result.suggestions ?? []
  check(
    'NO setMode rides the directory option (FC-022)',
    !suggestions.some(s => s.type === 'setMode'),
    JSON.stringify(suggestions.map(s => s.type)),
  )
  check(
    'an edit-family allow rule is minted instead',
    suggestions.some(s => s.type === 'addRules' && (s.rules ?? []).some(r => r.toolName === 'Edit')),
    JSON.stringify(suggestions),
  )
  check('the directory grant itself still rides', suggestions.some(s => s.type === 'addDirectories'))
}

section('§2 THE MINTED RULE UNBLOCKS THE WRITE')
{
  check('createEditRuleSuggestion exists beside its read sibling', typeof createEditRuleSuggestion === 'function')
  if (typeof createEditRuleSuggestion === 'function') {
    const minted = createEditRuleSuggestion(OUTSIDE) as { rules: Array<{ toolName: string; ruleContent: string }> }
    const ctx = {
      ...emptyCtx(),
      alwaysAllowRules: { session: minted.rules.map(r => `${r.toolName}(${r.ruleContent})`) },
    } as unknown as Ctx
    const verdict = validatePath(join(OUTSIDE, 't3.txt'), process.cwd(), ctx, 'create') as { allowed?: boolean } | { allowed: boolean }
    check(
      'a create in the granted directory is ALLOWED by the minted rule',
      (verdict as { allowed: boolean }).allowed === true,
      JSON.stringify(verdict),
    )
    const elsewhere = validatePath(join(realpathSync(tmpdir()), 'grant-label-elsewhere.txt'), process.cwd(), ctx, 'create') as { allowed: boolean }
    check('a create OUTSIDE the granted directory stays blocked', elsewhere.allowed !== true, JSON.stringify(elsewhere))
  }
}

section('§3 THE READ ARM')
{
  const readSuggestion = createReadRuleSuggestion(OUTSIDE) as { rules: Array<{ toolName: string }> }
  check('the read sibling still mints a Read rule', readSuggestion.rules.some(r => r.toolName === 'Read'))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grant-matches-label: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-grant-matches-label: all green')

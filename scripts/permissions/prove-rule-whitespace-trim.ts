#!/usr/bin/env bun
// prove-rule-whitespace-trim — outer whitespace on a permission rule (field
// card FC-002). "Bash " in a settings deny list passed validation with zero
// errors and then matched nothing — the deny was inert and indistinguishable
// from a working rule on every diagnostic surface. Outer whitespace is a
// human slip (JSON padding), never grammar: the ONE rule-string parser trims
// it, so every consumer — matching, normalisation, serialisation — agrees.
//
//   §1 the parser trims outer whitespace, and only outer (inner content kept).
//   §2 the real deny door: a padded deny rule covers its tool.
//   §3 the validator judges the trimmed name (a padded lowercase name is
//      flagged for casing, not silently accepted).
import { permissionRuleValueFromString } from '../../src/utils/permissions/permissionRuleParser.ts'
import { getDenyRuleForTool } from '../../src/utils/permissions/decision/rules.ts'
import { validatePermissionRule } from '../../src/utils/settings/permissionValidation.ts'
import type { ToolPermissionContext } from '../../src/utils/permissions/permissions.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 THE PARSER')
{
  const padded = permissionRuleValueFromString('Bash ')
  check('trailing space on a bare tool rule is trimmed', padded.toolName === 'Bash', JSON.stringify(padded))
  const leading = permissionRuleValueFromString('  Read')
  check('leading whitespace is trimmed', leading.toolName === 'Read', JSON.stringify(leading))
  const beforeParen = permissionRuleValueFromString('Bash (npm:*)')
  check(
    'a space before the parenthesis still names the tool',
    beforeParen.toolName === 'Bash' && beforeParen.ruleContent === 'npm:*',
    JSON.stringify(beforeParen),
  )
  const afterParen = permissionRuleValueFromString('Bash(npm:*) ')
  check(
    'a space after the closing parenthesis is not "malformed"',
    afterParen.toolName === 'Bash' && afterParen.ruleContent === 'npm:*',
    JSON.stringify(afterParen),
  )
  const inner = permissionRuleValueFromString('Bash( spaced content )')
  check(
    'INNER content whitespace is preserved (only outer trimmed)',
    inner.ruleContent === ' spaced content ',
    JSON.stringify(inner),
  )
  const control = permissionRuleValueFromString('Bash(npm:*)')
  check('control: the unpadded spelling parses as before', control.toolName === 'Bash' && control.ruleContent === 'npm:*')
}

section('§2 THE DENY DOOR')
{
  const context = {
    alwaysDenyRules: { userSettings: ['Bash '] },
    alwaysAllowRules: {},
    alwaysAskRules: {},
  } as unknown as ToolPermissionContext
  const denied = getDenyRuleForTool(context, { name: 'Bash', mcpInfo: undefined } as never)
  check('a padded deny rule covers its tool (FC-002: the deny is no longer inert)', denied !== null, JSON.stringify(denied))

  const controlContext = {
    alwaysDenyRules: { userSettings: ['Bash'] },
    alwaysAllowRules: {},
    alwaysAskRules: {},
  } as unknown as ToolPermissionContext
  check(
    'control: the unpadded deny still covers',
    getDenyRuleForTool(controlContext, { name: 'Bash', mcpInfo: undefined } as never) !== null,
  )
}

section('§3 THE VALIDATOR')
{
  check('a padded well-cased rule stays valid', validatePermissionRule('Bash ').valid === true)
  const paddedLower = validatePermissionRule(' bash ')
  check(
    'a padded lowercase name is flagged for casing (not silently accepted)',
    paddedLower.valid === false && (paddedLower.error ?? '').includes('capitalized'),
    JSON.stringify(paddedLower),
  )
  const paddedMcp = validatePermissionRule(' mcp__srv')
  check('a padded MCP rule reaches the MCP branch', paddedMcp.valid === true, JSON.stringify(paddedMcp))
}

// ── FC-107: ONE grammar — the validator accepts what the parser enforces ────
{
  const { permissionRuleValueFromString } = await import('../../src/utils/permissions/permissionRuleParser.ts')
  const parsed = permissionRuleValueFromString('Bash()')
  check("the parser reads Bash() as the tool-wide rule", parsed.toolName === 'Bash' && parsed.ruleContent === undefined, JSON.stringify(parsed))
  const validated = validatePermissionRule('Bash()')
  check(
    'FC-107: the validator accepts the same spelling (a deny written Bash() applies, never a silent drop)',
    validated.valid === true,
    JSON.stringify(validated),
  )
  const star = validatePermissionRule('Bash(*)')
  check('the star twin stays valid (control)', star.valid === true)
  const noTool = validatePermissionRule('()')
  check('empty parens with NO tool still refuse', noTool.valid === false)
}

if (failures > 0) {
  console.error(`\nprove-rule-whitespace-trim: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-rule-whitespace-trim: all green')

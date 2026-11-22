import { z } from 'zod/v4'

import { lazySchema } from '../lazySchema.js'
import { expandRuleBraces, RULE_BRACE_BOUND, ruleBracesPastBound, starredBraces } from '../permissions/ruleBraces.js'
import { getCustomValidation, isBashPrefixTool, isFilePatternTool } from './toolValidationConfig.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


type PermissionRuleValidation = Unbuilt

function findUnescaped(rule: string, char: string, from: number = 0): number {
  for (let index = from; index < rule.length; index++) {
    if (rule[index] !== char) continue
    let backslashes = 0
    for (let scan = index - 1; scan >= 0 && rule[scan] === '\\'; scan--) backslashes++
    if (backslashes % 2 === 0) return index
  }
  return -1
}

function countUnescaped(rule: string, char: string): number {
  let count = 0
  let index = findUnescaped(rule, char)
  while (index !== -1) {
    count++
    index = findUnescaped(rule, char, index + 1)
  }
  return count
}

function hasSuspiciousWildcardPlacement(content: string): boolean {
  if (content.includes('**')) return false
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '*') continue
    const atStart = index === 0
    const atEnd = index === content.length - 1
    const afterSlash = index > 0 && content[index - 1] === '/'
    const beforeDot = content[index + 1] === '.'
    const beforeCloseParen = content[index + 1] === ')'
    if (!atStart && !atEnd && !afterSlash && !beforeDot && !beforeCloseParen) return true
  }
  return false
}

export function validatePermissionRule(rule: string): PermissionRuleValidation {
  return notBuilt('src/utils/settings/permissionValidation.ts:51')
}

export const PermissionRuleSchema: Unbuilt = unbuilt('src/utils/settings/permissionValidation.ts:174')

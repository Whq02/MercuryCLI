import type { PermissionRuleValue } from '../../types/permissions.js'
import { notBuilt } from '../../pi/holes.js'

export function precedingBackslashes(text: string, i: number): number {
  let count = 0
  let j = i - 1
  while (j >= 0 && text[j] === '\\') {
    count++
    j--
  }
  return count
}

function firstUnescaped(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch && precedingBackslashes(text, i) % 2 === 0) return i
  }
  return -1
}

function escapeRuleContent(content: string): string {
  return notBuilt('src/utils/permissions/permissionRuleParser.ts:27')
}

function unescapeRuleContent(content: string): string {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  return notBuilt('src/utils/permissions/permissionRuleParser.ts:35')
}

export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
  if (ruleValue.ruleContent === undefined || ruleValue.ruleContent === '') {
    return ruleValue.toolName
  }
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

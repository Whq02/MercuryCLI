import type { PermissionRuleValue } from '../../types/permissions.js'

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

function lastUnescaped(text: string, ch: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ch && precedingBackslashes(text, i) % 2 === 0) return i
  }
  return -1
}

function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function unescapeRuleContent(content: string): string {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  const trimmed = ruleString.trim()
  const openIdx = firstUnescaped(trimmed, '(')
  const closeIdx = lastUnescaped(trimmed, ')')
  if (
    openIdx === -1 ||
    closeIdx === -1 ||
    closeIdx <= openIdx ||
    closeIdx !== trimmed.length - 1
  ) {
    return { toolName: trimmed }
  }
  const toolName = trimmed.slice(0, openIdx).trim()
  if (toolName.length === 0) {
    return { toolName: trimmed }
  }
  const content = unescapeRuleContent(trimmed.slice(openIdx + 1, closeIdx))
  if (content === '' || content === '*') {
    return { toolName }
  }
  return { toolName, ruleContent: content }
}

export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
  if (ruleValue.ruleContent === undefined || ruleValue.ruleContent === '') {
    return ruleValue.toolName
  }
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

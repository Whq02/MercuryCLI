/**
 * The `Tool(content)` rule-string grammar: parse, serialize, escape/unescape,
 * and legacy tool-name aliasing. The grammar is a stable external contract —
 * it appears in settings files, on the CLI, in SDK messages, and in the
 * permission dialog.
 */
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import type { PermissionRuleValue } from '../../types/permissions.js'

/**
 * Retired tool names mapped to their current canonical names. Contract data —
 * persisted rule strings and hook names in user settings depend on it.
 */
const LEGACY_TOOL_NAME_MAP: Record<string, string> = {
  Task: AGENT_TOOL_NAME,
  KillShell: TASK_STOP_TOOL_NAME,
  AgentOutputTool: TASK_OUTPUT_TOOL_NAME,
  BashOutputTool: TASK_OUTPUT_TOOL_NAME,
}

/** Normalise a retired tool name to its canonical spelling (or pass through). */
export function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_MAP[name] ?? name
}

/** Given a canonical name, list its legacy spellings. */
export function getLegacyToolNames(canonicalName: string): string[] {
  return Object.entries(LEGACY_TOOL_NAME_MAP)
    .filter(([, canonical]) => canonical === canonicalName)
    .map(([legacy]) => legacy)
}

/** Count backslashes immediately before index `i`. */
function precedingBackslashes(text: string, i: number): number {
  let count = 0
  let j = i - 1
  while (j >= 0 && text[j] === '\\') {
    count++
    j--
  }
  return count
}

/** The first unescaped occurrence of a character (even backslash run before it). */
function firstUnescaped(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch && precedingBackslashes(text, i) % 2 === 0) return i
  }
  return -1
}

/** The last unescaped occurrence of a character. */
function lastUnescaped(text: string, ch: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ch && precedingBackslashes(text, i) % 2 === 0) return i
  }
  return -1
}

/** Escape content for serialization: backslashes first, then parentheses. */
export function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Unescape content: parentheses first, backslashes last. */
export function unescapeRuleContent(content: string): string {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

/**
 * Parse a rule string into a tool name (legacy-normalised) and optional
 * content. Malformed shapes collapse to a tool-wide rule.
 */
export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  // Outer whitespace is a human slip (settings-file padding), never grammar:
  // trimmed here — the one parse door — so a padded spelling matches the tool
  // it plainly names on every consumer. Content inside parens is untouched.
  const trimmed = ruleString.trim()
  const open = firstUnescaped(trimmed, '(')
  if (open === -1) {
    return { toolName: normalizeLegacyToolName(trimmed) }
  }
  const close = lastUnescaped(trimmed, ')')
  // Malformed: no closing paren, closer at/before opener, or closer not final.
  if (close === -1 || close <= open || close !== trimmed.length - 1) {
    return { toolName: normalizeLegacyToolName(trimmed) }
  }
  const toolName = trimmed.slice(0, open).trim()
  if (toolName === '') {
    // An empty tool name is malformed → whole string is the tool name.
    return { toolName: normalizeLegacyToolName(trimmed) }
  }
  const rawContent = trimmed.slice(open + 1, close)
  const content = unescapeRuleContent(rawContent)
  // Empty or `*` content collapses to a tool-wide rule.
  if (content === '' || content === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }
  return { toolName: normalizeLegacyToolName(toolName), ruleContent: content }
}

/** Serialize a rule value: bare tool name when there is no content. */
export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
  if (ruleValue.ruleContent === undefined || ruleValue.ruleContent === '') {
    return ruleValue.toolName
  }
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

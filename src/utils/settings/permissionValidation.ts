import { z } from 'zod/v4'

import { lazySchema } from '../lazySchema.js'
import { getCustomValidation, isBashPrefixTool, isFilePatternTool } from './toolValidationConfig.js'


export type PermissionRuleValidation = {
  valid: boolean
  error?: string
  suggestion?: string
  examples?: string[]
}

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

function fileToolExamples(toolName: string): string[] {
  return [`${toolName}(*.ts)`, `${toolName}(src/**)`, `${toolName}(tests/**/*.test.ts)`]
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
  if (rule.trim() === '') {
    return { valid: false, error: 'A permission rule may not be empty' }
  }

  const openCount = countUnescaped(rule, '(')
  const closeCount = countUnescaped(rule, ')')
  if (openCount !== closeCount) {
    return {
      valid: false,
      error: `Rule "${rule}" has mismatched parentheses`,
      suggestion: 'Make sure every opening parenthesis has a matching closing one',
    }
  }

  const firstOpen = findUnescaped(rule, '(')
  const toolName = (firstOpen === -1 ? rule : rule.slice(0, firstOpen)).trim()

  if (firstOpen !== -1 && findUnescaped(rule, ')', firstOpen + 1) === firstOpen + 1) {
    if (toolName === '') {
      return {
        valid: false,
        error: 'The parentheses are empty and no tool was named',
        suggestion: 'Name a tool, e.g. Bash or Read',
      }
    }
    return { valid: true }
  }

  let content: string | undefined
  if (firstOpen !== -1) {
    const lastClose = rule.lastIndexOf(')')
    content = rule.slice(firstOpen + 1, lastClose)
    if (content === '*') content = undefined
  }

  if (toolName.startsWith('mcp__')) {
    if (content !== undefined || firstOpen !== -1) {
      const rest = toolName.slice('mcp__'.length)
      const separatorIndex = rest.indexOf('__')
      const server = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex)
      const tool = separatorIndex === -1 ? undefined : rest.slice(separatorIndex + 2)
      const examples = [`mcp__${server || 'server'}`, `mcp__${server || 'server'}__*`]
      if (tool !== undefined && tool !== '*' && tool !== '') {
        examples.push(`mcp__${server}__${tool}`)
      }
      return {
        valid: false,
        error: 'MCP rules do not support patterns in parentheses',
        suggestion: `Use the bare form (mcp__server) or the wildcard form (mcp__server__*)`,
        examples,
      }
    }
    const rest = toolName.slice('mcp__'.length)
    const separatorIndex = rest.indexOf('__')
    const server = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex)
    const tool = separatorIndex === -1 ? undefined : rest.slice(separatorIndex + 2)
    if (server === '') {
      return { valid: false, error: 'MCP rule is missing a server name' }
    }
    if (tool !== undefined && tool === '') {
      return { valid: false, error: 'MCP rule is missing a tool name after the separator' }
    }
    return { valid: true }
  }

  if (toolName === '') {
    return { valid: false, error: 'The tool name may not be empty' }
  }

  const firstChar = toolName[0] as string
  if (firstChar !== firstChar.toUpperCase()) {
    const capitalized = firstChar.toUpperCase() + toolName.slice(1)
    return {
      valid: false,
      error: `Tool names are capitalized: "${toolName}"`,
      suggestion: `Did you mean ${content !== undefined ? `${capitalized}(${content})` : capitalized}?`,
    }
  }

  if (content !== undefined) {
    const customValidation = getCustomValidation(toolName)
    if (customValidation) {
      const result = customValidation(content)
      if (!result.valid) return result
    }

    if (isBashPrefixTool(toolName)) {
      if (content === ':*') {
        return {
          valid: false,
          error: 'A command prefix is required before :*',
          suggestion: 'Supply the command to prefix-match',
          examples: ['Bash(npm:*)', 'Bash(git:*)'],
        }
      }
      const prefixIndex = content.indexOf(':*')
      if (prefixIndex !== -1 && prefixIndex !== content.length - 2) {
        return {
          valid: false,
          error: 'The :* form is only legal at the end of a Bash rule',
          suggestion: 'Move :* to the end for prefix matching, or use * for wildcard matching',
          examples: ['Bash(npm run:*)', 'Bash(npm run *)'],
        }
      }
      return { valid: true }
    }

    if (isFilePatternTool(toolName)) {
      if (content.includes(':*')) {
        return {
          valid: false,
          error: 'The :* syntax belongs to Bash prefix rules only',
          suggestion: 'Use glob patterns for file rules',
          examples: fileToolExamples(toolName),
        }
      }
      if (content.includes('*') && hasSuspiciousWildcardPlacement(content)) {
        return {
          valid: false,
          error: `The wildcard placement in "${content}" may be wrong`,
          suggestion: 'Wildcards belong at path boundaries',
          examples: [`${toolName}(*.ts)`, `${toolName}(src/*)`, `${toolName}(src/**)`],
        }
      }
    }
  }

  return { valid: true }
}

export const PermissionRuleSchema = lazySchema(() =>
  z.string().superRefine((rule, ctx) => {
    const result = validatePermissionRule(rule)
    if (result.valid) return
    let message = result.error ?? 'Invalid permission rule'
    if (result.suggestion) message += `. ${result.suggestion}`
    if (result.examples && result.examples.length > 0) {
      message += `. Examples: ${result.examples.join(', ')}`
    }
    ctx.addIssue({ code: 'custom', message, received: rule } as never)
  }),
)

import { z } from 'zod/v4'

import { lazySchema } from '../lazySchema.js'
import { expandRuleBraces, RULE_BRACE_BOUND, ruleBracesPastBound, starredBraces } from '../permissions/ruleBraces.js'
import { getCustomValidation, isBashPrefixTool, isFilePatternTool } from './toolValidationConfig.js'

type PermissionRuleValidation = {
  valid: boolean
  error?: string
  suggestion?: string
  advisory?: boolean
  readAs?: string
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

  const openIndex = findUnescaped(rule, '(')
  const hasParens = openIndex !== -1
  const toolName = (hasParens ? rule.slice(0, openIndex) : rule).trim()

  if (hasParens && rule[openIndex + 1] === ')') {
    if (toolName === '') {
      return {
        valid: false,
        error: 'The parentheses are empty and no tool was named',
        suggestion: 'Name a tool, e.g. Bash or Read',
      }
    }
    return { valid: true }
  }

  let ruleContent: string | undefined
  if (hasParens) {
    const closeIndex = rule.lastIndexOf(')')
    if (closeIndex > openIndex) {
      const inner = rule.slice(openIndex + 1, closeIndex)
      ruleContent = inner === '*' ? undefined : inner
    }
  }

  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5)
    const sepIndex = rest.indexOf('__')
    const server = sepIndex === -1 ? rest : rest.slice(0, sepIndex)
    const mcpTool = sepIndex === -1 ? undefined : rest.slice(sepIndex + 2)

    if (hasParens) {
      const exampleServer = server || 'server'
      const examples = [`mcp__${exampleServer}`, `mcp__${exampleServer}__*`]
      if (mcpTool && mcpTool !== '*') {
        examples.push(`mcp__${exampleServer}__${mcpTool}`)
      }
      return {
        valid: false,
        error: 'MCP rules do not support patterns in parentheses',
        suggestion: 'Use the bare form (mcp__server) or the wildcard form (mcp__server__*)',
        examples,
      }
    }

    if (server === '') {
      return { valid: false, error: 'MCP rule is missing a server name' }
    }
    if (mcpTool !== undefined && mcpTool === '') {
      return { valid: false, error: 'MCP rule is missing a tool name after the separator' }
    }
    return { valid: true }
  }

  if (toolName === '') {
    return { valid: false, error: 'The tool name may not be empty' }
  }

  if (/^[a-z]/.test(toolName)) {
    const capitalized = toolName[0]!.toUpperCase() + toolName.slice(1)
    const suggested = ruleContent !== undefined ? `${capitalized}(${ruleContent})` : capitalized
    return {
      valid: false,
      error: `Tool names are capitalized: "${toolName}"`,
      suggestion: `Did you mean ${suggested}?`,
    }
  }

  if (ruleContent !== undefined) {
    const customValidator = getCustomValidation(toolName)
    if (customValidator !== undefined) {
      const customResult = customValidator(ruleContent)
      if (!customResult.valid) return customResult
    }

    if (isBashPrefixTool(toolName)) {
      if (/:\*$/.test(ruleContent)) {
        const prefix = ruleContent.slice(0, -2).trim()
        const suggestedPrefix = prefix || 'npm run'
        return {
          valid: false,
          error: 'A command rule that ends in a colon before the star is a spelling Mercury does not read',
          suggestion: `Write a space before the star: ${toolName}(${suggestedPrefix} *)`,
        }
      }
      return { valid: true }
    }

    if (isFilePatternTool(toolName)) {
      if (ruleBracesPastBound(ruleContent)) {
        return {
          valid: false,
          advisory: true,
          readAs: starredBraces(ruleContent),
          error: `The braces in "${ruleContent}" expand to more than ${RULE_BRACE_BOUND} patterns`,
          suggestion: 'Write fewer alternatives, or more than one rule',
        }
      }
      if (expandRuleBraces(ruleContent).some(pattern => hasSuspiciousWildcardPlacement(pattern))) {
        return {
          valid: false,
          advisory: true,
          error: `The wildcard placement in "${ruleContent}" may be wrong`,
          suggestion: 'Wildcards belong at path boundaries',
          examples: [`${toolName}(*.ts)`, `${toolName}(src/*)`, `${toolName}(src/**)`],
        }
      }
    }
  }

  return { valid: true }
}

export const PermissionRuleSchema: () => z.ZodString = lazySchema(() =>
  z.string().superRefine((rule, ctx) => {
    const result = validatePermissionRule(rule)
    if (!result.valid) {
      let message = result.error ?? 'Invalid permission rule'
      if (result.suggestion) {
        message += `. ${result.suggestion}`
      }
      if (result.examples && result.examples.length > 0) {
        message += `. Examples: ${result.examples.join(', ')}`
      }
      ctx.addIssue({
        code: 'custom',
        message,
        received: rule,
      })
    }
  }),
)

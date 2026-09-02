import { z } from 'zod/v4'

import type { ConfigScope } from '../../services/mcp/types.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import { getValidationTip } from './validationTips.js'


export type FieldPath = string

export type ValidationError = {
  file?: string
  path: FieldPath
  message: string
  expected?: string
  invalidValue?: unknown
  suggestion?: string
  docLink?: string
  severity?: 'error' | 'warning'
  mcpErrorMetadata?: {
    scope: ConfigScope
    serverName?: string
    severity?: 'fatal' | 'warning'
  }
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

type IssueLike = {
  code: string
  path: Array<PropertyKey>
  message: string
  expected?: string
  values?: unknown[]
  keys?: string[]
  minimum?: number | bigint
  received?: unknown
}

function receivedTypeName(issue: IssueLike): string {
  const fromMessage = issue.message.match(/received (\w+)/)
  if (fromMessage) return fromMessage[1] as string
  const value = issue.received
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function formatZodError(error: z.ZodError, filePath: string): ValidationError[] {
  const records: ValidationError[] = []
  for (const rawIssue of error.issues) {
    const issue = rawIssue as unknown as IssueLike
    const path = issue.path.join('.')

    const tipContext = {
      path,
      code: issue.code,
      ...(issue.code === 'invalid_value' && issue.values
        ? { enumValues: issue.values.map(String), expected: issue.values.map(String).join('|') }
        : {}),
      ...(issue.code === 'invalid_type'
        ? { expected: issue.expected, received: receivedTypeName(issue) }
        : {}),
      ...(issue.code === 'too_small' ? { expected: String(issue.minimum ?? '') } : {}),
      ...(issue.code === 'custom' && issue.received !== undefined
        ? { received: issue.received as never, value: issue.received }
        : {}),
      message: issue.message,
    }
    const tip = getValidationTip(tipContext as never)

    let message: string
    let expected: string | undefined
    let invalidValue: unknown

    switch (issue.code) {
      case 'invalid_value': {
        const quoted = (issue.values ?? []).map(value => `"${String(value)}"`).join(', ')
        message = `Invalid value; accepted values are: ${quoted}`
        expected = quoted
        break
      }
      case 'invalid_type': {
        const received = receivedTypeName(issue)
        if (issue.expected === 'object' && path === '' && received === 'null') {
          message = 'The settings file contains malformed JSON (or is empty)'
        } else {
          message = `Expected ${issue.expected ?? 'a different type'}, received ${received}`
        }
        invalidValue = received
        break
      }
      case 'unrecognized_keys': {
        const keys = issue.keys ?? []
        message = `Unrecognized ${keys.length === 1 ? 'field' : 'fields'}: ${keys.join(', ')}`
        break
      }
      case 'too_small': {
        message = `Value must be at least ${issue.minimum ?? 0}`
        expected = String(issue.minimum ?? 0)
        break
      }
      case 'custom': {
        message = issue.message
        if (issue.received !== undefined) invalidValue = issue.received
        break
      }
      default: {
        message = issue.message
      }
    }

    records.push({
      file: filePath,
      path,
      message,
      ...(expected !== undefined ? { expected } : {}),
      ...(invalidValue !== undefined ? { invalidValue } : {}),
      ...(tip?.suggestion !== undefined ? { suggestion: tip.suggestion } : {}),
      ...(tip?.docLink !== undefined ? { docLink: tip.docLink } : {}),
    })
  }
  return records
}

export function validateSettingsFileContent(
  content: string,
): { isValid: true } | { isValid: false; error: string; fullSchema: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (parseError) {
    return {
      isValid: false,
      error: `The settings file is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      fullSchema: generateSettingsJSONSchema(),
    }
  }
  const strictSchema = z.strictObject(SettingsSchema().shape)
  const result = strictSchema.safeParse(parsed)
  if (result.success) return { isValid: true }
  const lines = formatZodError(result.error, '').map(record => `  - ${record.path || '(root)'}: ${record.message}`)
  return {
    isValid: false,
    error: `Settings validation failed:\n${lines.join('\n')}`,
    fullSchema: generateSettingsJSONSchema(),
  }
}

export function filterInvalidPermissionRules(data: unknown, filePath: string): ValidationError[] {
  const warnings: ValidationError[] = []
  if (typeof data !== 'object' || data === null) return warnings
  const permissions = (data as { permissions?: unknown }).permissions
  if (typeof permissions !== 'object' || permissions === null) return warnings
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const rules = (permissions as Record<string, unknown>)[key]
    if (!Array.isArray(rules)) continue
    const kept: unknown[] = []
    for (const rule of rules) {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message: `Removed a non-string value from permissions.${key}`,
          invalidValue: rule,
          severity: 'warning',
        })
        continue
      }
      const result = validatePermissionRule(rule)
      if (!result.valid) {
        let message = `Skipped invalid permission rule "${rule}"`
        if (result.error) message += `: ${result.error}`
        if (result.suggestion) message += `. ${result.suggestion}`
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message,
          invalidValue: rule,
          severity: 'warning',
        })
        continue
      }
      kept.push(rule)
    }
    ;(permissions as Record<string, unknown>)[key] = kept
  }
  return warnings
}

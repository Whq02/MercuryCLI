import { z } from 'zod/v4'

import type { ConfigScope } from '../../services/mcp/types.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import { getValidationTip } from './validationTips.js'


type FieldPath = string

export type ValidationError = {
  file?: string
  path: FieldPath
  message: string
  expected?: string
  invalidValue?: unknown
  suggestion?: string
  docLink?: string
  severity?: 'error' | 'warning' | 'held'
  unknownKeys?: string[]
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
  errors?: IssueLike[][]
}

function unionAlternatives(issue: IssueLike): { values: unknown[]; shapes: string[] } | null {
  if (issue.code !== 'invalid_union' || !Array.isArray(issue.errors)) return null
  const values: unknown[] = []
  const shapes: string[] = []
  for (const branch of issue.errors) {
    const first = branch[0]
    if (first === undefined || first.path.length > 0) continue
    if (first.code === 'invalid_value' && Array.isArray(first.values)) values.push(...first.values)
    else if (first.code === 'invalid_type' && typeof first.expected === 'string') shapes.push(first.expected)
  }
  return values.length === 0 && shapes.length === 0 ? null : { values, shapes }
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

export function formatZodError(error: Pick<z.ZodError, 'issues'>, filePath: string): ValidationError[] {
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
    let unknownKeys: string[] | undefined

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
        unknownKeys = [...keys]
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
      case 'invalid_union': {
        const alternatives = unionAlternatives(issue)
        if (alternatives === null) {
          message = issue.message
          break
        }
        const quoted = alternatives.values.map(value => `"${String(value)}"`).join(', ')
        const shapes = alternatives.shapes.map(shape => `an ${shape}`).join(' or ')
        message = quoted !== '' ? `Invalid value; accepted values are: ${quoted}${shapes !== '' ? `, or ${shapes}` : ''}` : `Invalid value; expected ${shapes}`
        expected = [quoted, shapes].filter(Boolean).join(' | ')
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
      ...(unknownKeys !== undefined ? { unknownKeys } : {}),
      ...(tip?.suggestion !== undefined ? { suggestion: tip.suggestion } : {}),
      ...(tip?.docLink !== undefined ? { docLink: tip.docLink } : {}),
    })
  }
  return records
}

export function settingsFaultLine(error: ValidationError): string {
  const where = [error.file, error.path, error.message].filter(Boolean).join(' · ')
  const effect = settingsFaultEffect(error)
  return `settings: ${where} — ${effect}`
}

function settingsFaultEffect(error: Pick<ValidationError, 'severity'>): string {
  if (error.severity === 'warning') return 'this value is skipped; the rest of the file applies'
  if (error.severity === 'held') return 'the file cannot be read; the last good settings stay in force'
  return 'the file is skipped'
}

const EDIT_STRICT_GROUPS = [
  'credentials', 'files', 'records', 'briefs', 'memory', 'turns', 'environment', 'credit', 'engine', 'kit',
  'events', 'voice', 'activity', 'view', 'context', 'input', 'shell', 'routing', 'channels', 'workspace', 'local',
] as const

function editTimeSettingsSchema(): z.ZodObject {
  const shape: Record<string, z.ZodType> = { ...SettingsSchema().shape }
  for (const group of EDIT_STRICT_GROUPS) {
    const declared = shape[group]
    const inner = declared instanceof z.ZodOptional ? declared.unwrap() : declared
    if (inner instanceof z.ZodObject) shape[group] = z.strictObject(inner.shape).optional()
  }
  return z.strictObject(shape)
}

export function unknownKeyWarnings(data: unknown, filePath: string): ValidationError[] {
  const strict = editTimeSettingsSchema().safeParse(data)
  if (strict.success) return []
  const issues = strict.error.issues.filter(issue => issue.code === 'unrecognized_keys')
  if (issues.length === 0) return []
  return formatZodError({ issues }, filePath).map(record => ({ ...record, severity: 'warning' as const }))
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
  const result = editTimeSettingsSchema().safeParse(parsed)
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
  const guardrails = (data as { guardrails?: unknown }).guardrails
  if (typeof guardrails !== 'object' || guardrails === null) return warnings
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const rules = (guardrails as Record<string, unknown>)[key]
    if (!Array.isArray(rules)) continue
    const kept: unknown[] = []
    for (const rule of rules) {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `guardrails.${key}`,
          message: `Removed a non-string value from guardrails.${key}`,
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
          path: `guardrails.${key}`,
          message,
          invalidValue: rule,
          severity: 'warning',
        })
        continue
      }
      kept.push(rule)
    }
    ;(guardrails as Record<string, unknown>)[key] = kept
  }
  return warnings
}

import { z } from 'zod/v4'

import type { ConfigScope } from '../mcp/types.js'
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
  kept?: true
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
  path: PropertyKey[]
  message: string
  expected?: string
  values?: unknown[]
  keys?: string[]
  minimum?: number | bigint
  maximum?: number | bigint
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
  const said = /received (\w+)/.exec(issue.message)
  if (said) return said[1]
  if (issue.received === null) return 'null'
  if (issue.received === undefined) return 'undefined'
  return Array.isArray(issue.received) ? 'array' : typeof issue.received
}

function inQuotes(values: readonly unknown[]): string {
  return values.map(value => `"${String(value)}"`).join(', ')
}

type IssueWording = Pick<ValidationError, 'message' | 'expected' | 'invalidValue' | 'unknownKeys'>

function wordingOf(issue: IssueLike, path: string): IssueWording {
  switch (issue.code) {
    case 'invalid_value': {
      const list = inQuotes(issue.values ?? [])
      return { message: `Invalid value; accepted values are: ${list}`, expected: list }
    }
    case 'invalid_type': {
      const received = receivedTypeName(issue)
      if (issue.expected === 'object' && path === '' && received === 'null') {
        return { message: 'The settings file contains malformed JSON (or is empty)', invalidValue: received }
      }
      return { message: `Expected ${issue.expected ?? 'a different type'}, received ${received}`, invalidValue: received }
    }
    case 'unrecognized_keys': {
      const keys = issue.keys ?? []
      const message = keys.length === 1 ? `Unrecognized field: ${keys[0]}` : `Unrecognized fields: ${keys.join(', ')}`
      return { message, unknownKeys: [...keys] }
    }
    case 'too_small': {
      const minimum = String(issue.minimum ?? 0)
      return { message: `Value must be at least ${minimum}`, expected: minimum }
    }
    case 'too_big': {
      if (!path.startsWith('swarm.')) return { message: issue.message }
      const maximum = String(issue.maximum ?? 0)
      return { message: `Value must be at most ${maximum}`, expected: maximum }
    }
    case 'custom':
      return issue.received === undefined ? { message: issue.message } : { message: issue.message, invalidValue: issue.received }
    case 'invalid_union': {
      const alternatives = unionAlternatives(issue)
      if (alternatives === null) return { message: issue.message }
      const values = inQuotes(alternatives.values)
      const shapes = alternatives.shapes.map(shape => `an ${shape}`).join(' or ')
      const message =
        values === ''
          ? `Invalid value; expected ${shapes}`
          : `Invalid value; accepted values are: ${values}${shapes === '' ? '' : `, or ${shapes}`}`
      return { message, expected: [values, shapes].filter(part => part !== '').join(' | ') }
    }
    default:
      return { message: issue.message }
  }
}

function tipFor(issue: IssueLike, path: string): ReturnType<typeof getValidationTip> {
  const context = { path, code: issue.code, message: issue.message }
  if (issue.code === 'invalid_value' && issue.values) {
    const enumValues = issue.values.map(String)
    return getValidationTip({ ...context, enumValues, expected: enumValues.join('|') })
  }
  if (issue.code === 'invalid_type') {
    return getValidationTip({ ...context, expected: issue.expected, received: receivedTypeName(issue) })
  }
  if (issue.code === 'too_small') {
    return getValidationTip({ ...context, expected: issue.minimum === undefined ? '' : String(issue.minimum) })
  }
  if (issue.code === 'custom' && issue.received !== undefined) {
    return getValidationTip({ ...context, received: issue.received, value: issue.received })
  }
  return getValidationTip(context)
}

export function formatZodError(error: Pick<z.ZodError, 'issues'>, filePath: string): ValidationError[] {
  return error.issues.map((issue: IssueLike): ValidationError => {
    const path = issue.path.map(String).join('.')
    const wording = wordingOf(issue, path)
    const tip = tipFor(issue, path)
    return {
      file: filePath,
      path,
      message: wording.message,
      ...(wording.expected !== undefined ? { expected: wording.expected } : {}),
      ...(wording.invalidValue !== undefined ? { invalidValue: wording.invalidValue } : {}),
      ...(wording.unknownKeys !== undefined ? { unknownKeys: wording.unknownKeys } : {}),
      ...(tip?.suggestion !== undefined ? { suggestion: tip.suggestion } : {}),
      ...(tip?.docLink !== undefined ? { docLink: tip.docLink } : {}),
    }
  })
}

export function settingsFaultLine(error: ValidationError): string {
  const where = [error.file, error.path, error.message].filter(Boolean).join(' · ')
  const effect = settingsFaultEffect(error)
  return `settings: ${where} — ${effect}`
}

function settingsFaultEffect(error: Pick<ValidationError, 'severity' | 'kept'>): string {
  if (error.kept) return 'the rule stays in force; the rest of the file applies'
  if (error.severity === 'error') return 'this rule is not in force until it is corrected; the rest of the file applies'
  if (error.severity === 'warning') return 'this value is skipped; the rest of the file applies'
  if (error.severity === 'held') return 'the file cannot be read; the last good settings stay in force'
  return 'the file is skipped'
}

const EDIT_STRICT_GROUPS = [
  'credentials', 'files', 'records', 'briefs', 'memory', 'turns', 'environment', 'credit', 'engine', 'kit',
  'events', 'voice', 'activity', 'view', 'context', 'input', 'shell', 'routing', 'workspace', 'local',
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
  } catch (failure) {
    const words = failure instanceof Error ? failure.message : String(failure)
    return { isValid: false, error: `The settings file is not valid JSON: ${words}`, fullSchema: generateSettingsJSONSchema() }
  }
  const checked = editTimeSettingsSchema().safeParse(parsed)
  if (checked.success) return { isValid: true }
  const lines = formatZodError(checked.error, '').map(record => `  - ${record.path || '(root)'}: ${record.message}`)
  return {
    isValid: false,
    error: `Settings validation failed:\n${lines.join('\n')}`,
    fullSchema: generateSettingsJSONSchema(),
  }
}

function ruleRemark(rule: string, verdict: ReturnType<typeof validatePermissionRule>, stays: boolean): string {
  const opening = `${stays ? 'Permission rule' : 'Skipped invalid permission rule'} "${rule}"${verdict.error ? `: ${verdict.error}` : ''}`
  if (stays && verdict.readAs !== undefined) return `${opening}: read as ${verdict.readAs}`
  return verdict.suggestion ? `${opening}. ${verdict.suggestion}` : opening
}

export function filterInvalidPermissionRules(data: unknown, filePath: string): ValidationError[] {
  if (typeof data !== 'object' || data === null) return []
  const guardrails = (data as { guardrails?: unknown }).guardrails
  if (typeof guardrails !== 'object' || guardrails === null) return []
  const lists = guardrails as Record<string, unknown>
  const found: ValidationError[] = []
  for (const name of ['allow', 'deny', 'ask'] as const) {
    const rules = lists[name]
    if (!Array.isArray(rules)) continue
    const path = `guardrails.${name}`
    lists[name] = rules.filter((rule: unknown) => {
      if (typeof rule !== 'string') {
        found.push({ file: filePath, path, message: `Removed a non-string value from ${path}`, invalidValue: rule, severity: 'warning' })
        return false
      }
      const verdict = validatePermissionRule(rule)
      if (verdict.valid) return true
      const stays = name !== 'allow' && verdict.advisory === true
      found.push({
        file: filePath,
        path,
        message: ruleRemark(rule, verdict, stays),
        invalidValue: rule,
        severity: stays || name === 'allow' ? 'warning' : 'error',
        ...(stays ? { kept: true as const } : {}),
      })
      return stays
    })
  }
  return found
}

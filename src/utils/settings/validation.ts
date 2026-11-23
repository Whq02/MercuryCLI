import { z } from 'zod/v4'

import type { ConfigScope } from '../mcp/types.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import { getValidationTip } from './validationTips.js'
import { notBuilt } from '../../pi/holes.js'


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

export function formatZodError(error: Pick<z.ZodError, 'issues'>, filePath: string): ValidationError[] {
  return notBuilt('src/utils/settings/validation.ts:72')
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
  return notBuilt('src/utils/settings/validation.ts:206')
}

export function filterInvalidPermissionRules(data: unknown, filePath: string): ValidationError[] {
  return notBuilt('src/utils/settings/validation.ts:229')
}

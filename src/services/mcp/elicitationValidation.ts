import type { PrimitiveSchemaDefinition } from '../../utils/mcp/sdk.js'

import { looksLikeISO8601, parseNaturalLanguageDateTime } from './dateTimeParser.js'
import { passedOver } from '../../utils/passedOver.js'


type SchemaLike = {
  type?: string
  format?: string
  enum?: unknown[]
  enumNames?: unknown[]
  oneOf?: Array<{ const?: unknown; title?: string }>
  anyOf?: Array<{ const?: unknown; title?: string }>
  items?: { enum?: unknown[]; anyOf?: Array<{ const?: unknown; title?: string }> } | null
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}

export type MultiSelectEnumSchema = PrimitiveSchemaDefinition & {
  type: 'array'
  minItems?: number
  maxItems?: number
  items?: { enum?: unknown[]; anyOf?: Array<{ const?: unknown; title?: string }> } | null
}

type ValidationResult =
  | { isValid: true; value: string | number | boolean; error?: undefined }
  | { isValid: false; value?: undefined; error: string }

export function isEnumSchema(schema: PrimitiveSchemaDefinition): boolean {
  const s: SchemaLike = schema
  return s.type === 'string' && (s.enum !== undefined || s.oneOf !== undefined)
}

export function isMultiSelectEnumSchema(
  schema: PrimitiveSchemaDefinition,
): schema is MultiSelectEnumSchema {
  const s: SchemaLike = schema
  return (
    s.type === 'array' &&
    s.items !== undefined &&
    s.items !== null &&
    typeof s.items === 'object' &&
    (s.items.enum !== undefined || s.items.anyOf !== undefined)
  )
}

export function isDateTimeSchema(schema: PrimitiveSchemaDefinition): boolean {
  const s = schema as SchemaLike
  return s.type === 'string' && (s.format === 'date' || s.format === 'date-time')
}

function membersOf(members: Array<{ const?: unknown; title?: string }> | undefined): string[] | null {
  if (!members) return null
  return members.map(member => String(member.const ?? ''))
}

export function getEnumValues(schema: PrimitiveSchemaDefinition): string[] {
  const s = schema as SchemaLike
  return membersOf(s.oneOf) ?? (s.enum ? s.enum.map(String) : [])
}

export function getEnumLabels(schema: PrimitiveSchemaDefinition): string[] {
  const s = schema as SchemaLike
  if (s.oneOf) return s.oneOf.map((member, index) => member.title ?? String(member.const ?? getEnumValues(schema)[index] ?? ''))
  if (s.enumNames) return s.enumNames.map(String)
  return getEnumValues(schema)
}

export function getMultiSelectValues(schema: PrimitiveSchemaDefinition): string[] {
  const items = (schema as SchemaLike).items
  if (!items) return []
  return membersOf(items.anyOf) ?? (items.enum ? items.enum.map(String) : [])
}

export function getMultiSelectLabels(schema: PrimitiveSchemaDefinition): string[] {
  const items = (schema as SchemaLike).items
  if (!items) return []
  if (items.anyOf) return items.anyOf.map((member, index) => member.title ?? String(member.const ?? getMultiSelectValues(schema)[index] ?? ''))
  return getMultiSelectValues(schema)
}

function labelForValue(values: string[], labels: string[], value: string): string {
  const index = values.indexOf(value)
  if (index === -1) return value
  return labels[index] ?? value
}

export function getEnumLabel(schema: PrimitiveSchemaDefinition, value: string): string {
  return labelForValue(getEnumValues(schema), getEnumLabels(schema), value)
}

export function getMultiSelectLabel(schema: PrimitiveSchemaDefinition, value: string): string {
  return labelForValue(getMultiSelectValues(schema), getMultiSelectLabels(schema), value)
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

function isValidUri(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

function formatBound(value: number, type: string): string {
  if (type !== 'integer' && Number.isInteger(value)) return `${value}.0`
  return String(value)
}

function numberRangeMessage(s: SchemaLike): string {
  const typeWord = s.type === 'integer' ? 'an integer' : 'a number'
  if (s.minimum !== undefined && s.maximum !== undefined) {
    return `Must be ${typeWord} between ${formatBound(s.minimum, s.type ?? '')} and ${formatBound(s.maximum, s.type ?? '')}`
  }
  if (s.minimum !== undefined) {
    return `Must be ${typeWord} of at least ${formatBound(s.minimum, s.type ?? '')}`
  }
  if (s.maximum !== undefined) {
    return `Must be ${typeWord} of at most ${formatBound(s.maximum, s.type ?? '')}`
  }
  return `Must be ${typeWord}`
}

export function validateElicitationInput(stringValue: string, schema: PrimitiveSchemaDefinition): ValidationResult {
  const s = schema as SchemaLike
  const issues: string[] = []

  if (isEnumSchema(schema)) {
    const values = getEnumValues(schema)
    if (!values.includes(stringValue)) {
      issues.push(values.length > 0 ? `Must be one of: ${values.join(', ')}` : 'No values are accepted')
    }
    return issues.length === 0
      ? { isValid: true, value: stringValue }
      : { isValid: false, error: issues.join('; ') }
  }

  if (s.type === 'string') {
    if (s.minLength !== undefined && stringValue.length < s.minLength) {
      issues.push(`Must be at least ${s.minLength} character${s.minLength === 1 ? '' : 's'}`)
    }
    if (s.maxLength !== undefined && stringValue.length > s.maxLength) {
      issues.push(`Must be at most ${s.maxLength} character${s.maxLength === 1 ? '' : 's'}`)
    }
    if (s.format === 'email' && !EMAIL_PATTERN.test(stringValue)) {
      issues.push('Must be a valid email address (e.g. user@example.com)')
    } else if (s.format === 'uri' && !isValidUri(stringValue)) {
      issues.push('Must be a valid URI (e.g. https://example.com)')
    } else if (s.format === 'date' && !DATE_PATTERN.test(stringValue)) {
      issues.push('Must be a valid date (e.g. 2024-03-15; natural language like "today" or "next Monday" is accepted)')
    } else if (s.format === 'date-time' && !DATE_TIME_PATTERN.test(stringValue)) {
      issues.push('Must be a valid date-time (e.g. 2024-03-15T14:30:00Z; natural language like "tomorrow at 3pm" is accepted)')
    }
    return issues.length === 0
      ? { isValid: true, value: stringValue }
      : { isValid: false, error: issues.join('; ') }
  }

  if (s.type === 'number' || s.type === 'integer') {
    const rangeMessage = numberRangeMessage(s)
    const parsed = Number(stringValue)
    if (stringValue.trim() === '' || Number.isNaN(parsed)) {
      return { isValid: false, error: rangeMessage }
    }
    if (s.type === 'integer' && !Number.isInteger(parsed)) {
      return { isValid: false, error: rangeMessage }
    }
    if (s.minimum !== undefined && parsed < s.minimum) {
      return { isValid: false, error: rangeMessage }
    }
    if (s.maximum !== undefined && parsed > s.maximum) {
      return { isValid: false, error: rangeMessage }
    }
    return { isValid: true, value: parsed }
  }

  if (s.type === 'boolean') {
    return { isValid: true, value: Boolean(stringValue) }
  }

  throw new Error(`Unsupported elicitation schema: ${JSON.stringify(schema)}`)
}

export async function validateElicitationInputAsync(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const syncResult = validateElicitationInput(stringValue, schema)
  if (syncResult.isValid || !isDateTimeSchema(schema) || looksLikeISO8601(stringValue)) {
    return syncResult
  }
  const s: SchemaLike = schema
  const format = s.format === 'date-time' ? 'date-time' : 'date'
  const parsed = await parseNaturalLanguageDateTime(stringValue, format, signal)
  if (!parsed.success) {
    return syncResult
  }
  const revalidated = validateElicitationInput(parsed.value, schema)
  return revalidated.isValid ? revalidated : syncResult
}

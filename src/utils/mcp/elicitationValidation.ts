import type { PrimitiveSchemaDefinition } from '../../services/mcp/sdk.js'

import { looksLikeISO8601, parseNaturalLanguageDateTime } from './dateTimeParser.js'

/**
 * Validates and describes the MCP "primitive schema" forms used in
 * elicitation prompts.
 */

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

/** The multi-select array schema as consumers narrow it (item bounds included). */
export type MultiSelectEnumSchema = PrimitiveSchemaDefinition & {
  type: 'array'
  minItems?: number
  maxItems?: number
  items?: { enum?: unknown[]; anyOf?: Array<{ const?: unknown; title?: string }> } | null
}

/** One open shape, NOT a discriminated union. */
export type ValidationResult = {
  value?: string | number | boolean
  isValid: boolean
  error?: string
}

export function isEnumSchema(schema: PrimitiveSchemaDefinition): boolean {
  const s = schema as SchemaLike
  return s.type === 'string' && (s.enum !== undefined || s.oneOf !== undefined)
}

export function isMultiSelectEnumSchema(
  schema: PrimitiveSchemaDefinition,
): schema is MultiSelectEnumSchema {
  const s = schema as SchemaLike
  return (
    s.type === 'array' &&
    typeof s.items === 'object' &&
    s.items !== null &&
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
// Date-time validation requires an offset.
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

function isValidUri(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** Whole-number bounds read as floats only for the non-integer type. */
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

/** Validates a string input against a primitive schema. Throws on an unsupported schema type. */
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
    // Unknown formats are not validated.
    return issues.length === 0
      ? { isValid: true, value: stringValue }
      : { isValid: false, error: issues.join('; ') }
  }

  if (s.type === 'number' || s.type === 'integer') {
    // A SINGLE range message serves the type check, the integer check and
    // both bounds, so any violation yields the same sentence.
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
    // Truthiness-based coercion (shipped behaviour): every non-empty
    // string — including "false" — coerces to true; only the empty string
    // is false.
    return { isValid: true, value: Boolean(stringValue) }
  }

  throw new Error(`Unsupported elicitation schema: ${JSON.stringify(schema)}`)
}

/**
 * Sync validation first; a date/date-time failure over non-ISO input gets
 * one natural-language parse attempt, returned ONLY if the parsed value
 * now validates. Every other case returns the original failure unchanged.
 */
export async function validateElicitationInputAsync(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const syncResult = validateElicitationInput(stringValue, schema)
  if (syncResult.isValid) return syncResult
  if (isDateTimeSchema(schema) && !looksLikeISO8601(stringValue)) {
    const format = (schema as SchemaLike).format === 'date' ? 'date' : 'date-time'
    const parsed = await parseNaturalLanguageDateTime(stringValue, format, signal)
    if (parsed.success) {
      const revalidated = validateElicitationInput(parsed.value, schema)
      if (revalidated.isValid) return revalidated
    }
  }
  return syncResult
}

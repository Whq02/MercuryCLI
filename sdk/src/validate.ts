import type { JsonSchema } from './rows.js'

export type Issue = { path: string; message: string }

const typeWord = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

export function validate(schema: JsonSchema, value: unknown, path = '', issues: Issue[] = []): Issue[] {
  const union = schema.oneOf ?? schema.anyOf
  if (union !== undefined) {
    const attempts = union.map(option => validate(option, value, path, []))
    if (attempts.some(attempt => attempt.length === 0)) return issues
    const discriminator = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined
    const nearest = attempts.reduce((best, attempt) => (attempt.length < best.length ? attempt : best))
    issues.push({ path, message: `matches none of ${union.length} shapes${typeof discriminator === 'string' ? ` (type ${JSON.stringify(discriminator)})` : ''}: ${nearest.map(issue => `${issue.path || 'value'}: ${issue.message}`).join('; ')}` })
    return issues
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(type, value))) {
      issues.push({ path, message: `expected ${types.join(' | ')}, found ${typeWord(value)}` })
      return issues
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    issues.push({ path, message: `expected the constant ${JSON.stringify(schema.const)}, found ${JSON.stringify(value)}` })
    return issues
  }
  if (schema.enum !== undefined && !(schema.enum as readonly unknown[]).includes(value)) {
    issues.push({ path, message: `expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}, found ${JSON.stringify(value)}` })
    return issues
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) issues.push({ path, message: 'string too short' })
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) issues.push({ path, message: 'string too long' })
  }
  if (typeof value === 'number') {
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push({ path, message: 'number too small' })
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push({ path, message: 'number too large' })
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `expected at least ${schema.minimum}, found ${value}` })
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `expected at most ${schema.maximum}, found ${value}` })
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => validate(schema.items!, item, `${path}[${index}]`, issues))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined || schema.propertyNames !== undefined)) {
    const record = value as Record<string, unknown>
    const properties = schema.properties ?? {}
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(record)) validate(schema.propertyNames, key, path ? `${path}.${key}` : key, issues)
    }
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) issues.push({ path: path ? `${path}.${key}` : key, message: 'required' })
    }
    for (const [key, inner] of Object.entries(properties)) {
      if (record[key] !== undefined) validate(inner, record[key], path ? `${path}.${key}` : key, issues)
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(record)) {
        if (key in properties) continue
        const keyPath = path ? `${path}.${key}` : key
        if (schema.additionalProperties === false) issues.push({ path: keyPath, message: 'not a declared key' })
        else if (schema.additionalProperties !== true) validate(schema.additionalProperties, record[key], keyPath, issues)
      }
    }
  }
  return issues
}

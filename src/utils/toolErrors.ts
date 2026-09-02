import type { z } from 'zod/v4'

import { describeInvalidArgTypeError, isAbortError, ShellError } from './errors.js'
import { INTERRUPT_MESSAGE } from './messages.js'


const MAX_ERROR_LENGTH = 10_000
const ERROR_HEAD = 5_000
const ERROR_TAIL = 5_000

export function getErrorParts(error: Error): string[] {
  if (error instanceof ShellError) {
    const headline =
      !error.interrupted && Number.isFinite(error.code) && error.code !== 0
        ? `${error.message} (exit code ${error.code})`
        : error.message
    return [headline, error.interrupted ? INTERRUPT_MESSAGE : '', error.stderr, error.stdout]
  }
  const parts: string[] = [describeInvalidArgTypeError(error) ?? error.message]
  const stderr = (error as { stderr?: unknown }).stderr
  if (typeof stderr === 'string') parts.push(stderr)
  const stdout = (error as { stdout?: unknown }).stdout
  if (typeof stdout === 'string') parts.push(stdout)
  return parts
}

export function formatError(error: unknown): string {
  if (isAbortError(error)) {
    const message = error instanceof Error ? error.message : ''
    return message !== '' ? message : INTERRUPT_MESSAGE
  }
  if (!(error instanceof Error)) {
    return String(error)
  }
  const joined = getErrorParts(error)
    .filter(part => Boolean(part))
    .join('\n')
    .trim()
  if (joined === '') {
    return 'The command failed and produced no output.'
  }
  if (joined.length > MAX_ERROR_LENGTH) {
    const removed = joined.length - MAX_ERROR_LENGTH
    return `${joined.slice(0, ERROR_HEAD)}\n\n… [${removed} characters removed] …\n\n${joined.slice(-ERROR_TAIL)}`
  }
  return joined
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let formatted = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted = `${formatted}[${segment}]`
    } else {
      formatted = formatted === '' ? String(segment) : `${formatted}.${String(segment)}`
    }
  }
  return formatted
}

function extractSchemaKeys(schema: unknown, depth: number = 0): string[] | null {
  if (typeof schema !== 'object' || schema === null || depth > 3) return null
  const shape = (schema as { shape?: unknown }).shape
  if (typeof shape === 'object' && shape !== null) {
    const keys = Object.keys(shape)
    return keys.length > 0 ? keys : null
  }
  const unwrap = (schema as { unwrap?: unknown }).unwrap
  if (typeof unwrap === 'function') {
    try {
      return extractSchemaKeys((unwrap as () => unknown).call(schema), depth + 1)
    } catch {
      return null
    }
  }
  return null
}

type IssueLike = z.core.$ZodIssue & {
  expected?: string
  keys?: string[]
  values?: unknown[]
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
  inclusive?: boolean
}

function boundUnit(origin: string | undefined, bound: number | bigint): string {
  const noun = origin === 'string' ? 'character' : origin === 'array' || origin === 'set' ? 'item' : ''
  if (noun === '') return ''
  return ` ${String(bound) === '1' ? noun : `${noun}s`}`
}

function formatIssue(issue: IssueLike, inputSchema: unknown): string[] {
  const name = formatIssuePath(issue.path)
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.message.includes('received undefined')) {
        return [`The required parameter \`${name}\` is missing`]
      }
      const receivedMatch = issue.message.match(/received (\w+)/)
      const received = receivedMatch ? (receivedMatch[1] as string) : 'a different type'
      return [`The parameter \`${name}\` was expected to be of type ${issue.expected ?? 'unknown'} but ${received} was provided`]
    }
    case 'unrecognized_keys': {
      const validKeys = extractSchemaKeys(inputSchema)
      const suffix = validKeys ? `; valid parameters are: ${validKeys.map(key => `"${key}"`).join(', ')}` : ''
      return (issue.keys ?? []).map(key => `The parameter \`${key}\` was not expected${suffix}`)
    }
    case 'invalid_value': {
      const values = issue.values ?? []
      if (values.length === 0) {
        return [`The parameter \`${name}\` has an invalid value`]
      }
      return [`The parameter \`${name}\` must be one of the following values: ${values.map(value => JSON.stringify(value)).join(', ')}`]
    }
    case 'too_small': {
      const bound = issue.minimum ?? 0
      const comparator = issue.inclusive === false ? 'be strictly greater than' : 'have a minimum of'
      return [`The parameter \`${name}\` must ${comparator} ${bound}${boundUnit(issue.origin, bound)}`]
    }
    case 'too_big': {
      const bound = issue.maximum ?? 0
      const comparator = issue.inclusive === false ? 'be strictly less than' : 'have a maximum of'
      return [`The parameter \`${name}\` must ${comparator} ${bound}${boundUnit(issue.origin, bound)}`]
    }
    case 'custom': {
      if (name !== '' && !issue.message.includes(name)) {
        return [`\`${name}\`: ${issue.message}`]
      }
      return [issue.message]
    }
    default: {
      return name !== '' ? [`The parameter \`${name}\` is invalid: ${issue.message}`] : [issue.message]
    }
  }
}

export function formatZodValidationError(
  toolName: string,
  error: z.ZodError,
  inputSchema?: unknown,
): string {
  const lines = error.issues.flatMap(issue => formatIssue(issue as IssueLike, inputSchema))
  if (lines.length === 0) {
    return error.message
  }
  const noun = lines.length === 1 ? 'issue' : 'issues'
  return `The ${toolName} tool failed due to the following ${noun}:\n${lines.join('\n')}`
}

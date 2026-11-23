import type { z } from 'zod/v4'

import { describeInvalidArgTypeError, isAbortError, ShellError } from './errors.js'
import { INTERRUPT_MESSAGE } from './messages/rejectionText.js'
import { OUTPUT_HEAD_SHARE } from './shell/outputLimits.js'
import { passedOver } from './passedOver.js'


const MAX_ERROR_LENGTH = 10_000
const ERROR_HEAD = 5_000
const ERROR_TAIL = 5_000

const SPILL_NOTICE = /\n\n\[(\d+) bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at [^\n]*?\]\n\n/

const windowedErrors = new WeakSet<Error>()

export function windowedError<E extends Error>(error: E): E {
  windowedErrors.add(error)
  return error
}

export function cutAroundSpillNotice(content: string, maxLength: number): string | null {
  const match = SPILL_NOTICE.exec(content)
  if (match === null) return null
  if (content.length <= maxLength) return content
  const before = content.slice(0, match.index)
  const after = content.slice(match.index + match[0].length)
  const headBudget = Math.floor(maxLength * OUTPUT_HEAD_SHARE)
  const tailBudget = maxLength - headBudget
  let head = before.slice(0, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (head.length < before.length && headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = after.slice(Math.max(0, after.length - tailBudget))
  const tailNewline = tail.indexOf('\n')
  if (tail.length < after.length && tailNewline !== -1 && tailNewline < tailBudget / 2) tail = tail.slice(tailNewline + 1)
  const dropped = Buffer.byteLength(before, 'utf8') - Buffer.byteLength(head, 'utf8') + Buffer.byteLength(after, 'utf8') - Buffer.byteLength(tail, 'utf8')
  const notice = match[0].replace(match[1]!, String(Number(match[1]) + dropped))
  return head + notice + tail
}

function getErrorParts(error: Error): string[] {
  if (error instanceof ShellError) {
    const headline =
      !error.interrupted && Number.isFinite(error.code) && error.code !== 0
        ? `${error.message} (exit code ${error.code})`
        : error.message
    return [headline, error.interrupted ? INTERRUPT_MESSAGE : '', error.stderr, error.notice, error.stdout]
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
    return error instanceof Error && error.message.length > 0 ? error.message : INTERRUPT_MESSAGE
  }
  if (!(error instanceof Error)) {
    return String(error)
  }
  const combined = getErrorParts(error)
    .filter(part => part.length > 0)
    .join('\n')
    .trim()
  if (combined === '') {
    return 'The command failed and produced no output.'
  }
  if (combined.length <= MAX_ERROR_LENGTH || windowedErrors.has(error)) {
    return combined
  }
  const spillCut = cutAroundSpillNotice(combined, MAX_ERROR_LENGTH)
  if (spillCut !== null) {
    return spillCut
  }
  const removed = combined.length - ERROR_HEAD - ERROR_TAIL
  return `${combined.slice(0, ERROR_HEAD)}\n\n… [${removed} characters removed] …\n\n${combined.slice(-ERROR_TAIL)}`
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
    } catch (error) {
      passedOver(error)
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

const PARAMETER_STAND_INS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Grep: {
    '-o': 'output_mode "content" prints the matching lines',
    '-l': 'output_mode "files_with_matches" lists the files that match',
    '-c': 'output_mode "count" counts the matches',
    '-e': 'pattern carries the expression',
    '-E': 'pattern is a regex already',
    '-P': 'pattern falls back to PCRE2 for lookaround and backreferences',
    '-F': 'literal true matches the pattern as exact text',
    '-w': 'a \\b boundary in pattern',
    '-r': 'the search is recursive already; path narrows it',
    '-R': 'the search is recursive already; path narrows it',
    '-m': 'head_limit caps the lines',
    '-t': 'type narrows by language',
    '--type': 'type narrows by language',
    '--include': 'glob narrows the files',
    '--glob': 'glob narrows the files',
    '-g': 'glob narrows the files',
    '--context': 'context (or -C) sets the lines around each hit',
    '-U': 'multiline lets the pattern span lines',
  },
}

export function parameterStandIn(toolName: string, key: string): string | undefined {
  return PARAMETER_STAND_INS[toolName]?.[key]
}

function formatIssue(issue: IssueLike, inputSchema: unknown, toolName?: string): string[] {
  const name = formatIssuePath(issue.path)
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.message.includes('received undefined')) {
        return [`The required parameter \`${name}\` is missing`]
      }
      const receivedMatch = issue.message.match(/received (\w+)/)
      const received = receivedMatch ? receivedMatch[1]! : 'a different type'
      return [`Parameter \`${name}\` expects type ${issue.expected ?? 'unknown'}, got ${received}`]
    }
    case 'unrecognized_keys': {
      const validKeys = extractSchemaKeys(inputSchema)
      const suffix = validKeys ? `; valid parameters are: ${validKeys.map(key => `"${key}"`).join(', ')}` : ''
      return (issue.keys ?? []).map(key => {
        const standIn = toolName === undefined ? undefined : parameterStandIn(toolName, key)
        return `The parameter \`${key}\` was not expected${standIn === undefined ? '' : ` — ${standIn}`}${suffix}`
      })
    }
    case 'invalid_value': {
      const values = issue.values ?? []
      if (values.length === 0) {
        return [`The parameter \`${name}\` has an invalid value`]
      }
      return [`Parameter \`${name}\` must be one of: ${values.map(value => JSON.stringify(value)).join(', ')}`]
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
  const invalidTypePaths = new Set<string>()
  for (const issue of error.issues) {
    if (issue.code === 'invalid_type') {
      invalidTypePaths.add(formatIssuePath(issue.path))
    }
  }
  const lines: string[] = []
  for (const issue of error.issues) {
    if (
      (issue.code === 'too_small' || issue.code === 'too_big') &&
      invalidTypePaths.has(formatIssuePath(issue.path))
    ) {
      continue
    }
    lines.push(...formatIssue(issue as IssueLike, inputSchema, toolName))
  }
  if (lines.length === 0) {
    return error.message
  }
  const label = lines.length === 1 ? 'issue' : 'issues'
  return `${toolName} failed (${label}):\n${lines.join('\n')}`
}

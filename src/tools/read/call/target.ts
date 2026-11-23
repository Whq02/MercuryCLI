import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, suggestPathUnderCwd } from '../../../platform/files/file.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { expandPath } from '../../../platform/files/path.js'
import { parseRichFormatTarget, type ParsedRichTarget } from '../readRichFormats.js'
import { MAX_RANGES_PER_READ } from './schema.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function remoteRangeSelector(rawPath: string): { path: string; ranges: string[] } | null {
  const colon = rawPath.lastIndexOf(':')
  const slash = rawPath.indexOf('/', rawPath.indexOf('://') + 3)
  if (slash === -1 || colon < slash) return null
  const suffix = rawPath.slice(colon + 1)
  if (!/^[-\d+,]+$/.test(suffix) || !/\d/.test(suffix)) return null
  const parsed = parseLineRangesList([suffix])
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return { path: rawPath.slice(0, colon), ranges: suffix.split(',').map(part => part.trim()).filter(Boolean) }
}

export function remoteRichTarget(rawPath: string): ParsedRichTarget | null {
  const slash = rawPath.indexOf('/', rawPath.indexOf('://') + 3)
  if (slash === -1) return null
  const rich = parseRichFormatTarget(rawPath.slice(slash))
  return rich === null ? null : { ...rich, containerPath: `${rawPath.slice(0, slash)}${rich.containerPath}` }
}

export function remoteAlso(rawPath: string): string | null {
  const rich = remoteRichTarget(rawPath)
  return rich?.subtarget !== undefined ? rich.containerPath : (remoteRangeSelector(rawPath)?.path ?? null)
}

export function renamed<Value>(value: Value, from: string, to: string): Value {
  if (typeof value === 'string') return (value.includes(from) ? value.replaceAll(from, to) : value) as Value
  if (value === null || typeof value !== 'object') return value
  const holder = value as Record<string, unknown>
  for (const key of Object.keys(holder)) holder[key] = renamed(holder[key], from, to)
  return value
}

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

const BLOCKED_PROC_FD_PATTERN = /^\/proc\/.+\/fd\/[012]$/

export function isBlockingDevicePath(path: string): boolean {
  return BLOCKED_DEVICE_PATHS.has(path) || BLOCKED_PROC_FD_PATTERN.test(path)
}

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export function hasImageSignature(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) return false
    const header = Buffer.alloc(12)
    const length = readSync(fd, header, 0, header.length, 0)
    if (length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
    if (length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true
    const magic = header.subarray(0, 6).toString('ascii')
    if (length >= 6 && (magic === 'GIF87a' || magic === 'GIF89a')) return true
    return length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
  } finally {
    closeSync(fd)
  }
}

export function extensionOf(rawPath: string): string {
  const base = rawPath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

function canonicalFilename(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
}

export function resolveCanonicalNearMissPath(filePath: string): string | null {
  try {
    const dir = dirname(filePath)
    const wantedName = basename(filePath)
    const wantedCanonical = canonicalFilename(wantedName)
    let matched: string | null = null
    for (const entry of readdirSync(dir)) {
      if (entry === wantedName) continue
      if (canonicalFilename(entry) !== wantedCanonical) continue
      if (matched !== null) return null
      matched = entry
    }
    return matched !== null ? join(dir, matched) : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

const SCREENSHOT_NAME_PATTERN = /^([\s\S]*)([  ])(AM|PM)(\.png)$/

export function alternateScreenshotPath(path: string): string | null {
  const match = SCREENSHOT_NAME_PATTERN.exec(path)
  if (!match) return null
  const alternate = match[2] === ' ' ? ' ' : ' '
  return `${match[1]}${alternate}${match[3]}${match[4]}`
}

export async function friendlyNotFoundError(requestedPath: string, expandedPath: string): Promise<Error> {
  let suggestion: string | undefined
  try {
    suggestion = await suggestPathUnderCwd(expandedPath)
  } catch {
    suggestion = undefined
  }
  if (suggestion === undefined) {
    const similar = findSimilarFile(expandedPath)
    if (similar !== undefined) suggestion = similar
  }
  let message = `There is no file at that path. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
  if (suggestion) message += ` Did you mean ${suggestion}?`
  return new Error(message)
}

export type ParsedLineRange =
  | { kind: 'tail'; count: number }
  | { kind: 'span'; start: number; limit?: number }

function parseSingleRangeSelector(raw: string): ParsedLineRange | null {
  const s = raw.trim()
  if (s === '') return null
  const tailMatch = /^-(\d+)$/.exec(s)
  if (tailMatch) {
    const count = Number(tailMatch[1])
    return Number.isSafeInteger(count) && count > 0 ? { kind: 'tail', count } : null
  }
  const plusMatch = /^(\d+)\+(\d+)$/.exec(s)
  if (plusMatch) {
    const start = Number(plusMatch[1])
    const count = Number(plusMatch[2])
    return Number.isSafeInteger(start) && start >= 1 && Number.isSafeInteger(count) && count > 0
      ? { kind: 'span', start, limit: count }
      : null
  }
  const openMatch = /^(\d+)-$/.exec(s)
  if (openMatch) {
    const start = Number(openMatch[1])
    return Number.isSafeInteger(start) && start >= 1 ? { kind: 'span', start } : null
  }
  const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(s)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null
    return { kind: 'span', start, limit: end - start + 1 }
  }
  return null
}

export function parseLineRangesList(items: readonly string[]): ParsedLineRange[] | { invalid: string; tooMany?: boolean } {
  const out: ParsedLineRange[] = []
  for (const item of items) {
    for (const part of item.split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const parsed = parseSingleRangeSelector(trimmed)
      if (parsed === null) return { invalid: trimmed }
      out.push(parsed)
      if (out.length > MAX_RANGES_PER_READ) return { invalid: trimmed, tooMany: true }
    }
  }
  return out
}

export function splitPathRangeSelector(rawPath: string, expandedPath: string): { rawPath: string; expandedPath: string; ranges?: string[] } {
  const colon = rawPath.lastIndexOf(':')
  if (colon <= 0) return { rawPath, expandedPath }
  if (colon === 1 && /^[A-Za-z]$/.test(rawPath[0]!)) return { rawPath, expandedPath }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) return { rawPath, expandedPath }
  const suffix = rawPath.slice(colon + 1)
  if (!/^[-\d+,]+$/.test(suffix) || !/\d/.test(suffix)) return { rawPath, expandedPath }
  if (existsSync(expandedPath)) return { rawPath, expandedPath }
  const parsed = parseLineRangesList([suffix])
  if (!Array.isArray(parsed) || parsed.length === 0) return { rawPath, expandedPath }
  const strippedRaw = rawPath.slice(0, colon)
  return {
    rawPath: strippedRaw,
    expandedPath: expandPath(strippedRaw),
    ranges: suffix.split(',').map(s => s.trim()).filter(Boolean),
  }
}

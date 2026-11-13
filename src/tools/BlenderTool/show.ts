import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { hasImageSignature, imageReadCaptions, readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { imageDimensionsFromHeader } from '../FileReadTool/imageProcessorJs.js'
import { getDefaultFileReadingLimits } from '../FileReadTool/limits.js'

export const SHOWN_AT_MOST = 4

type Box = readonly [number, number, number, number]
type ReadPicture = Awaited<ReturnType<typeof readImageWithTokenBudget>>

export interface ShowEntry {
  path: string
  crop?: Box
  scale?: number
}

export type ShownPart =
  | { kind: 'picture'; caption: string; base64: string; mediaType: ReadPicture['file']['type'] }
  | { kind: 'note'; text: string }

type FileStamp = { mtimeMs: number; ctimeMs: number; size: number } | null

export const SHOW_SHAPE_RULE =
  'show is a list of pictures the script writes, each a path or {path, crop, scale} with crop and scale as Read takes them'

function entryOf(value: unknown): ShowEntry | null {
  if (typeof value === 'string') return value.length > 0 ? { path: value } : null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.path !== 'string' || row.path.length === 0) return null
  if (Object.keys(row).some(key => key !== 'path' && key !== 'crop' && key !== 'scale')) return null
  const entry: ShowEntry = { path: row.path }
  if (row.crop !== undefined) {
    if (!Array.isArray(row.crop) || row.crop.length !== 4 || row.crop.some(n => typeof n !== 'number')) return null
    entry.crop = row.crop as unknown as Box
  }
  if (row.scale !== undefined) {
    if (typeof row.scale !== 'number' || !Number.isFinite(row.scale) || row.scale < 1) return null
    entry.scale = row.scale
  }
  return entry
}

export function parseShowList(value: unknown): { entries: ShowEntry[] } | { problem: string } {
  if (value === undefined) return { entries: [] }
  if (!Array.isArray(value)) return { problem: SHOW_SHAPE_RULE }
  const entries: ShowEntry[] = []
  for (const item of value) {
    const entry = entryOf(item)
    if (entry === null) return { problem: SHOW_SHAPE_RULE }
    entries.push(entry)
  }
  return { entries }
}

export function showTargets(entries: readonly ShowEntry[]): string[] {
  return entries.map(entry => path.resolve(getCwd(), entry.path))
}

function stampOf(file: string): FileStamp {
  try {
    const st = statSync(file)
    return st.isFile() ? { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size } : null
  } catch {
    return null
  }
}

export function stampShown(entries: readonly ShowEntry[]): FileStamp[] {
  return showTargets(entries.slice(0, SHOWN_AT_MOST)).map(stampOf)
}

function isPicture(file: string): boolean {
  try {
    return hasImageSignature(file)
  } catch {
    return false
  }
}

export async function readShown(entries: readonly ShowEntry[], before: readonly FileStamp[]): Promise<ShownPart[]> {
  const parts: ShownPart[] = []
  const files = showTargets(entries.slice(0, SHOWN_AT_MOST))
  for (const [index, file] of files.entries()) {
    const entry = entries[index]!
    const after = stampOf(file)
    if (after === null) {
      parts.push({ kind: 'note', text: `show: ${entry.path} was not written` })
      continue
    }
    if (!isPicture(file)) {
      parts.push({ kind: 'note', text: `show: ${entry.path} is not a picture (png, jpeg, gif or webp)` })
      continue
    }
    const was = before[index] ?? null
    const stale = was !== null && was.mtimeMs === after.mtimeMs && was.ctimeMs === after.ctimeMs && was.size === after.size
    let crop = entry.crop
    if (crop === undefined && entry.scale !== undefined && entry.scale !== 1) {
      const whole = imageDimensionsFromHeader(readFileSync(file))
      if (whole !== null) crop = [0, 0, whole.width, whole.height]
    }
    const scale = crop === undefined ? 1 : (entry.scale ?? 1)
    try {
      const read = await readImageWithTokenBudget(file, getDefaultFileReadingLimits().maxTokens, undefined, crop, scale)
      const captions = imageReadCaptions(file, read.file.dimensions, read.cropped, scale)
      if (captions.length === 0) captions.push(`[Image source: ${file}]`)
      if (stale) captions.push('(not written by this call)')
      parts.push({ kind: 'picture', caption: captions.join('\n'), base64: read.file.base64, mediaType: read.file.type })
    } catch (err) {
      parts.push({ kind: 'note', text: `show: ${entry.path}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  if (entries.length > SHOWN_AT_MOST) {
    parts.push({ kind: 'note', text: `show: ${SHOWN_AT_MOST} pictures at most ride one answer; not shown: ${entries.slice(SHOWN_AT_MOST).map(entry => entry.path).join(', ')}` })
  }
  return parts
}

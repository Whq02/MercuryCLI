import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { OwnerScopedStore } from '../../engine/run-owner/ownerScopedStore.js'
import { registerOwnerScopedStore } from '../../engine/run-owner/ownerLifecycle.js'
import type { ResolutionPlan } from './conflictRegions.js'

export type ConflictRegion = {
  id: string
  path: string
  start: number
  end: number
  startLine: number
  endLine: number
  raw: string
  ours: { text: string; line: number }
  theirs: { text: string; line: number }
  base?: { text: string; line: number }
}

type RegionState = { roots: Map<string, Map<string, ConflictRegion[]>>; plans: Map<string, ResolutionPlan> }
export const store = new OwnerScopedStore<RegionState>({ name: 'git-conflict-regions', create: () => ({ roots: new Map(), plans: new Map() }), cap: 32 })
registerOwnerScopedStore(store)

function parseRegions(file: string, text: string): ConflictRegion[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  offsets.push(offset)
  const out: ConflictRegion[] = []
  let start = -1
  let base = -1
  let middle = -1
  let width = 0
  let malformed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r?\n$/, '')
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?: .*)?$/.exec(line)
    if (!marker) continue
    const chars = marker[1]!
    if (start !== -1 && chars.length !== width) continue
    if (chars[0] === '<') {
      if (start !== -1) { malformed = true; continue }
      start = i; base = -1; middle = -1; width = chars.length; malformed = false
      continue
    }
    if (start === -1) continue
    if (chars[0] === '|') {
      if (base !== -1 || middle !== -1) malformed = true
      else base = i
    } else if (chars[0] === '=') {
      if (middle !== -1) malformed = true
      else middle = i
    } else if (chars[0] === '>') {
      if (!malformed && middle !== -1) {
        const part = (from: number, to: number) => ({ text: text.slice(offsets[from], offsets[to]), line: from + 1 })
        out.push({ id: '', path: file, start: offsets[start]!, end: offsets[i + 1]!, startLine: start + 1, endLine: i + 1,
          raw: text.slice(offsets[start], offsets[i + 1]), ours: part(start + 1, base === -1 ? middle : base),
          theirs: part(middle + 1, i), ...(base === -1 ? {} : { base: part(base + 1, middle) }) })
      }
      start = -1
    }
  }
  return out
}

export function filesFor(owner: OwnerKey, root: string): Map<string, ConflictRegion[]> {
  const roots = store.get(owner).roots
  let files = roots.get(root)
  if (!files) { files = new Map(); roots.set(root, files) }
  return files
}

export function readConflictRegions(owner: OwnerKey, root: string, file: string): ConflictRegion[] {
  const files = filesFor(owner, root)
  const absolute = path.join(root, file)
  let text: string
  try {
    if (!lstatSync(absolute).isFile()) { files.delete(file); return [] }
    const bytes = readFileSync(absolute)
    text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) { files.delete(file); return [] }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') { files.delete(file); return [] }
    throw error
  }
  const parsed = parseRegions(file, text)
  const remaining = [...(files.get(file) ?? [])].filter(old => {
    const previousCount = files.get(file)!.filter(r => r.raw === old.raw).length
    const currentCount = parsed.filter(r => r.raw === old.raw).length
    return previousCount === currentCount || previousCount === 1
  })
  const regions = parsed.map(region => {
    const index = remaining.findIndex(old => old.raw === region.raw)
    const prior = index === -1 ? undefined : remaining.splice(index, 1)[0]
    return { ...region, id: prior?.id ?? `gr-${randomUUID().replaceAll('-', '')}` }
  })
  files.set(file, regions)
  return regions
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { stripBOM } from '../utils/jsonRead.js'
import { retainItems } from './memoryVerbs.js'
import { deterministicRewriter, maybeConsolidate, type MnemeRewriter } from './mnemeConsolidate.js'
import { publishLibraryFile } from './mnemeLibrary.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { getMnemeHome } from './paths.js'

export const HANDOVER_FILE = 'handover.json'
const CHUNK_CHARS = 1900

export const HANDOVER_PAGES: Record<string, string> = {
  preferences: 'how the user wants to work: standing rules and preferences',
  project: 'ongoing project facts, goals and decisions',
  references: 'where things live outside this repository',
  lessons: 'lessons worth keeping across sessions',
  notes: 'notes',
}

export interface HandoverReceipt {
  version: 1
  ranAt: string
  memoryDir: string
  notes: number
  facts: number
  pinned: number
  pages: Record<string, number>
  skipped: Array<{ file: string; reason: string }>
  consolidated: boolean
}

interface NoteHead {
  name?: string
  description?: string
  type?: string
  card: boolean
}

function readNote(path: string): { head: NoteHead; body: string } | null {
  let raw: string
  try {
    raw = stripBOM(readFileSync(path, 'utf8')).replaceAll('\r\n', '\n')
  } catch {
    return null
  }
  const head: NoteHead = { card: false }
  let body = raw
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    body = raw.slice(fm[0].length)
    for (const line of fm[1]!.split('\n')) {
      const top = line.match(/^(name|description|type):\s*(.*)$/)
      if (top) head[top[1] as 'name' | 'description' | 'type'] = top[2]!.trim()
      if (/^\s+type:\s*experience-card\s*$/.test(line)) head.card = true
    }
  }
  return { head, body }
}

export function flattenNote(body: string): string {
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function chunkNote(text: string, cap: number = CHUNK_CHARS): string[] {
  if (text.length <= cap) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > cap) {
    let cut = rest.lastIndexOf('. ', cap)
    if (cut < cap / 2) cut = rest.lastIndexOf(' ', cap)
    if (cut < cap / 2) cut = cap
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts.map((p, i) => `${p} (part ${i + 1}/${parts.length})`)
}

export function routeNote(head: NoteHead): { topic: string; pin: boolean } {
  if (head.card) return { topic: 'lessons', pin: false }
  switch (head.type) {
    case 'feedback':
    case 'user':
      return { topic: 'preferences', pin: true }
    case 'project':
      return { topic: 'project', pin: false }
    case 'reference':
      return { topic: 'references', pin: false }
    default:
      return { topic: 'notes', pin: false }
  }
}

export function listOldNotes(memoryDir: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(memoryDir)
  } catch {
    return []
  }
  return names
    .filter(n => n.endsWith('.md') && n !== 'MEMORY.md' && n !== 'TASTE.md' && !n.includes('.superseded.'))
    .filter(n => {
      try {
        return statSync(join(memoryDir, n)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

export function handoverReceiptPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, HANDOVER_FILE)
}

export function readHandoverReceipt(dir: string = mnemeLibraryDir()): HandoverReceipt | null {
  try {
    const parsed = JSON.parse(readFileSync(handoverReceiptPath(dir), 'utf8')) as HandoverReceipt
    return typeof parsed?.ranAt === 'string' && typeof parsed?.notes === 'number' ? parsed : null
  } catch {
    return null
  }
}

export function handoverDue(memoryDir: string = getMnemeHome()): boolean {
  if (!mnemeEnabled()) return false
  if (readHandoverReceipt(join(memoryDir, 'library')) !== null) return false
  return listOldNotes(memoryDir).length > 0
}

const handoverRewriter: MnemeRewriter = input => {
  const draft = deterministicRewriter(input)
  for (const block of draft.blocks) {
    const summary = HANDOVER_PAGES[block.topicSlug]
    if (summary) block.summary = summary
  }
  return draft
}

export function handoverMemoryDir(memoryDir: string, now: Date = new Date()): HandoverReceipt {
  const dir = join(memoryDir, 'library')
  const existing = readHandoverReceipt(dir)
  if (existing) return existing
  const receipt: HandoverReceipt = {
    version: 1,
    ranAt: now.toISOString(),
    memoryDir,
    notes: 0,
    facts: 0,
    pinned: 0,
    pages: {},
    skipped: [],
    consolidated: false,
  }
  const files = listOldNotes(memoryDir)
  for (const file of files) {
    const note = readNote(join(memoryDir, file))
    if (!note) {
      receipt.skipped.push({ file, reason: 'unreadable' })
      continue
    }
    const text = flattenNote(note.body) || flattenNote(note.head.description ?? '')
    if (!text) {
      receipt.skipped.push({ file, reason: 'empty' })
      continue
    }
    const route = routeNote(note.head)
    const chunks = chunkNote(text)
    const outcomes = retainItems(
      chunks.map(content => ({ content, topic: route.topic })),
      { session: 'handover', source: `handover:${basename(file, '.md').slice(0, 48)}`, pin: route.pin },
      dir,
    )
    const stored = outcomes.filter(o => o.status === 'stored' || o.status === 'already-staged').length
    if (stored === 0) {
      receipt.skipped.push({ file, reason: outcomes.map(o => (o.status === 'refused' ? o.reason : o.status)).join('; ') })
      continue
    }
    receipt.notes++
    receipt.facts += stored
    if (route.pin) receipt.pinned += stored
    receipt.pages[route.topic] = (receipt.pages[route.topic] ?? 0) + stored
  }
  if (receipt.facts > 0) {
    const result = maybeConsolidate({ force: true, dir, now, rewriter: handoverRewriter })
    receipt.consolidated = result.consolidated
    if (!result.consolidated) logForDebugging(`memory hand-over: consolidation did not run — ${result.reason}`)
  }
  try {
    publishLibraryFile(handoverReceiptPath(dir), JSON.stringify(receipt, null, 1))
  } catch (e) {
    logForDebugging(`memory hand-over receipt failed: ${String(e)}`)
  }
  return receipt
}

export function handoverIfDue(memoryDir: string = getMnemeHome(), now: Date = new Date()): HandoverReceipt | null {
  try {
    if (!handoverDue(memoryDir)) return null
    return handoverMemoryDir(memoryDir, now)
  } catch (e) {
    logForDebugging(`memory hand-over failed: ${String(e)}`)
    return null
  }
}

export function renderHandoverReceipt(receipt: HandoverReceipt): string[] {
  const pages = Object.entries(receipt.pages)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slug, n]) => `${slug} ${n}`)
    .join(' · ')
  const lines = [
    `${receipt.notes} note${receipt.notes === 1 ? '' : 's'} → ${receipt.facts} fact${receipt.facts === 1 ? '' : 's'} (${receipt.pinned} pinned) on ${receipt.ranAt.slice(0, 16)}`,
    `pages: ${pages || 'none'}`,
  ]
  if (receipt.skipped.length > 0) lines.push(`skipped: ${receipt.skipped.map(s => `${s.file} (${s.reason})`).join(', ')}`)
  if (!receipt.consolidated && receipt.facts > 0) lines.push('the facts wait in the buffer — run maintenance')
  return lines
}

export function handoverExists(memoryDir: string): boolean {
  return existsSync(handoverReceiptPath(join(memoryDir, 'library')))
}

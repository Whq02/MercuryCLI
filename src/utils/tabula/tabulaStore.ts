
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import { djb2Hash } from '../hash.js'
import { isTabulaEnabled } from './tabulaGates.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'

export type TabulaPriority = 'now' | 'next' | 'later'
export const TABULA_PRIORITIES: readonly TabulaPriority[] = ['now', 'next', 'later']

export type TabulaDoneVia = 'auto' | 'minerva'
export const TABULA_DONE_VIAS: readonly TabulaDoneVia[] = ['auto', 'minerva']

export interface TabulaNote {
  id: string
  text: string
  refinedText?: string
  pri: TabulaPriority
  done: boolean
  firedAt?: string
  doneVia?: TabulaDoneVia
  createdAt: string
  updatedAt: string
}

export type TabulaEvent =
  | { t: string; op: 'add'; id: string; text: string; pri?: TabulaPriority }
  | { t: string; op: 'edit'; id: string; text: string }
  | { t: string; op: 'pri'; id: string; pri: TabulaPriority }
  | { t: string; op: 'done'; id: string; done: boolean; via?: TabulaDoneVia }
  | { t: string; op: 'del'; id: string }
  | { t: string; op: 'refine'; id: string; refinedText: string; baseHash: string }
  | { t: string; op: 'order'; ids: string[] }
  | { t: string; op: 'fire'; id: string }

export interface TabulaReadResult {
  notes: TabulaNote[]
  journalBytes: number
  latestEventAt?: string
  reason?: string
}

export interface MinervaPlan {
  notes: Array<{ id: string; pri?: TabulaPriority; refinedText?: string }>
  orderedIds: string[]
  receipt: string
  doneIds?: string[]
}

export interface TabulaMeta {
  lastMinervaRunAt?: string
  lastMinervaJournalBytes?: number
  lastReceipt?: string
  lastError?: string
  lastChatAt?: string
}

const HISTORY_KEEP = 20
const JOURNAL = 'journal.jsonl'
const NOTEPAD = 'notepad.md'
const META = 'meta.json'

export function noteTextHash(text: string): string {
  return djb2Hash(text).toString(36)
}

export function newNoteId(): string {
  const salt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return djb2Hash(salt).toString(36).slice(0, 6)
}

export function appendEvents(dir: string, events: TabulaEvent[]): void {
  if (!isTabulaEnabled() || events.length === 0) return
  mkdirSync(dir, { recursive: true })
  const path = join(dir, JOURNAL)
  let needsLeadingNewline = false
  try {
    if (existsSync(path)) {
      const fd = openSync(path, 'r')
      try {
        const { size } = fstatSync(fd)
        if (size > 0) {
          const buf = Buffer.alloc(1)
          readSync(fd, buf, 0, 1, size - 1)
          needsLeadingNewline = buf[0] !== 0x0a
        }
      } finally {
        closeSync(fd)
      }
    }
  } catch {
  }
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  appendFileSync(path, (needsLeadingNewline ? '\n' : '') + lines, 'utf8')
}

function parseEventLine(line: string): TabulaEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.t !== 'string' || typeof raw.op !== 'string') return null
    switch (raw.op) {
      case 'add':
        if (typeof raw.id !== 'string' || typeof raw.text !== 'string') return null
        return {
          t: raw.t,
          op: 'add',
          id: raw.id,
          text: raw.text,
          ...(TABULA_PRIORITIES.includes(raw.pri as TabulaPriority)
            ? { pri: raw.pri as TabulaPriority }
            : {}),
        }
      case 'edit':
        if (typeof raw.id !== 'string' || typeof raw.text !== 'string') return null
        return { t: raw.t, op: 'edit', id: raw.id, text: raw.text }
      case 'pri':
        if (typeof raw.id !== 'string' || !TABULA_PRIORITIES.includes(raw.pri as TabulaPriority)) return null
        return { t: raw.t, op: 'pri', id: raw.id, pri: raw.pri as TabulaPriority }
      case 'done':
        if (typeof raw.id !== 'string') return null
        return {
          t: raw.t,
          op: 'done',
          id: raw.id,
          done: raw.done === true,
          ...(TABULA_DONE_VIAS.includes(raw.via as TabulaDoneVia)
            ? { via: raw.via as TabulaDoneVia }
            : {}),
        }
      case 'del':
        if (typeof raw.id !== 'string') return null
        return { t: raw.t, op: 'del', id: raw.id }
      case 'fire':
        if (typeof raw.id !== 'string') return null
        return { t: raw.t, op: 'fire', id: raw.id }
      case 'refine':
        if (
          typeof raw.id !== 'string' ||
          typeof raw.refinedText !== 'string' ||
          typeof raw.baseHash !== 'string'
        )
          return null
        return { t: raw.t, op: 'refine', id: raw.id, refinedText: raw.refinedText, baseHash: raw.baseHash }
      case 'order':
        if (!Array.isArray(raw.ids) || !raw.ids.every(x => typeof x === 'string')) return null
        return { t: raw.t, op: 'order', ids: raw.ids as string[] }
      default:
        return null
    }
  } catch {
    return null
  }
}

export function readNotes(dir: string): TabulaReadResult {
  if (!isTabulaEnabled()) return { notes: [], journalBytes: 0, reason: 'tabula disabled' }
  const path = join(dir, JOURNAL)
  if (!existsSync(path)) return { notes: [], journalBytes: 0 }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return {
      notes: [],
      journalBytes: 0,
      reason: `journal unreadable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  return foldJournal(raw)
}

export async function readNotesAsync(dir: string): Promise<TabulaReadResult> {
  if (!isTabulaEnabled()) return { notes: [], journalBytes: 0, reason: 'tabula disabled' }
  const path = join(dir, JOURNAL)
  let raw: string
  try {
    raw = await fsPromises.readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { notes: [], journalBytes: 0 }
    return {
      notes: [],
      journalBytes: 0,
      reason: `journal unreadable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  return foldJournal(raw)
}

function foldJournal(raw: string): TabulaReadResult {
  const byId = new Map<string, TabulaNote>()
  const insertion: string[] = []
  let order: string[] | undefined
  let latestEventAt: string | undefined
  for (const line of raw.split('\n')) {
    const ev = parseEventLine(line)
    if (!ev) continue
    if (latestEventAt === undefined || ev.t > latestEventAt) latestEventAt = ev.t
    switch (ev.op) {
      case 'add': {
        if (byId.has(ev.id)) break
        byId.set(ev.id, {
          id: ev.id,
          text: ev.text,
          pri: ev.pri ?? 'next',
          done: false,
          createdAt: ev.t,
          updatedAt: ev.t,
        })
        insertion.push(ev.id)
        break
      }
      case 'edit': {
        const n = byId.get(ev.id)
        if (!n) break
        n.text = ev.text
        delete n.refinedText
        delete n.firedAt
        n.updatedAt = ev.t
        break
      }
      case 'pri': {
        const n = byId.get(ev.id)
        if (!n) break
        n.pri = ev.pri
        n.updatedAt = ev.t
        break
      }
      case 'done': {
        const n = byId.get(ev.id)
        if (!n) break
        n.done = ev.done
        if (ev.done) {
          if (ev.via) n.doneVia = ev.via
          else delete n.doneVia
        }
        if (!ev.done) {
          delete n.doneVia
          delete n.firedAt
        }
        n.updatedAt = ev.t
        break
      }
      case 'del': {
        byId.delete(ev.id)
        break
      }
      case 'fire': {
        const n = byId.get(ev.id)
        if (!n) break
        n.firedAt = ev.t
        break
      }
      case 'refine': {
        const n = byId.get(ev.id)
        if (!n) break
        if (noteTextHash(n.text) !== ev.baseHash) break
        n.refinedText = ev.refinedText
        n.updatedAt = ev.t
        break
      }
      case 'order': {
        order = ev.ids
        break
      }
    }
  }
  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const id of order ?? []) {
    if (byId.has(id) && !seen.has(id)) {
      orderedIds.push(id)
      seen.add(id)
    }
  }
  for (const id of insertion) {
    if (byId.has(id) && !seen.has(id)) {
      orderedIds.push(id)
      seen.add(id)
    }
  }
  const result: TabulaReadResult = {
    notes: orderedIds.map(id => byId.get(id)!),
    journalBytes: Buffer.byteLength(raw, 'utf8'),
  }
  if (latestEventAt !== undefined) result.latestEventAt = latestEventAt
  return result
}

function priSection(notes: TabulaNote[], pri: TabulaPriority): TabulaNote[] {
  return notes.filter(n => !n.done && n.pri === pri)
}

function renderNoteLine(n: TabulaNote): string {
  const shown = n.refinedText ?? n.text
  const orig = n.refinedText ? `  <!-- original: ${n.text.replace(/-->/g, '')} -->` : ''
  return `- [${n.done ? 'x' : ' '}] ${shown} \`${n.id}\`${orig}`
}

export function materializeNotepad(dir: string, projectName: string): string {
  if (!isTabulaEnabled()) return ''
  const { notes, latestEventAt } = readNotes(dir)
  const done = notes.filter(n => n.done).slice(-10)
  const lines: string[] = [
    `# Tabula — ${projectName}`,
    '',
    `_${notes.filter(n => !n.done).length} open note(s)${latestEventAt ? ` · updated ${latestEventAt}` : ''}_`,
    '',
  ]
  for (const pri of TABULA_PRIORITIES) {
    const section = priSection(notes, pri)
    lines.push(`## ${pri === 'now' ? 'Now' : pri === 'next' ? 'Next' : 'Later'}`)
    lines.push(...(section.length ? section.map(renderNoteLine) : ['_(empty)_']))
    lines.push('')
  }
  lines.push('## Done')
  lines.push(...(done.length ? done.map(renderNoteLine) : ['_(empty)_']))
  lines.push('')
  lines.push('---')
  lines.push('_Generated from journal.jsonl — edit via `/tabula` (or `/note <text>` to capture)._')
  const md = lines.join('\n') + '\n'
  try {
    durableAtomicPublishSync(join(dir, NOTEPAD), md)
  } catch {
  }
  return md
}

export function readTabulaMeta(dir: string): TabulaMeta {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, META), 'utf8')) as TabulaMeta
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeTabulaMeta(dir: string, meta: TabulaMeta): void {
  if (!isTabulaEnabled()) return
  try {
    durableAtomicPublishSync(join(dir, META), JSON.stringify(meta, null, 2) + '\n')
  } catch {
  }
}

export function archiveNotepad(dir: string, stamp: string): void {
  const src = join(dir, NOTEPAD)
  if (!existsSync(src)) return
  const histDir = join(dir, 'history')
  mkdirSync(histDir, { recursive: true })
  const safe = stamp.replace(/[^0-9TZ-]/g, '-')
  try {
    writeFileSync(join(histDir, `${safe}.md`), readFileSync(src, 'utf8'), { flag: 'wx' })
  } catch {
  }
  try {
    const entries = readdirSync(histDir)
      .filter(f => f.endsWith('.md'))
      .sort()
    for (const stale of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
      rmSync(join(histDir, stale), { force: true })
    }
  } catch {
  }
}

export type MinervaApplyResult =
  | { ok: true; newNotesDuringRun: number }
  | { ok: false; reason: string }

export function applyMinervaPlan(
  dir: string,
  projectName: string,
  plan: MinervaPlan,
  baseJournalBytes: number,
): MinervaApplyResult {
  if (!isTabulaEnabled()) return { ok: false, reason: 'tabula disabled' }
  const current = readNotes(dir)
  if (current.reason) return { ok: false, reason: current.reason }
  const byId = new Map(current.notes.map(n => [n.id, n]))
  const stamp = new Date().toISOString()
  const events: TabulaEvent[] = []
  for (const p of plan.notes) {
    const live = byId.get(p.id)
    if (!live) continue
    if (p.pri && TABULA_PRIORITIES.includes(p.pri) && p.pri !== live.pri) {
      events.push({ t: stamp, op: 'pri', id: p.id, pri: p.pri })
    }
    if (typeof p.refinedText === 'string' && p.refinedText.trim() && p.refinedText !== live.refinedText) {
      events.push({
        t: stamp,
        op: 'refine',
        id: p.id,
        refinedText: p.refinedText.trim(),
        baseHash: noteTextHash(live.text),
      })
    }
  }
  if (plan.orderedIds.length > 0) {
    events.push({ t: stamp, op: 'order', ids: plan.orderedIds })
  }
  for (const id of plan.doneIds ?? []) {
    const live = byId.get(id)
    if (!live || live.done) continue
    events.push({ t: stamp, op: 'done', id, done: true, via: 'minerva' })
  }
  archiveNotepad(dir, stamp)
  appendEvents(dir, events)
  materializeNotepad(dir, projectName)
  const meta = readTabulaMeta(dir)
  writeTabulaMeta(dir, {
    ...meta,
    lastMinervaRunAt: stamp,
    lastMinervaJournalBytes: readNotes(dir).journalBytes,
    lastReceipt: plan.receipt,
  })
  const newNotesDuringRun = current.journalBytes > baseJournalBytes ? 1 : 0
  return { ok: true, newNotesDuringRun }
}

// ============================================================================
//  TABULA store — the append-only note journal + deterministic fold +
//  materialized notepad. The prompt-logger's substrate.
//
//  DESIGN (the no-data-loss shape):
//   • journal.jsonl is the SINGLE source of truth — every mutation (operator
//     or MINERVA) is an appended event; nothing ever rewrites history. Two
//     concurrent sessions append safely (single O_APPEND write per batch).
//   • notepad.md is a DERIVED, human-readable view — always rebuildable from
//     the journal, atomically written (tmp+rename), stamped from the latest
//     EVENT time (never wall clock ⇒ byte-deterministic for proofs).
//   • MINERVA never owns truth: its plan lands as ordinary events, and a
//     `refine` event carries the baseHash of the text it refined — the fold
//     SKIPS a refinement whose base does not match (a stale suggestion can
//     never shadow an operator edit). Original text is never overwritten;
//     refinedText renders BESIDE it. (memory iterating on its own
//     outputs collapses — the raw journal is what MINERVA re-reads each run.)
//   • history/ archives the prior notepad.md on every MINERVA apply (bounded,
//     newest kept) — the operator can always see what the curator changed.
//
//  Every read path degrades to empty-with-reason; a torn/partial journal tail
//  (crash mid-append) is skipped line-wise, never fatal.
// ============================================================================

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

/** Who landed a `done` — absent means the operator did it by hand. */
export type TabulaDoneVia = 'auto' | 'minerva'
export const TABULA_DONE_VIAS: readonly TabulaDoneVia[] = ['auto', 'minerva']

export interface TabulaNote {
  id: string
  /** The operator's words, verbatim. Only an operator `edit` changes this. */
  text: string
  /** MINERVA's polished phrasing — advisory, rendered beside the original. */
  refinedText?: string
  pri: TabulaPriority
  done: boolean
  /** Stamp of the last `fire` — the note was dropped into a prompt and
   *  submitted. Cleared by an edit (new words = new intent) or a reopen. */
  firedAt?: string
  /** Provenance of the closing `done` (absent = operator keypress). */
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
  /** The note's text was submitted as (part of) a prompt this session. */
  | { t: string; op: 'fire'; id: string }

export interface TabulaReadResult {
  notes: TabulaNote[]
  /** Journal size at read time — MINERVA's cursor for change detection. */
  journalBytes: number
  /** Latest event stamp seen (deterministic "updated" for the notepad). */
  latestEventAt?: string
  reason?: string
}

/** MINERVA's structured plan (already schema-validated by the caller). */
export interface MinervaPlan {
  notes: Array<{ id: string; pri?: TabulaPriority; refinedText?: string }>
  orderedIds: string[]
  receipt: string
  /** TICK-OFF: OPEN note ids whose work the
   *  provided completion evidence shows finished — applied as `done` events
   *  with via:'minerva' (reversible on the board like any done). */
  doneIds?: string[]
}

export interface TabulaMeta {
  lastMinervaRunAt?: string
  lastMinervaJournalBytes?: number
  lastReceipt?: string
  lastError?: string
  /** Stamp of the last chat exchange (the message REPL) — advisory only;
   *  chat never touches the boot pass's journal cursor. */
  lastChatAt?: string
}

const HISTORY_KEEP = 20
const JOURNAL = 'journal.jsonl'
const NOTEPAD = 'notepad.md'
const META = 'meta.json'

/** The refine-guard hash — djb2 of the exact note text (cheap, stable). */
export function noteTextHash(text: string): string {
  return djb2Hash(text).toString(36)
}

/** Generate a short collision-safe note id (base36, time-salted). */
export function newNoteId(): string {
  const salt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return djb2Hash(salt).toString(36).slice(0, 6)
}

/** Append a batch of events as ONE O_APPEND write. No-op when gated OFF.
 *  Torn-tail healing: a crash mid-append can leave the journal without a
 *  trailing newline — appending straight after would CONCATENATE the new
 *  event onto the torn line (two records lost, not one). Lead with '\n'
 *  when the last byte isn't one; the fold skips the resulting blank. */
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
    // Heal check is best-effort; worst case matches the pre-heal behavior.
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
        // Unknown op from a future version — skip, never fatal.
        return null
    }
  } catch {
    return null
  }
}

/** Read + fold the journal into the live note set. Never throws. */
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

/** The async twin: render paths must not read the journal
 *  synchronously — the always-mounted rail refreshes through THIS and
 *  paints from its last-known fold. Same gate, same fold, async io. */
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

/** One pure fold from journal text to the read result — shared by the sync
 *  and async readers so the two can never drift. */
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
        // Re-add of a live id is a no-op — an id names ONE note forever.
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
        // An operator edit invalidates any prior refinement of the old text —
        // and any prior fire (the new words haven't been sent anywhere).
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
        // The latest closing event's provenance wins (an operator re-mark
        // clears a stale `auto`).
        if (ev.done) {
          if (ev.via) n.doneVia = ev.via
          else delete n.doneVia
        }
        if (!ev.done) {
          // A reopen resets the lifecycle: not sent, no closing provenance.
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
        // The anti-stale guard: a refinement only attaches when it was
        // computed against the CURRENT text. An operator edit between the
        // curator's read and its write changes the hash ⇒ skip, keep truth.
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
  // Display order: the latest `order` event's ids first (only live ones),
  // then any remaining notes in insertion order — an id unknown to the
  // ordering is APPENDED, never dropped.
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

/**
 * Rebuild notepad.md from the journal (deterministic; atomic write).
 * Returns the rendered markdown. Never throws; gated OFF ⇒ '' and no I/O.
 */
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
    // The view is derived — a failed write never blocks the journal.
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
    // Meta is advisory — never fatal.
  }
}

/** Archive the current notepad.md to history/ (bounded) — called before
 *  every curator apply (boot pass and chat alike) so the operator can always
 *  see what changed. */
export function archiveNotepad(dir: string, stamp: string): void {
  const src = join(dir, NOTEPAD)
  if (!existsSync(src)) return
  const histDir = join(dir, 'history')
  mkdirSync(histDir, { recursive: true })
  const safe = stamp.replace(/[^0-9TZ-]/g, '-')
  try {
    writeFileSync(join(histDir, `${safe}.md`), readFileSync(src, 'utf8'), { flag: 'wx' })
  } catch {
    // Same-stamp collision (rapid re-apply) — keep the existing archive.
  }
  try {
    const entries = readdirSync(histDir)
      .filter(f => f.endsWith('.md'))
      .sort()
    for (const stale of entries.slice(0, Math.max(0, entries.length - HISTORY_KEEP))) {
      rmSync(join(histDir, stale), { force: true })
    }
  } catch {
    // Pruning is best-effort.
  }
}

export type MinervaApplyResult =
  | { ok: true; newNotesDuringRun: number }
  | { ok: false; reason: string }

/**
 * Land a validated MINERVA plan as journal events (+ archive + meta).
 * `baseJournalBytes` is the cursor the plan was computed against: notes that
 * arrived after it are untouched (the fold's per-event guards make the apply
 * safe regardless — this count only feeds the honest receipt line).
 */
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
    if (!live) continue // curator referenced a since-deleted note — skip
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
  // TICK-OFF: evidence-backed completions close with the minerva provenance
  // (the validator already confined these to live OPEN notes).
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

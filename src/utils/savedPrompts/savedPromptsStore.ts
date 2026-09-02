// ============================================================================
//  savedPrompts/savedPromptsStore — the operator's SAVED PROMPTS: prompts
//  written ahead of sending (the prompts panel's third tab).
//
//  The shape of the promise: a saved prompt is
//  inert — it sits here, sent nowhere, costing nothing — until the operator
//  presses the one key that hands it to the focused chat's composer. The
//  list persists PER PROJECT across restarts: one plain JSON per project
//  under the Mercury config home (`<configHome>/saved-prompts/<project>.json`,
//  the tabula's cwd→slug convention), never the operator's global config and
//  never inside the repo tree.
//
//  Writes ride the fileStore kernel (locked read-modify-write + the durable
//  tmp+rename publish), so two Mercurys on one project cannot tear the file
//  and a crash mid-write leaves the previous file whole.
//
//  Minerva's law (sheet line 9): a refinement lands BESIDE the original —
//  `refinedText` next to `text`, the operator's wording byte-kept. Only the
//  operator's own edit changes `text`, and that edit drops the refinement
//  beside it (it was written for the old wording; keeping it would be a
//  stale suggestion shadowing a live edit — the tabula's baseHash lesson).
// ============================================================================

import { randomBytes } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../envUtils.js'
import { projectSlug, sanitizePath } from '../sessionStoragePortable.js'

export interface SavedPromptV1 {
  id: string
  /** The operator's words, verbatim. Only the operator's own edit changes this. */
  text: string
  /** Minerva's refinement — advisory, rendered beside the original. */
  refinedText?: string
  /** When the refinement beside it landed (ISO). */
  refinedAt?: string
  createdAt: string
  updatedAt: string
}

export interface SavedPromptsFile {
  /** Display order — the operator's reorder IS the array order. */
  drafts: SavedPromptV1[]
}

/** Bounded list — the notebook is a shelf of prompts, not an archive. */
export const MAX_SAVED_PROMPTS = 200
/** One saved prompt's byte-honest ceiling (the composer caps input here). */
export const MAX_SAVED_PROMPT_CHARS = 4000

/** The store root: `<configHome>/saved-prompts` (the config home moves with
 *  MERCURY_CONFIG_DIR, which is how proofs stay off the operator's list). */
export function savedPromptsRoot(): string {
  return join(getMercuryHome(), 'saved-prompts')
}

/** One file per project — the transcript store's INJECTIVE slug (sanitised
 *  spelling + short content hash). The bare sanitiser folded all punctuation
 *  to one hyphen, so two projects differing only in punctuation shared one
 *  saved-prompts file while /workbench printed "kept per project" (FC-008).
 *  A pre-hash file is adopted once by RENAME: the first project to touch it
 *  claims it (they shared it before; the rename unshackles the sibling,
 *  which starts fresh under its own slug). */
export function savedPromptsPath(projectPath: string): string {
  const canonical = projectPath.normalize('NFC')
  const hashed = join(savedPromptsRoot(), `${projectSlug(canonical)}.json`)
  if (!existsSync(hashed)) {
    const legacy = join(savedPromptsRoot(), `${sanitizePath(canonical)}.json`)
    if (existsSync(legacy)) {
      try {
        renameSync(legacy, hashed)
      } catch {
        // Raced by a sibling process or unwritable root: the hashed path
        // stands (absent ⇒ the store's documented empty list).
      }
    }
  }
  return hashed
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function sanitizeDraft(raw: unknown): SavedPromptV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Partial<SavedPromptV1>
  if (typeof d.id !== 'string' || d.id.length === 0) return null
  if (typeof d.text !== 'string') return null
  const createdAt = isIso(d.createdAt) ? d.createdAt : new Date(0).toISOString()
  const out: SavedPromptV1 = {
    id: d.id,
    text: d.text.slice(0, MAX_SAVED_PROMPT_CHARS),
    createdAt,
    updatedAt: isIso(d.updatedAt) ? d.updatedAt : createdAt,
  }
  if (typeof d.refinedText === 'string' && d.refinedText.trim().length > 0) {
    out.refinedText = d.refinedText.slice(0, MAX_SAVED_PROMPT_CHARS)
    if (isIso(d.refinedAt)) out.refinedAt = d.refinedAt
  }
  return out
}

const store = defineStore<SavedPromptsFile, [projectPath: string]>({
  name: 'saved-prompts',
  path: (projectPath: string) => savedPromptsPath(projectPath),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as { drafts?: unknown }
    if (!Array.isArray(r.drafts)) return null
    const seen = new Set<string>()
    const drafts: SavedPromptV1[] = []
    for (const entry of r.drafts) {
      const d = sanitizeDraft(entry)
      if (!d || seen.has(d.id)) continue
      seen.add(d.id)
      drafts.push(d)
    }
    return { drafts: drafts.slice(0, MAX_SAVED_PROMPTS) }
  },
  empty: () => ({ drafts: [] }),
  onReadFailure: 'empty',
})

/** A short, collision-safe id (the tabula's note-id shape). */
export function newSavedPromptId(): string {
  return randomBytes(3).toString('hex')
}

/** Collapse a composed line to the one-line shape the list renders — CR/LF
 *  become spaces (the composer is single-line; a pasted paragraph keeps its
 *  words), trimmed, capped. Empty ⇒ '' (the caller refuses it). */
export function normalizeSavedPromptText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim().slice(0, MAX_SAVED_PROMPT_CHARS)
}

export type SavedPromptsReceipt =
  | { ok: true; id: string }
  | { ok: false; reason: string }

/** The list as it stands on disk (ENOENT ⇒ empty). */
export async function listSavedPrompts(projectPath: string): Promise<SavedPromptV1[]> {
  return (await store(projectPath).read()).drafts
}

/** Append a new saved prompt at the END of the list (newest at the bottom —
 *  the receipt-roll order every tab of the panel shares). */
export async function addSavedPrompt(projectPath: string, rawText: string): Promise<SavedPromptsReceipt> {
  const text = normalizeSavedPromptText(rawText)
  if (text.length === 0) return { ok: false, reason: 'an empty prompt is nothing to save' }
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    if (current.drafts.length >= MAX_SAVED_PROMPTS) {
      return { next: current, result: { ok: false as const, reason: `the list holds ${MAX_SAVED_PROMPTS} prompts — delete one first` } }
    }
    const now = new Date().toISOString()
    const id = newSavedPromptId()
    const draft: SavedPromptV1 = { id, text, createdAt: now, updatedAt: now }
    return { next: { drafts: [...current.drafts, draft] }, result: { ok: true as const, id } }
  })
}

/** The operator's own edit — the ONE writer of `text`. A refinement beside
 *  the old wording is dropped with it (see the header). */
export async function editSavedPrompt(projectPath: string, id: string, rawText: string): Promise<SavedPromptsReceipt> {
  const text = normalizeSavedPromptText(rawText)
  if (text.length === 0) return { ok: false, reason: 'an empty prompt is nothing to keep — d deletes it' }
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    const i = current.drafts.findIndex(d => d.id === id)
    if (i < 0) return { next: current, result: { ok: false as const, reason: 'that saved prompt is gone' } }
    const live = current.drafts[i]!
    if (live.text === text) return { next: current, result: { ok: true as const, id } }
    const edited: SavedPromptV1 = {
      id: live.id,
      text,
      createdAt: live.createdAt,
      updatedAt: new Date().toISOString(),
    }
    const drafts = current.drafts.slice()
    drafts[i] = edited
    return { next: { drafts }, result: { ok: true as const, id } }
  })
}

export async function deleteSavedPrompt(projectPath: string, id: string): Promise<SavedPromptsReceipt> {
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    if (!current.drafts.some(d => d.id === id)) {
      return { next: current, result: { ok: false as const, reason: 'that saved prompt is gone' } }
    }
    return { next: { drafts: current.drafts.filter(d => d.id !== id) }, result: { ok: true as const, id } }
  })
}

/** The clear-all (sheet line 7c): the whole list goes, behind the surface's
 *  own confirm — this door never asks; the confirm is the panel's. Answers
 *  how many it cleared (0 on an already-empty list). */
export async function clearSavedPrompts(projectPath: string): Promise<{ ok: true; cleared: number }> {
  return store(projectPath).update<{ ok: true; cleared: number }>(current => ({
    next: { drafts: [] },
    result: { ok: true as const, cleared: current.drafts.length },
  }))
}

/** Move one saved prompt up (-1) or down (+1) by one slot; a move past
 *  either end is a no-op that still answers ok (nothing to repair). */
export async function moveSavedPrompt(projectPath: string, id: string, delta: -1 | 1): Promise<SavedPromptsReceipt> {
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    const i = current.drafts.findIndex(d => d.id === id)
    if (i < 0) return { next: current, result: { ok: false as const, reason: 'that saved prompt is gone' } }
    const j = i + delta
    if (j < 0 || j >= current.drafts.length) return { next: current, result: { ok: true as const, id } }
    const drafts = current.drafts.slice()
    const [moved] = drafts.splice(i, 1)
    drafts.splice(j, 0, moved!)
    return { next: { drafts }, result: { ok: true as const, id } }
  })
}

/**
 * Minerva's ONE writer: land a refinement BESIDE the original. `baseText` is
 * the wording the refinement was written against — a live text that no
 * longer matches means the operator edited meanwhile, and the stale polish
 * is refused rather than shadowing their words. The original is never
 * touched by this path, by construction.
 */
export async function refineSavedPrompt(
  projectPath: string,
  id: string,
  refinedRaw: string,
  baseText: string,
): Promise<SavedPromptsReceipt> {
  const refinedText = normalizeSavedPromptText(refinedRaw)
  if (refinedText.length === 0) return { ok: false, reason: 'an empty refinement lands nothing' }
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    const i = current.drafts.findIndex(d => d.id === id)
    if (i < 0) return { next: current, result: { ok: false as const, reason: 'that saved prompt is gone' } }
    const live = current.drafts[i]!
    if (live.text !== baseText) {
      return { next: current, result: { ok: false as const, reason: 'the prompt changed since Minerva read it — ask again' } }
    }
    if (live.refinedText === refinedText) return { next: current, result: { ok: true as const, id } }
    const drafts = current.drafts.slice()
    drafts[i] = { ...live, refinedText, refinedAt: new Date().toISOString() }
    return { next: { drafts }, result: { ok: true as const, id } }
  })
}

/** Drop the refinement beside a saved prompt (the operator's discard). */
export async function discardSavedPromptRefinement(projectPath: string, id: string): Promise<SavedPromptsReceipt> {
  return store(projectPath).update<SavedPromptsReceipt>(current => {
    const i = current.drafts.findIndex(d => d.id === id)
    if (i < 0) return { next: current, result: { ok: false as const, reason: 'that saved prompt is gone' } }
    const live = current.drafts[i]!
    if (live.refinedText === undefined) return { next: current, result: { ok: true as const, id } }
    const { refinedText: _r, refinedAt: _a, ...rest } = live
    const drafts = current.drafts.slice()
    drafts[i] = rest
    return { next: { drafts }, result: { ok: true as const, id } }
  })
}

// ── the live snapshot for React (useSyncExternalStore) ──────────────────────
//
// One cached list per project; the first subscriber opens the kernel's
// watcher (cross-process publishes repaint too — Minerva's room and the
// panel are two surfaces over one file), the last closes it. `null` = not
// read yet (the panel paints 'loading…', never a fabricated empty list).
//
// A DAMAGED file is surfaced, never swallowed: the kernel's subscribe emits
// nothing over a recoverable store (it never fabricates a value), so the
// snapshot would sit on 'reading…' for ever. The first subscriber also asks
// readResult(), and a `recoverable` answer lands as the cell's PROBLEM (the
// kernel's reason) beside an empty list — the surfaces say the file could
// not be read; the next write starts fresh and the kernel keeps the damaged
// copy beside the file (quarantine). A later good emission clears it.

type Cached = { drafts: SavedPromptV1[] | null; problem: string | null; listeners: Set<() => void>; stop: (() => void) | null }
const cache = new Map<string, Cached>()
const NO_DRAFTS: SavedPromptV1[] = []

function cell(projectPath: string): Cached {
  let c = cache.get(projectPath)
  if (!c) {
    c = { drafts: null, problem: null, listeners: new Set(), stop: null }
    cache.set(projectPath, c)
  }
  return c
}

export function getSavedPromptsSnapshot(projectPath: string): SavedPromptV1[] | null {
  return cell(projectPath).drafts
}

/** The kernel's reason when the file on disk could not be read (null = the
 *  file is readable or absent). Surfaces beside the snapshot so a damaged
 *  store is said out loud, never painted as 'reading…' or as an empty list. */
export function getSavedPromptsProblem(projectPath: string): string | null {
  return cell(projectPath).problem
}

export function subscribeSavedPrompts(projectPath: string, listener: () => void): () => void {
  const c = cell(projectPath)
  c.listeners.add(listener)
  if (c.stop === null) {
    c.stop = store(projectPath).subscribe(value => {
      c.drafts = value.drafts
      c.problem = null
      for (const l of c.listeners) l()
    })
    void store(projectPath)
      .readResult()
      .then(rr => {
        if (rr.state !== 'recoverable' || c.stop === null) return
        c.problem = rr.reason
        if (c.drafts === null) c.drafts = NO_DRAFTS
        for (const l of c.listeners) l()
      })
      .catch(() => {
        /* the subscribe path reports its own failures */
      })
  }
  return () => {
    c.listeners.delete(listener)
    if (c.listeners.size === 0 && c.stop) {
      c.stop()
      c.stop = null
    }
  }
}

/** Proof seam: forget the cached snapshots (a fresh subscriber re-reads). */
export function _resetSavedPromptsCacheForProofs(): void {
  for (const c of cache.values()) c.stop?.()
  cache.clear()
}

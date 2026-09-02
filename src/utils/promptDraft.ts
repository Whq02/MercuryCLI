// ============================================================================
//  promptDraft — durable per-(project, session) prompt drafts (mercury-feel
// DoD: "prompt text, cursor position, mode, and pasted-reference
//  metadata survive session switches, modal round-trips, process
//  interruption, and relaunch until submit or explicit discard").
//
//  One JSON file per project under <configHome>/drafts/, holding a bounded
//  map sessionId → draft. Writes ride the fileStore kernel (locked RMW +
//  atomic publish — two Mercurys on the same project write DIFFERENT
//  sessions' drafts into ONE file safely); the boot-time seed is a plain
//  sync read (useState initializers can't await).
//
//  Lifecycle contract:
//    · saveDraftDebounced coalesces typing (400ms) and captures the OWNING
//      session id at edit time — a pending save flushes to the session the
//      keystrokes belonged to even if the operator switches mid-debounce.
//    · An EMPTY draft (no text, no pastes) DELETES the entry: submit clears
//      the prompt, so a submitted draft can never resurrect; an explicit
//      manual clear discards the same way.
//    · Bounded to the newest MAX_DRAFTS sessions per project.
//    · A draft too large to persist (pathological paste) keeps the TEXT and
//      drops oversized pasted payloads, recording their labels in
//      `missingPastes` so the restore can say precisely what's gone.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../substrate/fileStore.js'
import type { PastedContent } from './config.js'
import { getMercuryHome } from './envUtils.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'

export interface PromptDraft {
  text: string
  cursorOffset: number
  mode: string
  pastedContents: Record<number, PastedContent>
  /** Labels of pasted payloads that were too large to persist. */
  missingPastes?: string[]
  savedAt: number
}

type DraftFile = Record<string, PromptDraft>

const MAX_DRAFTS = 20
/** Per-draft serialized budget — beyond this the pastes are shed. */
const MAX_DRAFT_BYTES = 262_144
const SAVE_DEBOUNCE_MS = 400

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

function draftFilePath(): string {
  return join(getMercuryHome(), 'drafts', `${projectKey()}.json`)
}

function sanitizeDraft(raw: unknown): PromptDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Partial<PromptDraft>
  if (typeof d.text !== 'string' || typeof d.savedAt !== 'number') return null
  return {
    text: d.text,
    cursorOffset: typeof d.cursorOffset === 'number' ? d.cursorOffset : d.text.length,
    mode: typeof d.mode === 'string' ? d.mode : 'prompt',
    pastedContents:
      d.pastedContents && typeof d.pastedContents === 'object' ? (d.pastedContents as Record<number, PastedContent>) : {},
    ...(Array.isArray(d.missingPastes) ? { missingPastes: d.missingPastes.filter(x => typeof x === 'string') } : {}),
    savedAt: d.savedAt,
  }
}

const draftStore = defineStore<DraftFile>({
  name: 'prompt-drafts',
  path: () => draftFilePath(),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out: DraftFile = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k === '_v') continue
      const d = sanitizeDraft(v)
      if (d) out[k] = d
    }
    return out
  },
  empty: () => ({}),
  onReadFailure: 'empty',
})

/** Shed oversized pasted payloads, keeping the text + honest labels. */
function boundDraft(draft: PromptDraft): PromptDraft {
  try {
    if (JSON.stringify(draft).length <= MAX_DRAFT_BYTES) return draft
  } catch {
    /* unserializable paste content — shed below */
  }
  const missing: string[] = []
  for (const [k, p] of Object.entries(draft.pastedContents)) {
    const label = p?.type === 'image' ? `pasted image #${k}` : `pasted text #${k}`
    missing.push(label)
  }
  return {
    ...draft,
    pastedContents: {},
    missingPastes: [...(draft.missingPastes ?? []), ...missing],
  }
}

const isEmptyDraft = (d: { text: string; pastedContents: Record<number, PastedContent> }): boolean =>
  d.text.trim() === '' && Object.keys(d.pastedContents).length === 0

/** CONTENT equality — everything except `savedAt` (the field home hit
 *  `_rev` 616 while carrying ONE stale two-character draft; every boot
 *  re-saved identical content with a fresh timestamp and the kernel dutifully
 *  published it — the revision must move only on content change). */
const draftContentEqual = (a: PromptDraft, b: PromptDraft): boolean =>
  a.text === b.text &&
  a.cursorOffset === b.cursorOffset &&
  a.mode === b.mode &&
  JSON.stringify(a.pastedContents) === JSON.stringify(b.pastedContents) &&
  JSON.stringify(a.missingPastes ?? []) === JSON.stringify(b.missingPastes ?? [])

// ── debounced write-through ──────────────────────────────────────────────────
type PendingSave = { sessionId: string; draft: PromptDraft; filePath: string }
let pending: PendingSave | null = null
let timer: ReturnType<typeof setTimeout> | null = null

async function flushPending(): Promise<void> {
  const p = pending
  pending = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!p) return
  try {
    await draftStore().mutate(current => {
      const next: DraftFile = { ...current }
      if (isEmptyDraft(p.draft)) {
        if (!(p.sessionId in next)) return current // no-op (same ref ⇒ no publish)
        delete next[p.sessionId]
        return next
      }
      const bounded = boundDraft(p.draft)
      const existing = current[p.sessionId]
      if (existing && draftContentEqual(existing, bounded)) {
        return current // identical content ⇒ no publish, no revision bump
      }
      next[p.sessionId] = bounded
      // Bound: newest MAX_DRAFTS by savedAt.
      const keys = Object.keys(next).sort((a, b) => (next[b]?.savedAt ?? 0) - (next[a]?.savedAt ?? 0))
      for (const k of keys.slice(MAX_DRAFTS)) delete next[k]
      return next
    })
  } catch (e) {
    // A failed flush is a silent loss of the operator's words (a read-only
    // home, a held lock, a vanished directory): name it in the debug log.
    logForDebugging(`[promptDraft] flush failed for ${p.sessionId.slice(0, 8)}: ${String(e)}`, { level: 'warn' })
  }
}

/**
 * Coalesced draft save. Captures the session id NOW (at the edit), so a
 * pending save that flushes after a session switch still lands on the
 * session the keystrokes belonged to.
 */
export function saveDraftDebounced(sessionId: string | null | undefined, draft: Omit<PromptDraft, 'savedAt'>): void {
  if (!sessionId) return
  // A pending save for a DIFFERENT session flushes immediately — never
  // drop the outgoing session's last keystrokes on a fast switch.
  if (pending && pending.sessionId !== sessionId) void flushPending()
  pending = { sessionId, draft: { ...draft, savedAt: Date.now() }, filePath: draftFilePath() }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flushPending(), SAVE_DEBOUNCE_MS)
  timer.unref?.()
}

/** Flush any pending save NOW (exit paths, pre-switch). */
export function flushDraftSaves(): Promise<void> {
  return flushPending()
}

/**
 * Cancel the pending debounced save (submit path). MUST run before
 * deleteDraft on submit: a pending keystroke save that flushed after the
 * delete would resurrect the just-submitted draft. A modal/local-JSX submit
 * also unmounts PromptInput in the SAME commit that clears the input, so
 * the empty-save effect never fires there — the submit chokepoint owns the
 * clear deterministically instead (measured: the party-board fixture's
 * '/party' draft survived its child and prefilled the NEXT session's
 * prompt as '/party/party').
 */
export function cancelPendingDraftSave(): void {
  pending = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Delete a session's draft (explicit discard; submit uses the empty-draft
 *  path through saveDraftDebounced instead). */
export function deleteDraft(sessionId: string | null | undefined): void {
  if (!sessionId) return
  void draftStore()
    .mutate(current => {
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    .catch(() => {})
}

/**
 * Sync draft read for BOOT-time useState seeds (initializers can't await).
 * Same sanitize path as the store decode; fail-soft to null.
 */
export function readDraftSync(sessionId: string | null | undefined): PromptDraft | null {
  if (!sessionId) return null
  try {
    const p = draftFilePath()
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    return sanitizeDraft(parsed[sessionId]) ?? null
  } catch {
    return null
  }
}

// ── B1: scoped composer documents (the board slot's per-scope
// drafts). A SIBLING store on the same kernel — never a second writer into
// the main draft entry (two writers over one session record would
// last-writer-clobber each other's fields). Documents are owner-reference
// values (composer-document.ts), so entries stay small by construction;
// the same lifecycle laws hold: an EMPTY document deletes its scope, a
// session is bounded to its live scopes, restore is a plain sync read. ──

import type { ComposerDocument } from '../input-core/composer-document.js'

type ScopedDocsFile = Record<string, Record<string, ComposerDocument> | Record<string, number>>

function scopedDocsPath(): string {
  return join(getMercuryHome(), 'drafts', `${projectKey()}-scoped.json`)
}

const scopedStore = defineStore<ScopedDocsFile>({
  name: 'scoped-composer-docs',
  path: () => scopedDocsPath(),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out: ScopedDocsFile = {}
    for (const [sid, scopes] of Object.entries(raw as Record<string, unknown>)) {
      if (sid === '_v') continue
      if (sid === '_touched') {
        ;(out as Record<string, unknown>)._touched = scopes
        continue
      }
      if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) continue
      const clean: Record<string, ComposerDocument> = {}
      for (const [scope, doc] of Object.entries(scopes as Record<string, unknown>)) {
        const d = doc as ComposerDocument
        if (!d || d.v !== 1 || typeof d.body !== 'string' || !Array.isArray(d.items)) continue
        clean[scope] = d
      }
      if (Object.keys(clean).length > 0) out[sid] = clean
    }
    return out
  },
  encode: v => v as unknown as Record<string, unknown>,
  empty: () => ({}),
  onReadFailure: 'empty',
})

/** Bounded to the newest sessions, like the sibling main-draft store. */
const MAX_SCOPED_SESSIONS = 20

let scopedPending: { sessionId: string; docs: Map<string, ComposerDocument> } | null = null
let scopedTimer: ReturnType<typeof setTimeout> | null = null

async function flushScopedPending(): Promise<void> {
  const pending = scopedPending
  scopedPending = null
  if (scopedTimer) {
    clearTimeout(scopedTimer)
    scopedTimer = null
  }
  if (!pending) return
  try {
    await scopedStore().update(cur => {
      const next: ScopedDocsFile = { ...cur }
      const scopes = { ...((next[pending.sessionId] as Record<string, ComposerDocument> | undefined) ?? {}) }
      let changed = false
      for (const doc of pending.docs.values()) {
        if (doc.body === '' && doc.items.length === 0) {
          if (doc.scope in scopes) {
            delete scopes[doc.scope]
            changed = true
          }
        } else if (JSON.stringify(scopes[doc.scope]) !== JSON.stringify(doc)) {
          scopes[doc.scope] = doc
          changed = true
        }
      }
      // identical content ⇒ no publish, no revision bump (same-ref
      // no-op contract) — the sibling main-draft store's law.
      if (!changed) return { next: cur, result: undefined }
      const touched = { ...((next._touched as Record<string, number> | undefined) ?? {}) }
      if (Object.keys(scopes).length === 0) {
        delete next[pending.sessionId]
        delete touched[pending.sessionId]
      } else {
        next[pending.sessionId] = scopes
        touched[pending.sessionId] = Date.now()
      }
      // Recency bound (review: the store was unbounded and orphaned entries
      // across session-id regeneration) — keep the newest sessions only.
      const sids = Object.keys(next).filter(k => k !== '_touched')
      if (sids.length > MAX_SCOPED_SESSIONS) {
        sids
          .sort((a, b) => (touched[a] ?? 0) - (touched[b] ?? 0))
          .slice(0, sids.length - MAX_SCOPED_SESSIONS)
          .forEach(sid => {
            delete next[sid]
            delete touched[sid]
          })
      }
      ;(next as Record<string, unknown>)._touched = touched
      return { next, result: undefined }
    })
  } catch (e) {
    // A failed draft save must never break the composer (review: the
    // rejection was unhandled at both call sites).
    const { logForDebugging } = await import('./debug.js')
    logForDebugging(`[promptDraft] scoped-doc save failed (kept in memory): ${e}`)
  }
}

/** Persist one scope's document — DEBOUNCED (400ms, the sibling store's
 *  cadence; review: an un-debounced locked RMW ran per keystroke). An empty
 *  document deletes its scope: a submitted composer can never resurrect. */
export function saveScopedDoc(
  sessionId: string | null | undefined,
  doc: ComposerDocument,
): Promise<void> {
  if (!sessionId) return Promise.resolve()
  if (scopedPending && scopedPending.sessionId !== sessionId) void flushScopedPending()
  if (!scopedPending) scopedPending = { sessionId, docs: new Map() }
  scopedPending.docs.set(doc.scope, doc)
  if (scopedTimer) clearTimeout(scopedTimer)
  scopedTimer = setTimeout(() => void flushScopedPending(), SAVE_DEBOUNCE_MS)
  scopedTimer.unref?.()
  return Promise.resolve()
}

/** Flush NOW (submit/unmount paths and the prover). */
export function flushScopedDocSaves(): Promise<void> {
  return flushScopedPending()
}

/** Sync restore for mount-time seeds (initializers can't await). Fail-soft. */
export function readScopedDocsSync(
  sessionId: string | null | undefined,
): Record<string, ComposerDocument> | null {
  if (!sessionId) return null
  try {
    const p = scopedDocsPath()
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    if (sessionId === '_touched') return null
    const scopes = parsed[sessionId]
    if (!scopes || typeof scopes !== 'object') return null
    return scopes as Record<string, ComposerDocument>
  } catch {
    return null
  }
}

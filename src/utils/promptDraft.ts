
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
  missingPastes?: string[]
  savedAt: number
}

type DraftFile = Record<string, PromptDraft>

const MAX_DRAFTS = 20
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

function boundDraft(draft: PromptDraft): PromptDraft {
  try {
    if (JSON.stringify(draft).length <= MAX_DRAFT_BYTES) return draft
  } catch {
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

const draftContentEqual = (a: PromptDraft, b: PromptDraft): boolean =>
  a.text === b.text &&
  a.cursorOffset === b.cursorOffset &&
  a.mode === b.mode &&
  JSON.stringify(a.pastedContents) === JSON.stringify(b.pastedContents) &&
  JSON.stringify(a.missingPastes ?? []) === JSON.stringify(b.missingPastes ?? [])

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
        if (!(p.sessionId in next)) return current
        delete next[p.sessionId]
        return next
      }
      const bounded = boundDraft(p.draft)
      const existing = current[p.sessionId]
      if (existing && draftContentEqual(existing, bounded)) {
        return current
      }
      next[p.sessionId] = bounded
      const keys = Object.keys(next).sort((a, b) => (next[b]?.savedAt ?? 0) - (next[a]?.savedAt ?? 0))
      for (const k of keys.slice(MAX_DRAFTS)) delete next[k]
      return next
    })
  } catch (e) {
    logForDebugging(`[promptDraft] flush failed for ${p.sessionId.slice(0, 8)}: ${String(e)}`, { level: 'warn' })
  }
}

export function saveDraftDebounced(sessionId: string | null | undefined, draft: Omit<PromptDraft, 'savedAt'>): void {
  if (!sessionId) return
  if (pending && pending.sessionId !== sessionId) void flushPending()
  pending = { sessionId, draft: { ...draft, savedAt: Date.now() }, filePath: draftFilePath() }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flushPending(), SAVE_DEBOUNCE_MS)
  timer.unref?.()
}

export function flushDraftSaves(): Promise<void> {
  return flushPending()
}

export function cancelPendingDraftSave(): void {
  pending = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

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
      if (!changed) return { next: cur, result: undefined }
      const touched = { ...((next._touched as Record<string, number> | undefined) ?? {}) }
      if (Object.keys(scopes).length === 0) {
        delete next[pending.sessionId]
        delete touched[pending.sessionId]
      } else {
        next[pending.sessionId] = scopes
        touched[pending.sessionId] = Date.now()
      }
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
    const { logForDebugging } = await import('./debug.js')
    logForDebugging(`[promptDraft] scoped-doc save failed (kept in memory): ${e}`)
  }
}

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

export function flushScopedDocSaves(): Promise<void> {
  return flushScopedPending()
}

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

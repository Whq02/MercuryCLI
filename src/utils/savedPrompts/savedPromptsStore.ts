
import { randomBytes } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../envUtils.js'
import { projectSlug, sanitizePath } from '../sessionStoragePortable.js'

export interface SavedPromptV1 {
  id: string
  text: string
  refinedText?: string
  refinedAt?: string
  createdAt: string
  updatedAt: string
}

export interface SavedPromptsFile {
  drafts: SavedPromptV1[]
}

export const MAX_SAVED_PROMPTS = 200
export const MAX_SAVED_PROMPT_CHARS = 4000

export function savedPromptsRoot(): string {
  return join(getMercuryHome(), 'saved-prompts')
}

export function savedPromptsPath(projectPath: string): string {
  const canonical = projectPath.normalize('NFC')
  const hashed = join(savedPromptsRoot(), `${projectSlug(canonical)}.json`)
  if (!existsSync(hashed)) {
    const legacy = join(savedPromptsRoot(), `${sanitizePath(canonical)}.json`)
    if (existsSync(legacy)) {
      try {
        renameSync(legacy, hashed)
      } catch {
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

export function newSavedPromptId(): string {
  return randomBytes(3).toString('hex')
}

export function normalizeSavedPromptText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim().slice(0, MAX_SAVED_PROMPT_CHARS)
}

export type SavedPromptsReceipt =
  | { ok: true; id: string }
  | { ok: false; reason: string }

export async function listSavedPrompts(projectPath: string): Promise<SavedPromptV1[]> {
  return (await store(projectPath).read()).drafts
}

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

export async function clearSavedPrompts(projectPath: string): Promise<{ ok: true; cleared: number }> {
  return store(projectPath).update<{ ok: true; cleared: number }>(current => ({
    next: { drafts: [] },
    result: { ok: true as const, cleared: current.drafts.length },
  }))
}

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

export function _resetSavedPromptsCacheForProofs(): void {
  for (const c of cache.values()) c.stop?.()
  cache.clear()
}

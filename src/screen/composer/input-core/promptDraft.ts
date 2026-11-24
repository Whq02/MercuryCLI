
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../../platform/substrate/fileStore.js'
import type { PastedContent } from '../../../platform/settings/config.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { errorMessage, isENOENT } from '../../../platform/errors/errors.js'
import { getProjectDir } from '../../../sessions/transcripts/paths.js'

interface PromptDraft {
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
  } catch (error) {
    passedOver(error)
  }
  const missing: string[] = []
  const kept: Record<number, PastedContent> = {}
  for (const [k, p] of Object.entries(draft.pastedContents)) {
    if (p?.type === 'text' && typeof p.contentHash === 'string' && p.contentHash !== '') {
      kept[Number(k)] = { id: p.id, type: 'text', content: '', contentHash: p.contentHash }
      continue
    }
    const label = p?.type === 'image' ? `pasted image #${k}` : `pasted text #${k}`
    missing.push(label)
  }
  return {
    ...draft,
    pastedContents: kept,
    ...(missing.length > 0 || draft.missingPastes !== undefined ? { missingPastes: [...(draft.missingPastes ?? []), ...missing] } : {}),
  }
}

export function draftPasteHashes(): Set<string> {
  const hashes = new Set<string>()
  const dir = join(getMercuryHome(), 'drafts')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch (error) {
    if (isENOENT(error)) return hashes
    throw error
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
    } catch (error) {
      if (isENOENT(error)) continue
      throw error
    }
    if (!parsed || typeof parsed !== 'object') continue
    for (const [key, raw] of Object.entries(parsed)) {
      if (key.startsWith('_')) continue
      if (file.endsWith('-scoped.json')) {
        if (!raw || typeof raw !== 'object') continue
        for (const doc of Object.values(raw as Record<string, { items?: Array<{ kind?: string; ref?: string }> }>)) {
          for (const item of doc?.items ?? []) {
            if (item.kind === 'large-paste' && typeof item.ref === 'string' && /^[0-9a-f]{16}$/.test(item.ref)) hashes.add(item.ref)
          }
        }
        continue
      }
      const draft = sanitizeDraft(raw)
      if (!draft) continue
      for (const p of Object.values(draft.pastedContents)) {
        if (p?.type === 'text' && typeof p.contentHash === 'string' && p.contentHash !== '') hashes.add(p.contentHash)
      }
    }
  }
  return hashes
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
let written: Promise<void> = Promise.resolve()
const pendingDeletes = new Set<string>()

async function unreadableExistingFile(path: string): Promise<unknown | null> {
  try {
    await readFile(path)
    return null
  } catch (error) {
    if (isENOENT(error)) return null
    return error
  }
}

function flushPending(): Promise<void> {
  const p = pending
  pending = null
  if (timer) {
    stopTimeout(timer)
    timer = null
  }
  if (p) {
    const write = writePage(p)
    written = Promise.all([written, write]).then(() => undefined)
  }
  return written
}

async function writePage(p: PendingSave): Promise<void> {
  const unread = await unreadableExistingFile(p.filePath)
  if (unread !== null) {
    passedOver(unread)
    logForDebugging(
      `[promptDraft] saved draft at ${p.filePath} could not be read (${errorMessage(unread)}), refusing to overwrite`,
      { level: 'warn' },
    )
    return
  }
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
  pendingDeletes.delete(sessionId)
  if (pending && pending.sessionId !== sessionId) void flushPending()
  pending = { sessionId, draft: { ...draft, savedAt: Date.now() }, filePath: draftFilePath() }
  if (timer) stopTimeout(timer)
  timer = startTimeout(() => void flushPending(), SAVE_DEBOUNCE_MS)
  timer.unref?.()
}

export function flushDraftSaves(): Promise<void> {
  return flushPending()
}

export function cancelPendingDraftSave(): void {
  pending = null
  if (timer) {
    stopTimeout(timer)
    timer = null
  }
}

export function deleteDraft(sessionId: string | null | undefined): void {
  if (!sessionId) return
  const targets = new Set<string>([...pendingDeletes, sessionId])
  const op = (async () => {
    const unread = await unreadableExistingFile(draftFilePath())
    if (unread !== null) throw unread
    await draftStore().mutate(current => {
      let changed = false
      const next = { ...current }
      for (const id of targets) {
        if (id in next) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
    for (const id of targets) pendingDeletes.delete(id)
  })().catch(e => {
    pendingDeletes.add(sessionId)
    logForDebugging(`[promptDraft] delete failed for ${sessionId.slice(0, 8)}, the sent draft stays stored and will be retried at the next send: ${String(e)}`, { level: 'warn' })
  })
  written = Promise.all([written, op]).then(() => undefined)
}

export function readDraftSync(sessionId: string | null | undefined): PromptDraft | null {
  if (!sessionId) return null
  const p = draftFilePath()
  try {
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    return sanitizeDraft(parsed[sessionId]) ?? null
  } catch (error) {
    passedOver(error)
    if (!isENOENT(error)) {
      logForDebugging(`[promptDraft] saved draft at ${p} could not be read (${errorMessage(error)})`, { level: 'warn' })
    }
    return null
  }
}

import { passedOver } from '../../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export async function migrateOrphanedDraft(conversationId: string, left?: string | null): Promise<boolean> {
  try {
    const p = draftFilePath()
    if (!existsSync(p)) return false
    const unread = await unreadableExistingFile(p)
    if (unread !== null) {
      passedOver(unread)
      return false
    }
    const projectDir = getProjectDir(getCwd())
    if (left && left !== conversationId && !left.startsWith('_') && !existsSync(join(projectDir, `${left}.jsonl`))) {
      let carried = false
      await draftStore().mutate(current => {
        const page = current[left]
        if (page === undefined) return current
        carried = true
        const next = { ...current }
        if (!(conversationId in next)) next[conversationId] = page
        delete next[left]
        return next
      })
      if (carried) return true
    }
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    if (sanitizeDraft(parsed[conversationId]) !== null) return false
    const orphans = Object.keys(parsed).filter(
      key => !key.startsWith('_') && sanitizeDraft(parsed[key]) !== null && !existsSync(join(projectDir, `${key}.jsonl`)),
    )
    if (orphans.length !== 1) return false
    const orphan = orphans[0]!
    await draftStore().mutate(current => {
      const page = current[orphan]
      if (page === undefined || conversationId in current) return current
      const next = { ...current, [conversationId]: page }
      delete next[orphan]
      return next
    })
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

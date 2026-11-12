import { logForDebugging } from '../debug.js'
import { SEALED_FIELD, type KeyCustody, type SealedOpen } from './sealedRecord.js'
import type { SecureStorage, SecureStorageData } from './types.js'

type Stored = Record<string, unknown>

export const REMOVED_FIELD = 'mercurySealedRemoved'

const ENTRY_MAPS: ReadonlySet<string> = new Set(['mcpOAuth', 'mcpOAuthClientConfig', 'gatewayTrust'])
const MAPS_OF_ENTRY_MAPS: ReadonlySet<string> = new Set(['extensionSecrets'])

function isRecord(value: unknown): value is Stored {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clearOf(stored: Stored): Stored {
  const clear: Stored = { ...stored }
  delete clear[SEALED_FIELD]
  delete clear[REMOVED_FIELD]
  return clear
}

export function removedOf(stored: Stored): string[][] {
  const text = stored[REMOVED_FIELD]
  if (typeof text !== 'string') return []
  let marks: unknown
  try {
    marks = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(marks)) return []
  return marks.filter(
    (mark): mark is string[] => Array.isArray(mark) && mark.length >= 1 && mark.length <= 3 && mark.every(part => typeof part === 'string'),
  )
}

function removalsBetween(before: Stored, after: Stored): string[][] {
  const gone: string[][] = []
  for (const [name, was] of Object.entries(before)) {
    const now = after[name]
    const nested = MAPS_OF_ENTRY_MAPS.has(name)
    if (!isRecord(was) || !(nested || ENTRY_MAPS.has(name))) {
      if (now === undefined) gone.push([name])
      continue
    }
    const entries = isRecord(now) ? now : {}
    for (const [key, entry] of Object.entries(was)) {
      const kept = entries[key]
      if (kept === undefined) {
        gone.push([name, key])
      } else if (nested && isRecord(entry)) {
        const inner = isRecord(kept) ? kept : {}
        for (const option of Object.keys(entry)) if (inner[option] === undefined) gone.push([name, key, option])
      }
    }
  }
  return gone
}

function marked(...lists: string[][][]): string[][] {
  const seen = new Set<string>()
  return lists.flat().filter(mark => {
    const spelling = JSON.stringify(mark)
    if (seen.has(spelling)) return false
    seen.add(spelling)
    return true
  })
}

function without(sealed: Stored, removed: string[][]): Stored {
  const kept: Stored = { ...sealed }
  for (const [name, key, option] of removed) {
    if (name === undefined) continue
    if (key === undefined) {
      delete kept[name]
      continue
    }
    const map = kept[name]
    if (!isRecord(map)) continue
    const entries: Stored = { ...map }
    if (option === undefined) {
      delete entries[key]
    } else {
      const entry = entries[key]
      if (!isRecord(entry)) continue
      const options: Stored = { ...entry }
      delete options[option]
      entries[key] = options
    }
    kept[name] = entries
  }
  return kept
}

export function foldClearOverSealed(sealed: Stored, clear: Stored, removed: string[][] = []): Stored {
  const folded: Stored = without(sealed, removed)
  for (const [name, value] of Object.entries(clear)) {
    const under = folded[name]
    if (!isRecord(under) || !isRecord(value)) {
      folded[name] = value
    } else if (ENTRY_MAPS.has(name)) {
      folded[name] = { ...under, ...value }
    } else if (MAPS_OF_ENTRY_MAPS.has(name)) {
      const secrets: Stored = { ...under }
      for (const [id, entries] of Object.entries(value)) {
        const below = secrets[id]
        secrets[id] = isRecord(below) && isRecord(entries) ? { ...below, ...entries } : entries
      }
      folded[name] = secrets
    } else {
      folded[name] = value
    }
  }
  return folded
}

export function createSealedFileStorage(file: SecureStorage, custody: KeyCustody, seals: boolean = true): SecureStorage {
  const said = new Set<string>()

  function say(line: string): void {
    if (said.has(line)) return
    said.add(line)
    logForDebugging(line, { level: 'warn' })
  }

  function unopened(why: string): void {
    say(
      `credential store: the sealed part was not opened (${why}); it is kept as it is and this session reads and writes beside it`,
    )
  }

  function openPart(part: unknown): SealedOpen {
    return typeof part === 'string' ? custody.open(part) : { ok: false, why: 'the sealed part is not text' }
  }

  function view(stored: Stored, opened: SealedOpen): SecureStorageData {
    if (!opened.ok) {
      unopened(opened.why)
      const riding: Stored = { ...stored }
      delete riding[REMOVED_FIELD]
      return riding as SecureStorageData
    }
    return foldClearOverSealed(opened.data, clearOf(stored), removedOf(stored)) as SecureStorageData
  }

  return {
    name: seals ? 'encrypted-with-plaintext-fallback' : file.name,

    read(): SecureStorageData | null {
      const stored = file.read() as Stored | null
      if (stored === null || !Object.hasOwn(stored, SEALED_FIELD)) return stored as SecureStorageData | null
      return view(stored, openPart(stored[SEALED_FIELD]))
    },

    async readAsync(): Promise<SecureStorageData | null> {
      const stored = (await file.readAsync()) as Stored | null
      if (stored === null || !Object.hasOwn(stored, SEALED_FIELD)) return stored as SecureStorageData | null
      const part = stored[SEALED_FIELD]
      return view(stored, typeof part === 'string' ? await custody.openAsync(part) : openPart(part))
    },

    update(data: SecureStorageData): { success: boolean; warning?: string; code?: string } {
      const put = (next: Stored): { success: boolean; warning?: string; code?: string } => file.update(next as SecureStorageData)
      const clean = clearOf(data as Stored)
      const stored = file.read() as Stored | null
      if (stored !== null && !Object.hasOwn(stored, SEALED_FIELD)) return put(clean)
      let body = clean
      let beside: string | undefined
      if (stored !== null) {
        const part = stored[SEALED_FIELD]
        const opened = openPart(part)
        const removed = marked(removedOf(stored), removalsBetween(clearOf(stored), clean))
        if (!opened.ok) {
          unopened(opened.why)
          return put({ ...clean, [SEALED_FIELD]: part, ...(removed.length > 0 ? { [REMOVED_FIELD]: JSON.stringify(removed) } : {}) })
        }
        if (Object.hasOwn(data, SEALED_FIELD)) body = foldClearOverSealed(opened.data, clean, removed)
        beside = part as string
      }
      if (!seals) return put(body)
      const sealed = custody.seal(body, beside)
      if (!sealed.ok) {
        say(`credential store: nothing was sealed (${sealed.why}); the credentials are written in the clear`)
        return put(body)
      }
      const result = put({ [SEALED_FIELD]: sealed.text })
      return result.success ? { success: true } : result
    },

    delete(): boolean {
      return file.delete()
    },
  }
}

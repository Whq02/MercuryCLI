import { logForDebugging } from '../debug.js'
import { SEALED_FIELD, type KeyCustody, type SealedOpen } from './sealedRecord.js'
import type { SecureStorage, SecureStorageData } from './types.js'

type Stored = Record<string, unknown>

const ENTRY_MAPS: ReadonlySet<string> = new Set(['mcpOAuth', 'mcpOAuthClientConfig', 'gatewayTrust'])

function isRecord(value: unknown): value is Stored {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clearOf(stored: Stored): Stored {
  const clear: Stored = { ...stored }
  delete clear[SEALED_FIELD]
  return clear
}

export function foldClearOverSealed(sealed: Stored, clear: Stored): Stored {
  const folded: Stored = { ...sealed }
  for (const [name, value] of Object.entries(clear)) {
    const under = folded[name]
    if (!isRecord(under) || !isRecord(value)) {
      folded[name] = value
    } else if (ENTRY_MAPS.has(name)) {
      folded[name] = { ...under, ...value }
    } else if (name === 'extensionSecrets') {
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

export function createSealedFileStorage(file: SecureStorage, custody: KeyCustody): SecureStorage {
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
      return stored as SecureStorageData
    }
    return foldClearOverSealed(opened.data, clearOf(stored)) as SecureStorageData
  }

  return {
    name: 'encrypted-with-plaintext-fallback',

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
        if (!opened.ok) {
          unopened(opened.why)
          return put({ ...clean, [SEALED_FIELD]: part })
        }
        if (Object.hasOwn(data, SEALED_FIELD)) body = foldClearOverSealed(opened.data, clean)
        beside = part as string
      }
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

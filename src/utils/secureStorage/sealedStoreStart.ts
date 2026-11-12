import { mkdirSync, realpathSync, rmdirSync, statSync, utimesSync } from 'node:fs'

import { logForDebugging } from '../debug.js'
import { getMercuryHome, withAuthScope } from '../envUtils.js'
import { lockSync } from '../lockfile.js'
import { clearOf, foldClearOverSealed, removedOf } from './sealedFileStorage.js'
import { SEALED_FIELD, type KeyCustody, type SealedOpen } from './sealedRecord.js'
import type { SecureStorage, SecureStorageData } from './types.js'

type Stored = Record<string, unknown>

type Clocks = { wall: number; mono: number }

export interface SealedStoreStart {
  file: SecureStorage
  custody: KeyCustody
  otherBuildAlive: () => Promise<string | null>
  seals?: boolean
  clocks?: () => Clocks
}

const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['sealed', 'sealed already', 'no store to seal', 'nothing in the store to seal'])

function clocksNow(): Clocks {
  return { wall: Date.now(), mono: performance.now() }
}

function lockAt(site: { dir: string; options: { realpath: false; stale: number } }): { release: () => void } | { why: string } {
  const folder = `${site.dir}.lock`
  const stamp = (): number | null => {
    try {
      return statSync(folder).mtimeMs
    } catch {
      return null
    }
  }
  let held = false
  let taken: number | null = null
  const fs = {
    mkdirSync,
    realpathSync,
    statSync,
    utimesSync,
    rmdirSync: (path: string): void => {
      if (held && (taken === null || stamp() !== taken)) return
      rmdirSync(path)
    },
  }
  try {
    const release: () => void = lockSync(site.dir, { ...site.options, fs, onCompromised: () => {} })
    taken = stamp()
    held = true
    return { release }
  } catch (error) {
    const code = (error as { code?: string }).code
    return { why: code === 'ELOCKED' ? 'the refresh lock on the home is held' : `the refresh lock on the home could not be taken (${code ?? 'unknown'})` }
  }
}

async function sealAtStart(start: SealedStoreStart, home: string, stored: Stored | null, opened: SealedOpen | null): Promise<string> {
  if (stored === null) return 'no store to seal'
  const sealedNow = Object.hasOwn(stored, SEALED_FIELD)
  if (sealedNow && (opened === null || !opened.ok)) {
    return `the sealed part was not opened (${opened === null ? 'it is not text' : opened.why}); the file is left as it is`
  }
  const clear = clearOf(stored)
  const removed = sealedNow ? removedOf(stored) : []
  const body = opened !== null && opened.ok ? foldClearOverSealed(opened.data, clear, removed) : clear
  const seals = start.seals ?? true
  let next: Stored
  let done: string
  if (!seals) {
    if (!sealedNow) return 'in the clear already, as the credential store flag asks'
    next = body
    done = 'written back in the clear, as the credential store flag asks'
  } else {
    if (Object.keys(clear).length === 0 && removed.length === 0) return sealedNow ? 'sealed already' : 'nothing in the store to seal'
    if (!sealedNow) {
      const other = await start.otherBuildAlive()
      if (other !== null) return `left plain until the next start: ${other}`
    }
    const part = stored[SEALED_FIELD]
    const sealed = await start.custody.sealAsync(body, typeof part === 'string' ? part : undefined)
    if (!sealed.ok) return `left as it is: ${sealed.why}`
    next = { [SEALED_FIELD]: sealed.text }
    done = 'sealed'
  }
  const { oauthRefreshLockSite } = await import('../auth.js')
  const clocks = start.clocks ?? clocksNow
  return withAuthScope(home, () => {
    const prepared = start.file.prepare?.(next as SecureStorageData)
    if (prepared === undefined) return 'left as it is: this store cannot write in two steps'
    if (!prepared.ok) return `left as it is: the temporary file could not be written${prepared.code === undefined ? '' : ` (${prepared.code})`}`
    try {
      const site = oauthRefreshLockSite()
      const asked = clocks()
      const lock = lockAt(site)
      if ('why' in lock) return `left as it is until the next start: ${lock.why}`
      try {
        if (JSON.stringify(start.file.read()) !== JSON.stringify(stored)) {
          return `left as it is until the next start: the file changed while ${seals ? 'the key was made' : 'it was opened'}`
        }
        const now = clocks()
        const held = Math.max(now.wall - asked.wall, now.mono - asked.mono)
        if (held > site.options.stale / 2) {
          return `left as it is until the next start: the refresh lock had been held for ${Math.round(held)} ms before the write, past half its lease of ${site.options.stale} ms`
        }
        const result = prepared.commit()
        return result.success ? done : `left as it is: the write was refused${result.code === undefined ? '' : ` (${result.code})`}`
      } finally {
        try {
          lock.release()
        } catch {
        }
      }
    } finally {
      prepared.discard()
    }
  })
}

export function startSealedStore(start: SealedStoreStart): { warmed: Promise<void>; settled: Promise<string> } {
  const home = getMercuryHome()
  const read = withAuthScope(home, async () => {
    const stored = (await start.file.readAsync()) as Stored | null
    const part = stored === null ? undefined : stored[SEALED_FIELD]
    return { stored, opened: typeof part === 'string' ? await start.custody.openAsync(part) : null }
  })
  const settled = read
    .then(({ stored, opened }) => sealAtStart(start, home, stored, opened))
    .catch((error: unknown) => `the start-up step failed: ${error instanceof Error ? error.message : String(error)}`)
  void settled.then(outcome => {
    logForDebugging(`credential store: at start, in ${home}: ${outcome}`, { level: QUIET_OUTCOMES.has(outcome) ? 'debug' : 'warn' })
  })
  return {
    warmed: read.then(
      () => undefined,
      () => undefined,
    ),
    settled,
  }
}

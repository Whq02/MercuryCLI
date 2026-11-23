import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../platform/substrate/durablePublish.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { fileNameFor, parseTopicDoc, serializeTopicDoc, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { clearMnemeUnread, recordMnemeUnread } from './mnemeUnread.js'

interface LibraryMeta {
  version: 1
  seqCounter: number
  lastConsolidatedAt: string | null
}

export function libraryMetaPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'library.json')
}

const FRESH_META: LibraryMeta = { version: 1, seqCounter: 0, lastConsolidatedAt: null }

function assertLibraryMetaReadable(dir: string): void {
  const p = libraryMetaPath(dir)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  const parsed = JSON.parse(raw) as LibraryMeta
  if (parsed && typeof parsed.seqCounter === 'number' && parsed.seqCounter >= 0) return
  throw new Error(`memory library meta unreadable at ${p}`)
}

export function readLibraryMeta(dir: string = mnemeLibraryDir()): LibraryMeta {
  const p = libraryMetaPath(dir)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (error) {
    if (isENOENT(error)) {
      clearMnemeUnread(p)
    } else {
      recordMnemeUnread(p, error)
      logForDebugging(`memory library meta unreadable at ${p}: ${String(error)}`)
    }
    passedOver(error)
    return { ...FRESH_META }
  }
  try {
    const parsed = JSON.parse(raw) as LibraryMeta
    if (parsed && typeof parsed.seqCounter === 'number' && parsed.seqCounter >= 0) {
      clearMnemeUnread(p)
      return parsed
    }
    throw new Error(`memory library meta unreadable at ${p}`)
  } catch (error) {
    recordMnemeUnread(p, error)
    logForDebugging(`memory library meta unreadable at ${p}: ${String(error)}`)
    passedOver(error)
    return { ...FRESH_META }
  }
}

export function publishLibraryFile(path: string, content: string): void {
  durableAtomicPublishSync(path, content)
}

export function writeLibraryMeta(meta: LibraryMeta, dir: string): void {
  assertLibraryMetaReadable(dir)
  publishLibraryFile(libraryMetaPath(dir), JSON.stringify(meta, null, 1))
}

function listDocs(dir: string, pattern: RegExp): MnemeTopicDoc[] {
  if (!existsSync(dir)) return []
  const out: MnemeTopicDoc[] = []
  for (const name of readdirSync(dir).filter(n => pattern.test(n)).sort()) {
    try {
      const doc = parseTopicDoc(readFileSync(join(dir, name), 'utf8'))
      if (doc) out.push(doc)
    } catch {
      logForDebugging(`memory: unreadable page ${name}`)
    }
  }
  return out
}

export function listTopicDocs(dir: string = mnemeLibraryDir()): MnemeTopicDoc[] {
  return listDocs(dir, /^topic-.*\.md$/)
}

export function listArchiveDocs(dir: string = mnemeLibraryDir()): MnemeTopicDoc[] {
  return listDocs(dir, /^archive-.*\.md$/)
}

export function writeDoc(doc: MnemeTopicDoc, dir: string): void {
  publishLibraryFile(join(dir, fileNameFor(doc)), serializeTopicDoc(doc))
}

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { fileNameFor, parseTopicDoc, serializeTopicDoc, type MnemeTopicDoc } from './mnemeTopicDocs.js'

export interface LibraryMeta {
  version: 1
  seqCounter: number
  lastConsolidatedAt: string | null
}

export function libraryMetaPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'library.json')
}

const FRESH_META: LibraryMeta = { version: 1, seqCounter: 0, lastConsolidatedAt: null }

export function readLibraryMeta(dir: string = mnemeLibraryDir()): LibraryMeta {
  let parsed: LibraryMeta | null = null
  try {
    parsed = JSON.parse(readFileSync(libraryMetaPath(dir), 'utf8')) as LibraryMeta
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed.seqCounter === 'number' && parsed.seqCounter >= 0) return parsed
  return { ...FRESH_META }
}

export function writeLibraryMeta(meta: LibraryMeta, dir: string): void {
  durableAtomicPublishSync(libraryMetaPath(dir), JSON.stringify(meta, null, 1))
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
  durableAtomicPublishSync(join(dir, fileNameFor(doc)), serializeTopicDoc(doc))
}

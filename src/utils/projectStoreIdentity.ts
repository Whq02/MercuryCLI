import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { directoryIdentity, directoryIdentityKey } from './directoryIdentity.js'

type StoreDirectoryIdentity = ReturnType<typeof directoryIdentity>

export type StoreSpellingRules = {
  fold: (dir: string) => string
  slugMatches: (name: string, spelling: string) => boolean
  spellingBody?: (name: string) => string | null
}

const SLUG_TAIL = /-[0-9a-f]{8}$/
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/
const CWD_HEAD_BYTES = 65536
const CARD_FILE = 'project.json'

export function resolveDirectoryIdentity(dir: string): StoreDirectoryIdentity {
  try {
    return directoryIdentity(dir)
  } catch {
    const canonical = dir.normalize('NFC')
    return { canonical, key: directoryIdentityKey(canonical, null), exists: false }
  }
}

export function projectDirectoryIdentity(dir: string, fold: (dir: string) => string): StoreDirectoryIdentity {
  const first = resolveDirectoryIdentity(fold(dir))
  const canonical = fold(first.canonical)
  return canonical === first.canonical ? first : resolveDirectoryIdentity(canonical)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readHead(file: string, bytes: number): string | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function cardDir(store: string): string | null {
  let text: string
  try {
    text = readFileSync(join(store, CARD_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const card = JSON.parse(text) as { dir?: unknown }
    return typeof card.dir === 'string' && card.dir.length > 0 ? card.dir : null
  } catch {
    return null
  }
}

function newestTranscriptCwd(store: string): string | null {
  let names: string[]
  try {
    names = readdirSync(store)
  } catch {
    return null
  }
  let newest: { file: string; mtime: number } | null = null
  for (const name of names) {
    if (!TRANSCRIPT_NAME.test(name)) continue
    const file = join(store, name)
    try {
      const facts = statSync(file)
      if (facts.size > 0 && (newest === null || facts.mtimeMs > newest.mtime)) newest = { file, mtime: facts.mtimeMs }
    } catch {
    }
  }
  if (newest === null) return null
  const head = readHead(newest.file, CWD_HEAD_BYTES)
  const match = head === null ? null : CWD_FIELD.exec(head)
  if (match === null) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function spellingBody(name: string, rules: StoreSpellingRules): string | null {
  return rules.spellingBody === undefined ? (SLUG_TAIL.test(name) ? name.slice(0, -9) : null) : rules.spellingBody(name)
}

function caseVariantSpelling(name: string, canonical: string, rules: StoreSpellingRules): string | null {
  const body = spellingBody(name, rules)
  if (body === null || body.length !== canonical.length) return null
  let spelling = ''
  for (let index = 0; index < canonical.length; index++) {
    const own = canonical[index]!
    const theirs = body[index]!
    if (/[a-zA-Z]/.test(own)) {
      if (theirs.toLowerCase() !== own.toLowerCase()) return null
      spelling += theirs
    } else {
      spelling += own
    }
  }
  return spelling === canonical ? null : spelling
}

function keyedBySpelling(name: string, spelling: string, rules: StoreSpellingRules): boolean {
  const folded = rules.fold(spelling.normalize('NFC'))
  if (rules.slugMatches(name, folded)) return true
  try {
    const resolved = rules.fold(realpathSync(folded).normalize('NFC'))
    return resolved !== folded && rules.slugMatches(name, resolved)
  } catch {
    return false
  }
}

function storeOwnsIdentity(store: string, name: string, identity: StoreDirectoryIdentity, rules: StoreSpellingRules): boolean {
  const recorded = cardDir(store)
  if (recorded !== null) return projectDirectoryIdentity(recorded.normalize('NFC'), rules.fold).key === identity.key
  const claims = (spelling: string): boolean =>
    keyedBySpelling(name, spelling, rules) && projectDirectoryIdentity(spelling.normalize('NFC'), rules.fold).key === identity.key
  const variant = caseVariantSpelling(name, identity.canonical, rules)
  if (variant !== null && claims(variant)) return true
  const cwd = newestTranscriptCwd(store)
  return cwd !== null && claims(cwd)
}

function olderSpellingStore(projects: string, identity: StoreDirectoryIdentity, candidate: string, rules: StoreSpellingRules): string | null {
  let names: string[]
  try {
    names = readdirSync(projects)
  } catch {
    return null
  }
  let chosen: { name: string; mtime: number } | null = null
  for (const name of names) {
    if (name === candidate || spellingBody(name, rules) === null) continue
    const store = join(projects, name)
    let facts: ReturnType<typeof statSync>
    try {
      facts = statSync(store)
    } catch {
      continue
    }
    if (!facts.isDirectory() || !storeOwnsIdentity(store, name, identity, rules)) continue
    if (chosen === null || facts.mtimeMs > chosen.mtime || (facts.mtimeMs === chosen.mtime && name < chosen.name)) chosen = { name, mtime: facts.mtimeMs }
  }
  return chosen === null ? null : join(projects, chosen.name)
}

export function resolveProjectStore(projects: string, identity: StoreDirectoryIdentity, candidate: string, rules: StoreSpellingRules): string {
  const own = join(projects, candidate)
  if (!identity.exists || isDirectory(own)) return own
  return olderSpellingStore(projects, identity, candidate, rules) ?? own
}

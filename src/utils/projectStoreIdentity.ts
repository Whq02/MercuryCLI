import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { durableAtomicPublishSync, durableTempName } from '../substrate/durablePublish.js'
import { directoryIdentity, type DirectoryIdentity } from './directoryIdentity.js'

type StoreOwner = { schema: 1; identity: string; canonical: string; store: string }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const sanitized = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '-')

export function legacyProjectSlugMatches(name: string, path: string): boolean {
  const base = sanitized(path)
  const tail = `-${sha(path).slice(0, 8)}`
  if (base.length <= 200) return name === base + tail
  return name.startsWith(`${base.slice(0, 200)}-`) && name.endsWith(tail) && /^[a-z0-9]+$/i.test(name.slice(201, -tail.length))
}

function caseSpelling(name: string, canonical: string): string | null {
  const base = sanitized(canonical)
  if (base.length > 200 || name.slice(0, -9).toLowerCase() !== base.toLowerCase()) return null
  const path = canonical.split('').map((character, index) => /[a-zA-Z]/.test(character) ? name[index] : character).join('')
  return legacyProjectSlugMatches(name, path) ? path : null
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function collision(paths: string[]): never {
  throw Object.assign(new Error(`EEXIST: ${paths.join(', ')}`), { code: 'EEXIST', paths })
}

function transcriptCwd(file: string): string | null {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(65536)
    const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8')
    const field = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1]
    return field === undefined ? null : JSON.parse(field) as string
  } finally {
    closeSync(fd)
  }
}

function ownsStore(store: string, identity: DirectoryIdentity, fold: (path: string) => string): boolean {
  const name = basename(store)
  let attributed = false
  const matches = (path: string): boolean => {
    let folded = fold(path.normalize('NFC'))
    if (!legacyProjectSlugMatches(name, folded)) {
      try {
        folded = fold(realpathSync(folded).normalize('NFC'))
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
      }
      if (!legacyProjectSlugMatches(name, folded)) return false
    }
    attributed = true
    return directoryIdentity(folded).key === identity.key
  }
  const guessed = caseSpelling(name, identity.canonical)
  if (guessed !== null && matches(guessed)) return true
  const card = readOptional(join(store, 'project.json'))
  if (card !== null) {
    const parsed = JSON.parse(card) as { dir?: unknown }
    if (typeof parsed.dir === 'string' && matches(parsed.dir)) return true
  }
  const names = readdirSync(store)
  for (const file of names) {
    if (!/^[^.]+\.jsonl$/.test(file)) continue
    const cwd = transcriptCwd(join(store, file))
    if (cwd !== null && matches(cwd)) return true
  }
  const base = sanitized(identity.canonical)
  if (!attributed && names.length > 0 && (base.length > 200 || name.slice(0, -9).toLowerCase() === base.toLowerCase())) collision([store])
  return false
}

type Inventory = { root: string; directories: Array<{ path: string; stamp: string }>; stores: string[] }
const inventories = new Map<string, Inventory>()
function directoryStamp(path: string): string {
  try {
    const file = statSync(path, { bigint: true })
    return `${file.dev}:${file.ino}:${file.mtimeNs}:${file.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function inventory(projects: string, identity: DirectoryIdentity, candidate: string, fold: (path: string) => string): string[] {
  const key = `${projects}\0${identity.key}`
  const root = directoryStamp(projects)
  const cached = inventories.get(key)
  if (cached?.root === root && cached.directories.every(dir => directoryStamp(dir.path) === dir.stamp)) return cached.stores
  let entries: string[]
  try {
    entries = readdirSync(projects)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const prefix = sanitized(identity.canonical).slice(0, 200).toLowerCase()
  const stores: string[] = []
  const directories: Inventory['directories'] = []
  for (const name of entries) {
    if (!/-[0-9a-f]{8}$/.test(name) || !name.toLowerCase().startsWith(prefix + '-')) continue
    const path = join(projects, name)
    if (!statSync(path).isDirectory()) continue
    directories.push({ path, stamp: directoryStamp(path) })
    if (name === candidate || ownsStore(path, identity, fold)) stores.push(name)
  }
  inventories.set(key, { root, directories, stores })
  return stores
}

function readOwner(file: string, identity: DirectoryIdentity): StoreOwner | null {
  const text = readOptional(file)
  if (text === null) return null
  const record = JSON.parse(text) as StoreOwner
  if (record.schema !== 1 || record.identity !== identity.key || typeof record.canonical !== 'string' || typeof record.store !== 'string' || record.store !== basename(record.store) || /[\\/]/.test(record.store) || !/-[0-9a-f]{8}$/.test(record.store)) collision([file])
  if (directoryIdentity(record.canonical).key !== identity.key) collision([file])
  return record
}

export function resolveProjectStore(projects: string, identity: DirectoryIdentity, candidate: string, fold: (path: string) => string): string {
  if (!identity.exists) return join(projects, candidate)
  const mapping = join(dirname(projects), 'project-identities', `${sha(identity.key)}.json`)
  const previous = readOwner(mapping, identity)
  const stores = inventory(projects, identity, candidate, fold)
  if (stores.length > 1 || (previous !== null && stores.some(store => store !== previous.store))) collision(stores.map(store => join(projects, store)))
  if (previous !== null) return join(projects, previous.store)
  if (stores.length === 0) return join(projects, candidate)
  const owner: StoreOwner = { schema: 1, identity: identity.key, canonical: identity.canonical, store: stores[0]! }
  const pending = durableTempName(mapping)
  try {
    durableAtomicPublishSync(pending, JSON.stringify(owner), { mode: 0o600 })
    try {
      linkSync(pending, mapping)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const winner = readOwner(mapping, identity)
      if (winner === null || winner.store !== owner.store) collision([mapping, join(projects, owner.store)])
    }
  } finally {
    try { unlinkSync(pending) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  try {
    const directory = openSync(dirname(mapping), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch (error) {
    if (process.platform !== 'win32' && !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  return join(projects, owner.store)
}

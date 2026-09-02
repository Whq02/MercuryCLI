
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { binaryName } from './config.js'
import { getMercuryHome } from './envUtils.js'

export interface RealmEntry {
  id: string
  name: string
  dir: string
  addedAt: string
  lastIssuedAt?: string
  issuedCount?: number
}

export interface RealmLedgerRow {
  at: string
  realm: string
  note: string
}

interface RealmRegistryFile {
  version: 1
  realms: RealmEntry[]
  ledger: RealmLedgerRow[]
}

export interface RealmRegistrySnapshot {
  state: 'live' | 'unavailable'
  realms: RealmEntry[]
  ledger: RealmLedgerRow[]
  reason?: string
}

const LEDGER_CAP = 50

export function realmRegistryPath(): string {
  return join(getMercuryHome(), 'realms.json')
}

function emptyFile(): RealmRegistryFile {
  return { version: 1, realms: [], ledger: [] }
}

function expandHome(p: string): string {
  if (p === '~') return homedir().normalize('NFC')
  if (p.startsWith('~/')) return join(homedir(), p.slice(2)).normalize('NFC')
  return p.normalize('NFC')
}

function tildify(p: string): string {
  const hd = homedir()
  return p.startsWith(hd) ? `~${p.slice(hd.length)}` || '~' : p
}

export function isUnderHomeRoot(p: string, home: string, platform: string = process.platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/')
  const n = fold(p)
  const h = fold(home)
  return n === h || n.startsWith(h + '/')
}

export function readRealmRegistry(): RealmRegistrySnapshot {
  const path = realmRegistryPath()
  if (!existsSync(path)) return { state: 'live', realms: [], ledger: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RealmRegistryFile>
    const realms = Array.isArray(parsed.realms)
      ? parsed.realms.filter(
          (r): r is RealmEntry =>
            !!r &&
            typeof r === 'object' &&
            typeof (r as RealmEntry).id === 'string' &&
            typeof (r as RealmEntry).name === 'string' &&
            typeof (r as RealmEntry).dir === 'string' &&
            typeof (r as RealmEntry).addedAt === 'string',
        )
      : []
    const ledger = Array.isArray(parsed.ledger)
      ? parsed.ledger.filter(
          (l): l is RealmLedgerRow =>
            !!l && typeof l === 'object' && typeof (l as RealmLedgerRow).at === 'string' && typeof (l as RealmLedgerRow).note === 'string',
        )
      : []
    return { state: 'live', realms, ledger }
  } catch (e) {
    return { state: 'unavailable', realms: [], ledger: [], reason: `registry unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function writeRegistry(file: RealmRegistryFile): void {
  durableAtomicPublishSync(realmRegistryPath(), JSON.stringify(file, null, 2) + '\n')
}

function pushLedger(file: RealmRegistryFile, realm: string, note: string): void {
  file.ledger.unshift({ at: new Date().toISOString(), realm, note })
  if (file.ledger.length > LEDGER_CAP) file.ledger.length = LEDGER_CAP
}

export type RealmOpResult = { ok: true; realm: RealmEntry; message: string } | { ok: false; reason: string }

export function findRealm(realms: RealmEntry[], key: string): RealmEntry | undefined {
  const k = key.trim()
  return (
    realms.find(r => r.id === k) ??
    realms.find(r => r.name === k) ??
    (() => {
      const hits = realms.filter(r => r.name.startsWith(k))
      return hits.length === 1 ? hits[0] : undefined
    })()
  )
}

export function addRealm(rawDir: string): RealmOpResult {
  const dir = resolve(expandHome(rawDir.trim()))
  const home = homedir().normalize('NFC')
  if (!isUnderHomeRoot(dir, home)) {
    return { ok: false, reason: `blocked — ${tildify(dir)} is outside your home root; realm trust is home-rooted` }
  }
  if (dir === home) {
    return { ok: false, reason: 'blocked — the home root itself cannot be a realm; pick a project folder' }
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, reason: `not a folder on disk: ${tildify(dir)}` }
  }
  const snap = readRealmRegistry()
  if (snap.state === 'unavailable') return { ok: false, reason: snap.reason ?? 'registry unreadable' }
  if (snap.realms.some(r => resolve(r.dir) === dir)) {
    return { ok: false, reason: `already a realm: ${tildify(dir)}` }
  }
  const name = basename(dir) || dir
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'realm'}-${createHash('sha256').update(dir).digest('hex').slice(0, 4)}`
  const realm: RealmEntry = {
    id,
    name,
    dir,
    addedAt: new Date().toISOString(),
  }
  const file: RealmRegistryFile = { ...emptyFile(), realms: [...snap.realms, realm], ledger: snap.ledger }
  pushLedger(file, name, `trusted · ${tildify(dir)}`)
  writeRegistry(file)
  return { ok: true, realm, message: `realm trusted: ${name} · ${tildify(dir)}` }
}

export function revokeRealm(key: string): RealmOpResult {
  const snap = readRealmRegistry()
  if (snap.state === 'unavailable') return { ok: false, reason: snap.reason ?? 'registry unreadable' }
  const realm = findRealm(snap.realms, key)
  if (!realm) return { ok: false, reason: `no realm matches '${key}'` }
  const file: RealmRegistryFile = { version: 1, realms: snap.realms.filter(r => r.id !== realm.id), ledger: snap.ledger }
  pushLedger(file, realm.name, 'revoked · files stay on disk')
  writeRegistry(file)
  return { ok: true, realm, message: `revoked ${realm.name} — registry entry only; your files stay on disk, nothing was deleted` }
}

export function realmLaunchCommand(realm: RealmEntry): string {
  return `cd ${tildify(realm.dir)} && ${binaryName()}`
}

export function recordRealmLaunchIssued(key: string): RealmOpResult {
  const snap = readRealmRegistry()
  if (snap.state === 'unavailable') return { ok: false, reason: snap.reason ?? 'registry unreadable' }
  const realm = findRealm(snap.realms, key)
  if (!realm) return { ok: false, reason: `no realm matches '${key}'` }
  const next: RealmEntry = {
    ...realm,
    lastIssuedAt: new Date().toISOString(),
    issuedCount: (realm.issuedCount ?? 0) + 1,
  }
  const file: RealmRegistryFile = { version: 1, realms: snap.realms.map(r => (r.id === realm.id ? next : r)), ledger: snap.ledger }
  pushLedger(file, realm.name, 'launch command issued')
  writeRegistry(file)
  return { ok: true, realm: next, message: realmLaunchCommand(next) }
}

export function realmGitBranch(dir: string): string | undefined {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    if (m) return m[1]
    return head.slice(0, 7) || undefined
  } catch {
    return undefined
  }
}

export function parseGitHubSource(raw: string): { url: string; name: string } | undefined {
  const s = raw.trim()
  const m =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(s)
  if (!m) return undefined
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, name: m[2]! }
}

export type RealmCloneResult = { ok: true; realm: RealmEntry; message: string } | { ok: false; reason: string }

export async function cloneRealm(rawSource: string, rawTarget?: string): Promise<RealmCloneResult> {
  const src = parseGitHubSource(rawSource)
  if (!src) return { ok: false, reason: `unrecognized GitHub source '${rawSource}' — use https://github.com/owner/repo, git@github.com:owner/repo, or owner/repo` }
  const home = homedir().normalize('NFC')
  const fallbackParent = existsSync(join(home, 'Developer')) ? join(home, 'Developer') : home
  const target = resolve(expandHome((rawTarget ?? join(fallbackParent, src.name)).trim()))
  if (!isUnderHomeRoot(target, home)) {
    return { ok: false, reason: `blocked — ${tildify(target)} is outside your home root; realm trust is home-rooted` }
  }
  if (existsSync(target)) return { ok: false, reason: `target already exists: ${tildify(target)}` }

  const { execFile } = await import('node:child_process')
  const run = (cmd: string, args: string[]): Promise<{ ok: boolean; err?: string }> =>
    new Promise(resolvePromise => {
      execFile(cmd, args, { windowsHide: true, timeout: 180_000 }, (error, _stdout, stderr) => {
        resolvePromise(error ? { ok: false, err: (stderr || error.message).slice(0, 300) } : { ok: true })
      })
    })

  const ghAuthed = await run('gh', ['auth', 'status']).then(r => r.ok).catch(() => false)
  const res = ghAuthed
    ? await run('gh', ['repo', 'clone', src.url, target])
    : await run('git', ['clone', '--', src.url, target])
  if (!res.ok) {
    return {
      ok: false,
      reason: `clone failed · ${res.err ?? 'unknown error'}${ghAuthed ? '' : ' · private repo? run: gh auth login'}`,
    }
  }
  const added = addRealm(target)
  if (!added.ok) return { ok: false, reason: `cloned to ${tildify(target)} but registry add failed: ${added.reason}` }
  return { ok: true, realm: added.realm, message: `cloned + trusted: ${added.realm.name} · ${tildify(target)} — enter it from /realms` }
}

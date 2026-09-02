// ============================================================================
//  realmRegistry — the REAL realm backend.
//
//  A *realm* = a trusted project folder the operator enters to start a
//  session. This module
//  is the local registry that spec gated everything on: one JSON file inside
//  the RESOLVED config home (getMercuryHome — the one
//  store), read/written atomically, degrade-to-state on every failure.
//
//  Contracts (from the spec):
//   • HOME-ROOTED TRUST: a realm dir must live inside the operator's home —
//     an outside-home path is REFUSED ('blocked ◉'), never registered.
//   • REVOCATION-ONLY REMOVAL: revoking edits the registry; files on disk
//     are never touched. Copy must say so every time.
//   • HONEST LAUNCH: Mercury does not replace the running session — entering
//     a realm hands over the EXACT launch command; the ledger records that
//     the command was ISSUED (never fabricates a session having run).
//  (The per-realm launch-account pin RETIRED with the station
//  roster — the account-slot simplification. A stale
//  accountId in an existing realms.json parses and is ignored; the launch
//  command carries no config-dir override.)
//   • No fabricated liveness: the registry stores what happened (added,
//     issued, revoked) — agent clusters / git status are NOT stored here.
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { binaryName } from './config.js'
import { getMercuryHome } from './envUtils.js'

export interface RealmEntry {
  /** Stable id: slug of the basename + 4-hex dir hash (collision-proof). */
  id: string
  /** Display name (folder basename at add time). */
  name: string
  /** ABSOLUTE realm dir (NFC). Display code tildifies. */
  dir: string
  addedAt: string
  /** Last time a launch command was ISSUED for this realm (never implies the
   *  command was run — honest-state). */
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
  /** 'live' — file read (or absent ⇒ empty registry, still live: the backend
   *  exists now). 'unavailable' — file present but unreadable/corrupt. */
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

/** Expand a leading '~' against the live home; NFC like the config resolver. */
function expandHome(p: string): string {
  if (p === '~') return homedir().normalize('NFC')
  if (p.startsWith('~/')) return join(homedir(), p.slice(2)).normalize('NFC')
  return p.normalize('NFC')
}

function tildify(p: string): string {
  const hd = homedir()
  return p.startsWith(hd) ? `~${p.slice(hd.length)}` || '~' : p
}

/** win32-safe home-root test (TASK-017 supplement S1, the L3 class): on
 *  win32 resolve() returns native backslash paths, so the old
 *  `home + '/'` prefix guard was satisfiable only on POSIX — /realms add
 *  and clone refused every folder there while tildify matched the same
 *  path, so the refusal printed `~\…` while claiming it was outside home.
 *  Separators fold to '/', and win32 folds case (its filesystems do).
 *  `platform` is injectable for the cross-platform pin only. */
export function isUnderHomeRoot(p: string, home: string, platform: string = process.platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/')
  const n = fold(p)
  const h = fold(home)
  return n === h || n.startsWith(h + '/')
}

/** Read the registry file, shape-validating every row (a malformed file
 *  degrades to 'unavailable'; a missing file is the EMPTY live registry). */
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

/** Durable publication: collision-free temp + fsync + atomic
 *  rename + win32 bounded retry — never a torn registry, never a shared
 *  `.tmp-<pid>` temp between two same-process writers. */
function writeRegistry(file: RealmRegistryFile): void {
  durableAtomicPublishSync(realmRegistryPath(), JSON.stringify(file, null, 2) + '\n')
}

function pushLedger(file: RealmRegistryFile, realm: string, note: string): void {
  file.ledger.unshift({ at: new Date().toISOString(), realm, note })
  if (file.ledger.length > LEDGER_CAP) file.ledger.length = LEDGER_CAP
}

export type RealmOpResult = { ok: true; realm: RealmEntry; message: string } | { ok: false; reason: string }

/** Find by id OR name (exact, then unique prefix). */
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

/** Trust + register a realm folder. HOME-ROOTED enforcement lives here. */
export function addRealm(rawDir: string): RealmOpResult {
  const dir = resolve(expandHome(rawDir.trim()))
  const home = homedir().normalize('NFC')
  // Home-rooted trust (spec: outside-home ◉ refused, not browsable). The
  // config home itself and its store files are NOT a project realm.
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

/** Revoke a realm — REGISTRY-ONLY. Files stay on disk, and the copy says so. */
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

/** The exact launch command for a realm — the honest handover (Mercury never
 *  replaces the running session). No config-dir override: the launched
 *  session resolves its own home (an operator who wants a different estate
 *  env-pins MERCURY_CONFIG_DIR themselves). */
export function realmLaunchCommand(realm: RealmEntry): string {
  return `cd ${tildify(realm.dir)} && ${binaryName()}`
}

/** Record that a launch command was ISSUED (handed to the operator). Never
 *  claims a session ran — the ledger note says exactly what happened. */
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

/** Cheap, honest git-branch probe: parse .git/HEAD directly (no subprocess on
 *  a render path). Returns undefined when the dir is not a git worktree or
 *  HEAD is unreadable; a detached HEAD reads as the short sha. */
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

/** Parse a GitHub source into { canonical clone URL, repo name }. Closed input
 *  surface: https://github.com/o/r(.git), git@github.com:o/r(.git), or the
 *  o/r shorthand. Anything else is refused (never free-typed into a spawn). */
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

/** Clone a GitHub repo into a home-rooted folder and register it as a realm.
 *  Uses `gh repo clone` when the gh CLI is authenticated (covers private
 *  repos), else plain `git clone` (public repos need no token — private ones
 *  get the honest enabler in the failure text). Never a token in argv. */
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

  // gh when authenticated (private repos ride the existing gh auth); plain
  // git clone otherwise — public repos need no token.
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

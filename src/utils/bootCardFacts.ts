
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { subscribeCwdState } from '../bootstrap/state.js'
import { initializeProjectLocalEstate } from '../services/projectLocal/paths.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { getCwd } from './cwd.js'
import { PROJECT_CONFIG_DIR_NAMES } from './projectConfig.js'
import { getProjectsDir } from './sessionStorage/paths.js'
import { getProjectDir } from './sessionStoragePortable.js'

export interface BootProjectFact {
  dir: string
  base: string
  ageMs: number
  sessionId: string | null
  transcriptPath: string | null
  firstChatAt: number | null
  firstSessionId: string | null
}

export interface BootCardFacts {
  cwdProject: BootProjectFact | null
  recentLast: BootProjectFact | null
  pickerProjects: BootProjectFact[]
}

export interface ProjectIdentity {
  dir: string
  name: string
  key: string
  catalogued: boolean
  firstChatAt: number | null
  newestChat: { sessionId: string; transcriptPath: string; ageMs: number } | null
}

function readHead(file: string, n = 4096): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(n)
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (r <= 0) break
      got += r
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const normPath = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/')
function isTmpPath(p: string): boolean {
  const n = normPath(p)
  const tmpN = tmpdir() ? normPath(tmpdir()).replace(/\/+$/, '') : ''
  return (
    n.startsWith('/tmp/') ||
    n.startsWith('/private/tmp/') ||
    n.startsWith('/private/var/folders/') ||
    (tmpN !== '' && (n === tmpN || n.startsWith(tmpN + '/')))
  )
}

export function projectDisplayName(dir: string): string {
  const base = basename(dir)
  if ((PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(base)) {
    const parent = basename(dirname(dir))
    if (parent.length > 0 && parent !== base) return parent
  }
  return base.length > 0 ? base : dir
}

export function workedInProjects(excludeSessionId?: string): BootProjectFact[] {
  try {
    return scanWorkedInProjects(excludeSessionId)
  } catch {
    return []
  }
}

export function scanBootCardFacts(cwd: string = process.cwd(), excludeSessionId?: string): BootCardFacts {
  const empty: BootCardFacts = { cwdProject: null, recentLast: null, pickerProjects: [] }
  try {
    const seen = scanWorkedInProjects(excludeSessionId)
    const resumable = seen.filter(s => s.sessionId !== null)
    return {
      cwdProject: resumable.find(s => s.dir === cwd) ?? null,
      recentLast: resumable[0] ?? null,
      pickerProjects: seen.filter(s => s.dir !== cwd),
    }
  } catch {
    return empty
  }
}

const HUSK_WALK = 4
const HUSK_MAX_BYTES = 64 * 1024
export function isAuthFailureHusk(file: string, size: number): boolean {
  if (size > HUSK_MAX_BYTES) return false
  try {
    const text = readHead(file, HUSK_MAX_BYTES)
    let outputs = 0
    for (const line of text.split('\n')) {
      if (!line.includes('"kind":"output"')) continue
      outputs += 1
      if (!line.includes('"error":"authentication_failed"')) return false
    }
    return outputs > 0
  } catch {
    return false
  }
}


export const PROJECT_CARD_FILE = 'project.json'

interface ProjectCard {
  schema: 1
  dir: string
  firstChatAt: number
  firstSessionId: string
}

function readProjectCard(store: string): ProjectCard | null {
  try {
    const raw = JSON.parse(readFileSync(join(store, PROJECT_CARD_FILE), 'utf8')) as Partial<ProjectCard>
    if (raw.schema !== 1 || typeof raw.dir !== 'string' || raw.dir.length === 0 || typeof raw.firstChatAt !== 'number') return null
    return {
      schema: 1,
      dir: raw.dir,
      firstChatAt: raw.firstChatAt,
      firstSessionId: typeof raw.firstSessionId === 'string' ? raw.firstSessionId : '',
    }
  } catch {
    return null
  }
}

interface StoreDirFacts {
  card: ProjectCard | null
  newest: { file: string; mtime: number } | null
}

function readStoreDirFacts(store: string, skip: string | null): StoreDirFacts | null {
  let names: string[]
  try {
    names = readdirSync(store)
  } catch {
    return null
  }
  const card = names.includes(PROJECT_CARD_FILE) ? readProjectCard(store) : null
  const candidates: Array<{ file: string; mtime: number; size: number }> = []
  for (const f of names) {
    if (!f.endsWith('.jsonl') || f === skip) continue
    try {
      const st = statSync(join(store, f))
      candidates.push({ file: join(store, f), mtime: st.mtimeMs, size: st.size })
    } catch {
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  let picked: { file: string; mtime: number } | null = null
  for (const c of candidates.slice(0, HUSK_WALK)) {
    if (isAuthFailureHusk(c.file, c.size)) continue
    picked = c
    break
  }
  if (picked === null && candidates.length > HUSK_WALK) picked = candidates[HUSK_WALK] ?? null
  if (picked === null && card === null) return null
  return { card, newest: picked }
}

function sessionIdOf(file: string): string {
  const fname = basename(file)
  return fname.endsWith('.jsonl') ? fname.slice(0, -'.jsonl'.length) : fname
}

function transcriptCwd(file: string): string | null {
  try {
    const head = readHead(file)
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
    if (m) return JSON.parse('"' + m[1] + '"') as string
  } catch {
  }
  return null
}


export interface ParkedSessionFact {
  sessionId: string
  transcriptPath: string
  ageMs: number
}

export const PARKED_CAP = 10

export const PARKED_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function projectChatCount(projectDir: string, opts: { excludeSessionId?: string } = {}): number {
  try {
    const home = getProjectDir(projectDir)
    const skip = opts.excludeSessionId ? `${opts.excludeSessionId}.jsonl` : null
    let n = 0
    for (const f of readdirSync(home)) {
      if (!f.endsWith('.jsonl') || f === skip) continue
      try {
        if (statSync(join(home, f)).size > 0) n++
      } catch {
      }
    }
    return n
  } catch {
    return 0
  }
}

export function parkedSessionsOf(
  projectDir: string,
  opts: { excludeSessionId?: string; cap?: number; withinMs?: number; nowMs?: number } = {},
): ParkedSessionFact[] {
  try {
    const home = getProjectDir(projectDir)
    const skip = opts.excludeSessionId ? `${opts.excludeSessionId}.jsonl` : null
    const cap = Math.max(0, opts.cap ?? PARKED_CAP)
    const since = opts.withinMs !== undefined ? (opts.nowMs ?? Date.now()) - opts.withinMs : Number.NEGATIVE_INFINITY
    const candidates: Array<{ file: string; mtime: number; size: number }> = []
    for (const f of readdirSync(home)) {
      if (!f.endsWith('.jsonl') || f === skip) continue
      try {
        const st = statSync(join(home, f))
        if (st.size > 0 && st.mtimeMs >= since) candidates.push({ file: join(home, f), mtime: st.mtimeMs, size: st.size })
      } catch {
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    const out: ParkedSessionFact[] = []
    for (const c of candidates.slice(0, cap + HUSK_WALK)) {
      if (isAuthFailureHusk(c.file, c.size)) continue
      out.push({ sessionId: sessionIdOf(c.file), transcriptPath: c.file, ageMs: Date.now() - c.mtime })
      if (out.length >= cap) break
    }
    return out
  } catch {
    return []
  }
}

export const BOOT_SCAN_DIR_CAP = 128

export function capDirsByRecency(
  names: readonly string[],
  mtimeOf: (name: string) => number,
  cap: number = BOOT_SCAN_DIR_CAP,
): string[] {
  if (names.length <= cap) return [...names]
  return names
    .map(name => {
      let m = 0
      try {
        m = mtimeOf(name)
      } catch {
      }
      return { name, m }
    })
    .sort((a, b) => b.m - a.m)
    .slice(0, cap)
    .map(e => e.name)
}

function scanWorkedInProjects(excludeSessionId?: string): BootProjectFact[] {
  const root = getProjectsDir()
  const skip = excludeSessionId ? `${excludeSessionId}.jsonl` : null
  const perDir: Array<{ facts: StoreDirFacts; mtime: number }> = []
  for (const d of capDirsByRecency(readdirSync(root), name => statSync(join(root, name)).mtimeMs)) {
    const facts = readStoreDirFacts(join(root, d), skip)
    if (facts === null) continue
    perDir.push({ facts, mtime: Math.max(facts.newest?.mtime ?? 0, facts.card?.firstChatAt ?? 0) })
  }
  perDir.sort((a, b) => b.mtime - a.mtime)
  const homeIsTmp = isTmpPath(root + '/')
  const seen: BootProjectFact[] = []
  for (const e of perDir.slice(0, 32)) {
    const sessionCwd = e.facts.card?.dir ?? (e.facts.newest !== null ? transcriptCwd(e.facts.newest.file) : null)
    if (!sessionCwd) continue
    if (!homeIsTmp && isTmpPath(sessionCwd)) continue
    try {
      if (!statSync(sessionCwd).isDirectory()) continue
    } catch {
      continue
    }
    if (seen.some(s => s.dir === sessionCwd)) continue
    const newest = e.facts.newest
    seen.push({
      dir: sessionCwd,
      base: projectDisplayName(sessionCwd),
      ageMs: Date.now() - e.mtime,
      sessionId: newest !== null ? sessionIdOf(newest.file) : null,
      transcriptPath: newest !== null ? newest.file : null,
      firstChatAt: e.facts.card?.firstChatAt ?? null,
      firstSessionId: e.facts.card !== null && e.facts.card.firstSessionId.length > 0 ? e.facts.card.firstSessionId : null,
    })
    if (seen.length >= 10) break
  }
  return seen
}


export function projectIdentity(dir: string): ProjectIdentity {
  const key = getProjectDir(dir)
  let facts: StoreDirFacts | null = null
  try {
    facts = readStoreDirFacts(key, null)
  } catch {
    facts = null
  }
  const newest = facts?.newest ?? null
  return {
    dir,
    name: projectDisplayName(dir),
    key,
    catalogued: facts !== null,
    firstChatAt: facts?.card?.firstChatAt ?? null,
    newestChat:
      newest !== null
        ? { sessionId: sessionIdOf(newest.file), transcriptPath: newest.file, ageMs: Date.now() - newest.mtime }
        : null,
  }
}

function canonicalGroundSpelling(dir: string): { path: string; canonicalized: boolean } {
  const folded = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const spelling = folded.length > 0 ? folded : '/'
  try {
    return { path: realpathSync(spelling).replace(/\\/g, '/').normalize('NFC'), canonicalized: true }
  } catch {
  }
  let head = spelling
  const tail: string[] = []
  for (;;) {
    const cut = head.lastIndexOf('/')
    if (cut <= 0) break
    tail.unshift(head.slice(cut + 1))
    head = head.slice(0, cut)
    try {
      return { path: [realpathSync(head).replace(/\\/g, '/'), ...tail].join('/').normalize('NFC'), canonicalized: false }
    } catch {
    }
  }
  return { path: spelling.normalize('NFC'), canonicalized: false }
}

const CATALOGED_GROUND_TTL_MS = 2_000
const catalogedGroundCache = new Map<string, { at: number; generation: number; answer: boolean }>()

function isCatalogedGround(canonicalDir: string): boolean {
  const now = Date.now()
  const hit = catalogedGroundCache.get(canonicalDir)
  if (hit !== undefined && hit.generation === catalogGeneration && now - hit.at < CATALOGED_GROUND_TTL_MS) return hit.answer
  let answer = false
  let decided = false
  try {
    answer = readStoreDirFacts(getProjectDir(canonicalDir), null) !== null
    decided = true
  } catch {
    answer = false
  }
  if (decided) catalogedGroundCache.set(canonicalDir, { at: now, generation: catalogGeneration, answer })
  return answer
}

export function workspaceRecognizedByGround(groundDir: string, workspaceDir: string): boolean {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) return false
  if (typeof groundDir !== 'string' || groundDir.length === 0) return false
  try {
    if (getProjectDir(workspaceDir) === getProjectDir(groundDir)) return true
  } catch {
    return false
  }
  const ws = canonicalGroundSpelling(workspaceDir)
  const ground = canonicalGroundSpelling(groundDir)
  if (ws.path === ground.path) return true
  if (!ws.path.startsWith(`${ground.path}/`)) return false
  let dir = ws.path
  while (dir !== ground.path) {
    if (isCatalogedGround(dir)) return false
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) return false
    dir = dir.slice(0, cut)
  }
  return true
}

export function inProject(project: ProjectIdentity, workspaceDir: string): boolean {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) return false
  return workspaceRecognizedByGround(project.dir, workspaceDir)
}

const CURRENT_PROJECT_TTL_MS = 2_000
let catalogGeneration = 0
let currentCache: { cwd: string; generation: number; at: number; identity: ProjectIdentity } | null = null

export function currentProject(): ProjectIdentity {
  const cwd = getCwd()
  const now = Date.now()
  if (
    currentCache !== null &&
    currentCache.cwd === cwd &&
    currentCache.generation === catalogGeneration &&
    now - currentCache.at < CURRENT_PROJECT_TTL_MS
  ) {
    return currentCache.identity
  }
  const identity = projectIdentity(cwd)
  currentCache = { cwd, generation: catalogGeneration, at: now, identity }
  return identity
}

const catalogListeners = new Set<(project: ProjectIdentity) => void>()

export function subscribeCurrentProject(listener: (project: ProjectIdentity) => void): () => void {
  catalogListeners.add(listener)
  const offGround = subscribeCwdState(() => listener(currentProject()))
  return () => {
    catalogListeners.delete(listener)
    offGround()
  }
}

function emitCatalogChanged(): void {
  catalogGeneration += 1
  currentCache = null
  const project = currentProject()
  for (const listener of [...catalogListeners]) {
    try {
      listener(project)
    } catch {
    }
  }
}

export function catalogFirstChat(dir: string, sessionId: string): void {
  try {
    initializeProjectLocalEstate(dir)
  } catch {
  }
  try {
    const store = getProjectDir(dir)
    if (!existsSync(join(store, PROJECT_CARD_FILE))) {
      mkdirSync(store, { recursive: true })
      const card: ProjectCard = { schema: 1, dir, firstChatAt: Date.now(), firstSessionId: sessionId }
      durableAtomicPublishSync(join(store, PROJECT_CARD_FILE), JSON.stringify(card) + '\n')
    }
  } catch {
  }
  emitCatalogChanged()
}

export function _resetProjectCatalogForTesting(): void {
  catalogGeneration = 0
  currentCache = null
  catalogedGroundCache.clear()
  catalogListeners.clear()
}

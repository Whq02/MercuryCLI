// ============================================================================
//  bootCardFacts — the runtime Boot face's session-store facts, and THE ONE
//  CATALOG OWNER of Mercury's projects.
//
//  The face composes the ORIGINAL launcher card (splash-core assembleCardRows)
//  and must know its presence facts BEFORE the first paint: the one-placement
//  law byte-matches the landing's hero rows against the launcher's
//  cinematic frame, and a rows-arrive-later recompose would shift the hero at
//  the most-watched beat of the boot. So this is the launcher's own bounded
//  SYNC scan (mercury-splash.mjs scanRecentProjects — newest jsonl per
//  project dir, cwd parsed from a 4KB head read, tmp-filtered, dead-cwd
//  skipped, deduped, ≤10) mirrored onto the runtime's path owner
//  (getProjectsDir). Same store, same law, same strings — and the ONE
//  project source every listing surface renders (workedInProjects below).
//
//  THE FOLDER IS THE PROJECT (the operator's word): open a terminal in a
//  folder and run Mercury — that folder is the project, by its name, from
//  boot, with no history needed (currentProject). Nothing is written until
//  the FIRST chat is born there; that birth (switchboard/bornSession.ts, the
//  one birth door) stamps the catalog (catalogFirstChat): the folder's
//  `.mercury/` estate through the path owner, and a PROJECT CARD in the
//  folder's own session-store dir — the SAME store this scan already reads,
//  so the folder joins the selectable projects everywhere at once (the Boot
//  face's Projects rows, the concourse rail's REPO picker, the board's
//  scope) with no second list. A project's identity (name · path · key ·
//  first-chat stamp · newest chat) has ONE shape here (ProjectIdentity);
//  the board re-scopes on the beat (subscribeCurrentProject); records and
//  rows are scoped through inProject.
// ============================================================================

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
  /** Newest session id in this project dir (the jsonl basename); null for
   *  a catalogued folder whose first chat has no words yet. */
  sessionId: string | null
  /** That newest session's transcript file — the managed-resume door
   *  (focusResumedSession) reads the workspace from its head. */
  transcriptPath: string | null
  /** The first-chat stamp (the project card); null for a project that
   *  predates the catalog — it keeps its chats and its row. */
  firstChatAt: number | null
  /** The session the card was born with — the fact a card-aware hop reads
   *  when the folder's only chat is a wordless LIVE newborn (no transcript
   *  to resume, a runner to enter); null without a card. */
  firstSessionId: string | null
}

export interface BootCardFacts {
  /** The launched cwd's own newest session (K2: the launched dir wins). */
  cwdProject: BootProjectFact | null
  /** The globally newest OTHER project (the cross-repo Continue form). */
  recentLast: BootProjectFact | null
  /** Every known repo except the launched cwd, newest first (≤10). */
  pickerProjects: BootProjectFact[]
}

/** A project's identity — the ONE shape every surface derives from. */
export interface ProjectIdentity {
  /** The folder as launched or picked — the workspaceDir sessions are born
   *  in (never realpath'd: the path column's truth). */
  dir: string
  /** The display name: the folder's basename, or the PARENT's for a
   *  `.mercury` dir (projectDisplayName). */
  name: string
  /** The identity key — the project's session-store dir (realpath + NFC +
   *  the adoption ladder). Two folders are THE SAME PROJECT iff their keys
   *  are equal; inProject is the predicate. */
  key: string
  /** True once the folder is a SELECTABLE project: a first chat was born
   *  there (the card), or the store already holds its chats. */
  catalogued: boolean
  /** The first-chat stamp (ms epoch); null when never stamped — a project
   *  that predates the catalog keeps its chats and reads catalogued. */
  firstChatAt: number | null
  /** The newest chat here — the resume door's target; null before any words. */
  newestChat: { sessionId: string; transcriptPath: string; ageMs: number } | null
}

// Bounded head read: cap the disk work at the window itself —
// the "cwd" key sits in the first record's head.
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

// SCRATCH FILTER + case/sep normalization (the launcher's law):
// tmp-rooted cwds are proof debris, never operator projects — unless the
// config home ITSELF is hermetic (a tmp home = a proof world where every
// fixture cwd is tmp by construction).
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

/** THE PROJECT ROW'S NAME (ruled): a project whose directory IS a
 *  project-config home (`.mercury`) wears its PARENT folder's name —
 *  never the dot-dir's own; the full
 *  path stays visible in each surface's detail column. One naming seam
 *  for every project surface — the scan rows, the picker's boot row, the
 *  Boot face's card and Dir chip, the concourse's project label; the dir
 *  names ride the projectConfig ratchet, never re-quoted literals. */
export function projectDisplayName(dir: string): string {
  const base = basename(dir)
  if ((PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(base)) {
    const parent = basename(dirname(dir))
    if (parent.length > 0 && parent !== base) return parent
  }
  return base.length > 0 ? base : dir
}

/** THE ONE PROJECT SOURCE (coordinator-receipts, item 1):
 *  every surface that lists projects — the Boot face's Projects rows AND the
 *  concourse rail's REPO picker — renders THIS scan: the projects the
 *  product has actually worked in (the session store's newest-jsonl-per-
 *  project truth, and the catalogued folders whose first chat is born but
 *  wordless), newest first, ≤10. The picker keeps its own layout and
 *  its boot-folder row; the list beneath is the same list. Spoken-path
 *  resolution (coordinatorTools knownProjectDirs) stays a resolution aid
 *  for the coordinator's ears — it is not a surface list. */
export function workedInProjects(excludeSessionId?: string): BootProjectFact[] {
  try {
    return scanWorkedInProjects(excludeSessionId)
  } catch {
    return []
  }
}

/** The bounded sync scan (fail-soft: any error ⇒ empty facts).
 *  `excludeSessionId` skips THIS session's own file — the Continue row must
 *  offer the newest OTHER conversation (the filterResumableSessions law). */
export function scanBootCardFacts(cwd: string = process.cwd(), excludeSessionId?: string): BootCardFacts {
  const empty: BootCardFacts = { cwdProject: null, recentLast: null, pickerProjects: [] }
  try {
    const seen = scanWorkedInProjects(excludeSessionId)
    // The Continue rows RESUME a transcript: a catalogued folder whose first
    // chat has no words yet has nothing to continue — it is a Projects row,
    // never a Continue target. Otherwise the launcher's exact derivation:
    // recentLast is the globally newest entry (consulted only when the cwd
    // has no history of its own — the labeled cross-repo Continue form);
    // the picker excludes where we stand.
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

// THE GHOST-HUSK FILTER (field return F1, ruled): a signed-out FAILED run
// still mints a transcript whose assistant records ALL carry
// annotations.error === 'authentication_failed' — auth debris, never a
// resumable conversation, yet it was resolving into "Continue Last
// Session" pointing at a dead session. The scan walks past husks to the
// project's real newest session and a husks-only folder is not a worked-in
// project; the husk FILE stays on disk (forensics — only the scan skips
// it). Bounded like everything here: at most HUSK_WALK files per folder,
// at most HUSK_MAX_BYTES read each; a bigger file cannot be a husk.
const HUSK_WALK = 4
const HUSK_MAX_BYTES = 64 * 1024
/** Exported for the older-chats census (L20 — one scope truth): the count
 *  and the browse list apply THIS one husk law, never a second spelling. */
export function isAuthFailureHusk(file: string, size: number): boolean {
  if (size > HUSK_MAX_BYTES) return false
  try {
    // ≤ the cap ⇒ this reads the whole file; record lines are compact JSON
    // (JSON.stringify — no spaces), and escaped copies inside content
    // bytes spell \" so the needles cannot false-match them.
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

// ── the project card (the catalog row) ──────────────────────────────────────

/** The project card's file name — beside the transcripts in the project's
 *  own session-store dir. The launcher's mirrored scan reads the same name. */
export const PROJECT_CARD_FILE = 'project.json'

interface ProjectCard {
  schema: 1
  /** The folder as born — the row's dir; no head read needed. */
  dir: string
  /** The first-chat stamp (ms epoch). */
  firstChatAt: number
  /** The session the stamp was born with (a fact for forensics, never a
   *  resume target — its transcript may not exist). */
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
  /** The newest NON-HUSK transcript, or null (a wordless first chat, or a
   *  husks-only folder). */
  newest: { file: string; mtime: number } | null
}

/** ONE store dir's facts — the card and the newest non-husk transcript;
 *  null when the dir is unreadable or holds neither (not a project). */
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
      /* racing delete */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  // Newest NON-HUSK wins; beyond the bounded walk the newest candidate
  // stands (an over-deep walk would trade the paint budget for a case
  // that does not occur — husks come in small bursts).
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
    /* unreadable head */
  }
  return null
}

// ── the project's parked chats (the board's history rows) ───────────────────

export interface ParkedSessionFact {
  /** The transcript's session id (the jsonl basename). */
  sessionId: string
  /** The transcript file — the resume door's input. */
  transcriptPath: string
  ageMs: number
}

/** THE PER-PROJECT BOUND (the concourse-as-resume rule, 5): the Boot face's
 *  ≤10 rule is the precedent — one owner for both bounds. */
export const PARKED_CAP = 10

/** THE RECENCY TIER (operator, L11): the board's parked rows are the chats
 *  interacted with within the last WEEK (the transcript's mtime — the
 *  interaction stamp the store already carries); older chats are never
 *  removed, they collapse into one line the board paints beneath. */
export const PARKED_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** How many chats a project's store holds at all (every transcript file
 *  with bytes, the excluded file aside; husks counted — the picker shows
 *  them too). The "N older chats" line's arithmetic reads this. Fail-soft
 *  ⇒ 0. */
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
        /* racing delete */
      }
    }
    return n
  } catch {
    return 0
  }
}

/** THE CURRENT PROJECT'S PARKED CHATS (the concourse is the control plane
 *  and shows the current project's chats, not everything — the operator's
 *  word): the transcripts in ONE project's session-store dir — the
 *  identity key `inProject` compares (getProjectDir: realpath, NFC, the
 *  adoption ladder), so a symlinked spelling lists the same chats — with
 *  the same husk filter and the same ≤10 bound as the scan, newest first.
 *  `excludeSessionId` skips this screen's own file. Which sessions are
 *  LIVE (a daemon record) or CLEARED (the board's own mark) is the
 *  caller's subtraction; this lists the store's truth. The project root
 *  is the catalog door's (currentProject().dir). Fail-soft: any error ⇒
 *  no chats. */
export function parkedSessionsOf(
  projectDir: string,
  opts: { excludeSessionId?: string; cap?: number; withinMs?: number; nowMs?: number } = {},
): ParkedSessionFact[] {
  try {
    const home = getProjectDir(projectDir)
    const skip = opts.excludeSessionId ? `${opts.excludeSessionId}.jsonl` : null
    const cap = Math.max(0, opts.cap ?? PARKED_CAP)
    // The recency tier: only chats touched within `withinMs` are candidates
    // (absent ⇒ every chat, the older line's arithmetic aside).
    const since = opts.withinMs !== undefined ? (opts.nowMs ?? Date.now()) - opts.withinMs : Number.NEGATIVE_INFINITY
    const candidates: Array<{ file: string; mtime: number; size: number }> = []
    for (const f of readdirSync(home)) {
      if (!f.endsWith('.jsonl') || f === skip) continue
      try {
        const st = statSync(join(home, f))
        if (st.size > 0 && st.mtimeMs >= since) candidates.push({ file: join(home, f), mtime: st.mtimeMs, size: st.size })
      } catch {
        /* racing delete */
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    const out: ParkedSessionFact[] = []
    // The husk walk is bounded the way the scan's is: the cap plus one
    // husk allowance per slot — past that the newest candidates stand.
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

/** The scan's growth bound: at most this many store directories pay the
 *  heavy per-dir visit (readdir + a stat per .jsonl + the husk reads). The
 *  ROW caps (32/10) bounded only the output; a mature home of hundreds of
 *  project dirs paid the whole disk walk inside the Boot face's first
 *  render, before the raw-mode arm — a silent multi-second first frame
 *  (TASK-017 S2, boot-splash-uncapped-sync-store-scan). 128 matches the
 *  estate's SWEEP_DIR_CAP posture. */
export const BOOT_SCAN_DIR_CAP = 128

/** Over the cap, visit the most-recently-CHANGED dirs first (one cheap stat
 *  per dir — a new session's file creation bumps its store dir) so the cap
 *  cannot drop the newest projects; at or under the cap this is the identity
 *  and costs zero extra stats. Exported pure with an injected stat for the
 *  prover. */
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
        /* unreadable ranks last */
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
    // A row's recency is its newest activity: the newest transcript, or the
    // first-chat stamp of a folder whose chat has no words yet.
    perDir.push({ facts, mtime: Math.max(facts.newest?.mtime ?? 0, facts.card?.firstChatAt ?? 0) })
  }
  perDir.sort((a, b) => b.mtime - a.mtime)
  const homeIsTmp = isTmpPath(root + '/')
  const seen: BootProjectFact[] = []
  for (const e of perDir.slice(0, 32)) {
    // The card names the folder outright; a card-less store dir reads the
    // cwd from its newest transcript's head (the launcher's derivation).
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

// ── the identity door ───────────────────────────────────────────────────────

/** Identity of ANY folder — a pure lookup of its one store dir (no writes). */
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

/** The canonical ground spelling for the recognition walk: both separator
 *  families fold to '/' (win32 spellings flow through LogOption untouched
 *  and the pure-path algebra below is separator-anchored STRINGS, never
 *  platform path calls), trailing separators drop, realpath where the
 *  folder exists, NFC always. A spelling that cannot canonicalize still
 *  answers (the deepest existing ancestor canonicalizes and the tail
 *  re-attaches, so an alias-root raw spelling — /var/… vs /private/var/… —
 *  still lands inside the tree it names) but is marked so no cache ever
 *  freezes the miss (the key-stability law's no-freeze discipline). */
function canonicalGroundSpelling(dir: string): { path: string; canonicalized: boolean } {
  const folded = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const spelling = folded.length > 0 ? folded : '/'
  try {
    return { path: realpathSync(spelling).replace(/\\/g, '/').normalize('NFC'), canonicalized: true }
  } catch {
    /* fall through to the nearest existing ancestor */
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
      /* keep climbing */
    }
  }
  return { path: spelling.normalize('NFC'), canonicalized: false }
}

// Cataloged-ground reads ride the currentProject discipline: one bounded
// store read per (dir, catalog generation) inside a short window — the walk
// runs on paint ticks. A read that failed to resolve is answered but never
// cached (transient failures must not freeze).
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

/** THE RECOGNITION DOOR (frontier smart-recognition, operator-ruled
 *  — one law on every surface): does `workspaceDir` belong to
 *  the project whose ground is `groundDir`?
 *
 *  Two arms, in order:
 *  1. THE EXACT ARM — the keys compare (getProjectDir both sides): realpath,
 *     NFC, the config-home fold and the adoption ladder make a symlinked or
 *     `.mercury` spelling the same project and a sibling folder a different
 *     one (the concourse re-home ruling, unchanged).
 *  2. THE WALK-UP ARM — the workspace lives INSIDE the ground's tree
 *     (separator-anchored, canonical both sides) and NO cataloged ground
 *     stands strictly nearer to it: walking up from the workspace toward
 *     the ground, the first cataloged folder met claims the session, so a
 *     subfolder that is ITSELF a cataloged ground stays its own project
 *     (the nearest-root-wins carve) while an ordinary subfolder's sessions
 *     are the enclosing project's work on EVERY surface — picker, board,
 *     rails, counts. The ground's own catalog state is irrelevant: a fresh
 *     folder with no history is still the project it always was.
 *
 *  Recognition only — stores, keys and transcript homes NEVER move; the
 *  write side keeps keying each workspace to its own store. WHY this shape:
 *  the operator ruled the picker/board split closed with "whatever the
 *  frontier solution is — smart enough to recognize" the project a session
 *  was born inside; the walk-up with a nearest-root stop is that
 *  convention, and the exact-key world stays byte-identical for every
 *  stand-alone folder. */
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

/** THE SCOPING PREDICATE: does a record's or row's workspace belong to
 *  `project`? Feed it a record's ORIGIN workspace (rec.workspaceId), never
 *  a carved worktree path.
 *
 *  It IS the recognition door above (one law, one spelling): the exact key
 *  arm first — a `.mercury` config-home spelling folds to its parent
 *  exactly where the display name already does, and the resolution is
 *  stable across call order and store births (the key-stability memo) —
 *  then the walk-up arm with the nearest-root carve. Every same-join
 *  consumer inherits through THIS predicate or the same derivation: the
 *  board's row scope, foreignOf and the held/retained scopes
 *  (concourseSnapshot), projectActivity's grouping and door names,
 *  runningByProjectKey + the Boot face's runningOf pairing,
 *  crossProjectPings, the picker scan's identity, and the write side
 *  (MERCURY_SESSION_HOME, the transcript home — writes still key each
 *  workspace to its own store). The resume picker's partition
 *  (sessionFilter.isProjectSession) now answers THE SAME question through
 *  the same door — the former subtree-vs-key split is retired
 *  (frontier smart-recognition, operator-ruled). */
export function inProject(project: ProjectIdentity, workspaceDir: string): boolean {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) return false
  return workspaceRecognizedByGround(project.dir, workspaceDir)
}

// The current project is read on paint ticks: one bounded store-dir read
// per (ground, catalog generation) window. Consumers compare by key/name,
// never by reference — after the window the same facts come as a fresh
// object.
const CURRENT_PROJECT_TTL_MS = 2_000
let catalogGeneration = 0
let currentCache: { cwd: string; generation: number; at: number; identity: ProjectIdentity } | null = null

/** THE CURRENT PROJECT: the identity of the live harness ground (getCwd —
 *  the folder the terminal opened in at boot; the picked ground after a
 *  repo pick, which harnessGround moves). Never null: a folder with no
 *  history is still the project, by its name. */
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

/** The repaint beat: fires with the current identity on a ground move (the
 *  cwd-state beat) and when the catalog stamps a first chat while a board
 *  is up. Returns the unsubscribe. */
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
      /* a subscriber's failure never reaches the birth */
    }
  }
}

/** THE FIRST-CHAT STAMP — called by the one birth door (bornSession.ts)
 *  after the daemon admits a birth in `dir`, and by nothing else: the
 *  folder's `.mercury/` estate through the path owner's verb, and the
 *  project card beside its transcripts. Idempotent after the first; every
 *  arm is fail-soft — a folder that refuses the estate (the home dir, a
 *  `.mercury` root, an alias) or a store that cannot take the card leaves
 *  the birth untouched and the transcript-derived row as it was. */
export function catalogFirstChat(dir: string, sessionId: string): void {
  try {
    initializeProjectLocalEstate(dir)
  } catch {
    /* the estate is refused, never the birth */
  }
  try {
    const store = getProjectDir(dir)
    if (!existsSync(join(store, PROJECT_CARD_FILE))) {
      mkdirSync(store, { recursive: true })
      const card: ProjectCard = { schema: 1, dir, firstChatAt: Date.now(), firstSessionId: sessionId }
      durableAtomicPublishSync(join(store, PROJECT_CARD_FILE), JSON.stringify(card) + '\n')
    }
  } catch {
    /* the row stays transcript-derived */
  }
  emitCatalogChanged()
}

/** Test seam: forget the cached current project and every subscriber. */
export function _resetProjectCatalogForTesting(): void {
  catalogGeneration = 0
  currentCache = null
  catalogedGroundCache.clear()
  catalogListeners.clear()
}

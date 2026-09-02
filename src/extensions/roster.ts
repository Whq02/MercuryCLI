// ============================================================================
//  src/extensions/roster.ts — the roster: one entry per extension this
//  machine knows, from a LOCAL read only — installed.json, the project's
//  .mercury/extensions/ listing, the project's settings, the --extension
//  flag, the bundled roster. Never a source, never the network.
//
//  Shadowing (the project-over-user rule): while a session is open in a
//  project, an approved project-folder extension named x shadows an
//  installed x; a session extension shadows both; bundled is shadowed by
//  any of the three.
// ============================================================================
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getOriginalCwd, getSessionExtensions } from '../bootstrap/state.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { getSettingsForSource } from '../utils/settings/settings.js'
import { blockReason, matchBlock } from './blocklist.js'
import { bundledRoster } from './bundled/index.js'
import { readSwitch, recordBundledApproval } from './install.js'
import { contributionsHash, extensionId, readManifest, type ExtensionManifest } from './manifest.js'
import { PROJECT_EXTENSIONS_DIR } from './paths.js'
import { MERCURY_PROJECT_DIR } from '../utils/projectConfig.js'
import { readInstalled, readSources, type InstalledRecord, type SourceRecord } from './records.js'
import { compareWithCatalogue, readSourceCatalogue } from './sources.js'
import { hashTree } from './tree.js'
import type { RosterEntry, RosterSummary, TrustState } from './types.js'

export { blockReason }

// ── the running session's active set (for the pending state) ───────────────

export type ActiveSnapshot = Map<string, { version: string; contributionsHash: string }>
let activeSnapshot: ActiveSnapshot | null = null

/** The reload publishes what it swapped in; the CLI (no session) leaves it null. */
export function setActiveSnapshot(snapshot: ActiveSnapshot | null): void {
  activeSnapshot = snapshot
}

export function getActiveSnapshot(): ActiveSnapshot | null {
  return activeSnapshot
}

// ── inputs ──────────────────────────────────────────────────────────────────

export type RosterInput = {
  cwd?: string
  sessionPaths?: string[]
  /** Skip the folder-source drift hash (a cheap roster for the CLI list). */
  skipDriftHash?: boolean
}

export type RosterResult = {
  entries: RosterEntry[]
  /** Corrupt record files, one line each — /health carries them. */
  problems: string[]
}

function blank(partial: Partial<RosterEntry> & Pick<RosterEntry, 'id' | 'name' | 'label' | 'home'>): RosterEntry {
  return {
    version: '',
    description: '',
    root: null,
    manifest: null,
    manifestWarnings: [],
    manifestErrors: [],
    record: null,
    source: null,
    contributionsHash: null,
    approved: false,
    changedSinceApproval: false,
    switchedOn: false,
    switchScope: 'off',
    blockedBy: null,
    shadowedBy: null,
    pending: null,
    availableVersion: null,
    noLongerOffered: false,
    sourceRemoved: false,
    changedOnDisk: false,
    proposal: null,
    previous: null,
    bundledUpdatedWith: null,
    ...partial,
  }
}

function readFolder(entry: RosterEntry, root: string): void {
  const read = readManifest(root)
  entry.root = root
  if (read.status === 'ok') {
    entry.manifest = read.manifest
    entry.manifestWarnings = read.warnings
    entry.version = read.manifest.version
    entry.description = read.manifest.description
    entry.contributionsHash = contributionsHash(read.manifest, root)
  } else if (read.status === 'invalid') {
    entry.manifestErrors = read.errors
    entry.manifestWarnings = read.warnings
  } else {
    entry.manifestErrors = ['manifest missing']
  }
}

function applyApproval(entry: RosterEntry, record: InstalledRecord | null): void {
  entry.record = record
  if (!record?.approval) return
  if (entry.contributionsHash === null) return
  if (record.approval.contributionsHash === entry.contributionsHash) entry.approved = true
  else entry.changedSinceApproval = true
}

function applySwitch(entry: RosterEntry, defaultOn: boolean | null): void {
  const sw = readSwitch(entry.id)
  if (sw.scope !== 'off') {
    entry.switchedOn = sw.on
    entry.switchScope = sw.scope
    return
  }
  // A committed .mercury/settings.json switch is a PROPOSAL: applied only when approved here.
  if (sw.committedProposal !== null && entry.approved) {
    entry.switchedOn = sw.committedProposal
    entry.switchScope = 'project'
    return
  }
  if (defaultOn !== null) {
    entry.switchedOn = defaultOn
    entry.switchScope = defaultOn ? 'everywhere' : 'off'
  }
}

function applyBlock(entry: RosterEntry, source: SourceRecord | null): void {
  const match = matchBlock([entry.id, entry.label, source?.where ?? null, entry.proposal?.source ?? null])
  entry.blockedBy = match ? match.by : null
}

/** Whether an entry would contribute if nothing shadowed it. */
export function isActiveByRecords(entry: RosterEntry): boolean {
  return entry.approved && entry.switchedOn && entry.blockedBy === null && entry.manifest !== null && !entry.changedSinceApproval
}

/** The trust state a row paints (03 §1). */
export function trustStateOf(entry: RosterEntry): TrustState {
  if (entry.blockedBy !== null) return 'blocked'
  if (entry.home === 'proposal') return 'found'
  if (entry.home === 'project' && entry.record === null) return 'found'
  if (entry.pending !== null) return 'pending'
  if (isActiveByRecords(entry) && entry.shadowedBy === null) return 'on'
  // Approved and switched on but the copy no longer loads: an ON state
  // whose health paints ✕ broken — never a quiet ○ off.
  if (
    entry.switchedOn &&
    entry.shadowedBy === null &&
    entry.manifest === null &&
    entry.record?.approval != null &&
    !entry.changedSinceApproval
  ) {
    return 'on'
  }
  return 'off'
}

const HOME_RANK: Record<RosterEntry['home'], number> = { session: 0, project: 1, installed: 2, proposal: 3, bundled: 4 }

// ── the roster ──────────────────────────────────────────────────────────────

export function computeRoster(input: RosterInput = {}): RosterResult {
  const cwd = input.cwd ?? getOriginalCwd()
  const sessionPaths = input.sessionPaths ?? getSessionExtensions()
  const problems: string[] = []
  const entries: RosterEntry[] = []

  const installedRead = readInstalled()
  const installed = installedRead.ok ? installedRead.data : {}
  if (!installedRead.ok) problems.push(`installed.json unreadable (${installedRead.error}) — the roster reads empty until it is fixed or removed`)
  const sourcesRead = readSources()
  const sources = sourcesRead.ok ? sourcesRead.data : {}
  if (!sourcesRead.ok) problems.push(`sources.json unreadable (${sourcesRead.error}) — sources read empty until it is fixed or removed`)

  // Catalogues, read once per source (local files only).
  const catalogues = new Map<string, ReturnType<typeof readSourceCatalogue>>()
  const catalogueFor = (label: string): ReturnType<typeof readSourceCatalogue> | null => {
    const source = sources[label]
    if (!source) return null
    if (!catalogues.has(label)) catalogues.set(label, readSourceCatalogue(label, source))
    return catalogues.get(label)!
  }

  // 1. installed copies (and in-place records: project approvals).
  const projectDir = join(cwd, MERCURY_PROJECT_DIR, PROJECT_EXTENSIONS_DIR)
  for (const [id, record] of Object.entries(installed)) {
    if (record.label === 'mercury') continue // painted from the bundled roster below
    if (record.label === 'project') {
      // An in-place approval: only meaningful when the folder is this project's.
      continue
    }
    const source = sources[record.label] ?? null
    const entry = blank({ id, name: record.name, label: record.label, home: 'installed', version: record.version, source })
    if (existsSync(record.path)) readFolder(entry, record.path)
    else {
      entry.root = null
      entry.manifestErrors = [`folder missing: ${record.path}`]
    }
    entry.version = record.version
    applyApproval(entry, record)
    applySwitch(entry, null)
    applyBlock(entry, source)
    entry.previous = record.previous ? { version: record.previous.version, path: record.previous.path } : null
    entry.sourceRemoved = source === null
    if (source) {
      const read = catalogueFor(record.label)
      if (read && read.ok) {
        const { updates, delisted } = compareWithCatalogue(record.label, read.catalogue)
        const update = updates.find(u => u.id === id)
        if (update) entry.availableVersion = update.to
        if (delisted.includes(id)) entry.noLongerOffered = true
        if (!input.skipDriftHash && source.kind === 'folder' && !update && !entry.noLongerOffered) {
          const catalogueEntry = read.catalogue.extensions.find(e => e.name === record.name)
          if (catalogueEntry?.path !== undefined) {
            const dir = resolve(read.root, catalogueEntry.path)
            if (existsSync(dir) && hashTree(dir) !== record.contentHash) entry.changedOnDisk = true
          }
        }
      }
    }
    if (record.pendingUpdate) entry.availableVersion = record.pendingUpdate.version
    entries.push(entry)
  }

  // 2. the project folder: .mercury/extensions/<name>/
  if (existsSync(projectDir)) {
    let names: string[] = []
    try {
      names = readdirSync(projectDir).filter(name => {
        try {
          return statSync(join(projectDir, name)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      names = []
    }
    for (const name of names.sort()) {
      const root = join(projectDir, name)
      const id = extensionId(name, 'project')
      const entry = blank({ id, name, label: 'project', home: 'project' })
      readFolder(entry, root)
      if (entry.manifest && entry.manifest.name !== name) {
        entry.manifestErrors = [`folder ${name} holds an extension named ${entry.manifest.name} — the folder must be named after the extension`]
        entry.manifest = null
        entry.contributionsHash = null
      }
      const record = installed[id]
      applyApproval(entry, record && resolve(record.path) === resolve(root) ? record : null)
      applySwitch(entry, null)
      applyBlock(entry, null)
      entries.push(entry)
    }
  }

  // 3. session extensions: --extension <path>, approved by the flag.
  for (const path of sessionPaths) {
    const root = resolve(cwd, path)
    const name = basename(root)
    const entry = blank({ id: extensionId(name, 'session'), name, label: 'session', home: 'session' })
    readFolder(entry, root)
    if (entry.manifest) {
      entry.id = extensionId(entry.manifest.name, 'session')
      entry.name = entry.manifest.name
    }
    entry.approved = entry.manifest !== null
    entry.switchedOn = true
    entry.switchScope = 'everywhere'
    applyBlock(entry, null)
    entries.push(entry)
  }

  // 4. proposals: .mercury/settings.json → extensions.wanted (never fetched here).
  const wanted = getSettingsForSource('projectSettings')?.extensions?.wanted ?? []
  for (const proposal of wanted) {
    if (!proposal || typeof proposal.name !== 'string' || typeof proposal.source !== 'string') continue
    const alreadyHere = entries.some(e => e.name === proposal.name && (e.home === 'project' || (e.home === 'installed' && e.source?.where === proposal.source)))
    if (alreadyHere) continue
    const installedFromNamedSource = Object.entries(installed).find(([, r]) => r.name === proposal.name && r.label !== 'project' && sources[r.label]?.where === proposal.source)
    if (installedFromNamedSource) continue
    const entry = blank({ id: extensionId(proposal.name, 'project'), name: proposal.name, label: 'project', home: 'proposal', proposal: { source: proposal.source, ...(proposal.ref ? { ref: proposal.ref } : {}) } })
    entry.description = `proposed from ${proposal.source}`
    applyBlock(entry, null)
    entries.push(entry)
  }

  // 5. bundled: the roster module lists each folder; installing Mercury is the approval.
  for (const def of bundledRoster()) {
    const id = extensionId(def.name, 'mercury')
    const entry = blank({ id, name: def.name, label: 'mercury', home: 'bundled' })
    readFolder(entry, def.root)
    const record = recordBundledApproval(def.name, def.root, MERCURY_VERSION)
    applyApproval(entry, record)
    applySwitch(entry, def.defaultOn)
    applyBlock(entry, null)
    entry.bundledUpdatedWith = record?.bundledNote ?? null
    entries.push(entry)
  }

  // Shadowing: among entries active by their records, the highest-ranked home wins each name.
  const winners = new Map<string, RosterEntry>()
  for (const entry of entries) {
    if (!isActiveByRecords(entry)) continue
    const current = winners.get(entry.name)
    if (!current || HOME_RANK[entry.home] < HOME_RANK[current.home]) winners.set(entry.name, entry)
  }
  for (const entry of entries) {
    const winner = winners.get(entry.name)
    if (winner && winner !== entry && isActiveByRecords(entry)) entry.shadowedBy = winner.id
  }

  // Pending: what the records say versus what the running session swapped in.
  if (activeSnapshot !== null) {
    for (const entry of entries) {
      const live = activeSnapshot.get(entry.id)
      const wants = isActiveByRecords(entry) && entry.shadowedBy === null
      if (wants && !live) entry.pending = 'on'
      else if (!wants && live) entry.pending = 'off'
      else if (wants && live && (live.version !== entry.version || live.contributionsHash !== entry.contributionsHash)) entry.pending = 'update'
    }
  }

  entries.sort(compareEntries)
  return { entries, problems }
}

const STATE_RANK: Record<TrustState, number> = { on: 0, pending: 1, off: 2, found: 3, blocked: 4, available: 5 }

function compareEntries(a: RosterEntry, b: RosterEntry): number {
  const ra = STATE_RANK[trustStateOf(a)]
  const rb = STATE_RANK[trustStateOf(b)]
  if (ra !== rb) return ra - rb
  return a.name.localeCompare(b.name) || a.label.localeCompare(b.label)
}

/** The entries that contribute in this session: active by their records and not shadowed. */
export function activeEntries(entries: RosterEntry[]): RosterEntry[] {
  return entries.filter(e => isActiveByRecords(e) && e.shadowedBy === null)
}

export function findEntry(entries: RosterEntry[], idOrName: string): RosterEntry | undefined {
  return entries.find(e => e.id === idOrName) ?? entries.find(e => e.name === idOrName)
}

export function rosterSummary(entries: RosterEntry[], healthOutcomes: Map<string, 'loads' | 'partial' | 'broken'>, sources: number): RosterSummary {
  const summary: RosterSummary = { total: entries.length, on: 0, partial: 0, broken: 0, off: 0, pending: 0, found: 0, blocked: 0, updates: 0, sources }
  for (const entry of entries) {
    const state = trustStateOf(entry)
    if (entry.availableVersion) summary.updates++
    if (state === 'on') {
      const outcome = healthOutcomes.get(entry.id) ?? 'loads'
      if (outcome === 'loads') summary.on++
      else if (outcome === 'partial') summary.partial++
      else summary.broken++
    } else if (state === 'pending') summary.pending++
    else if (state === 'off') summary.off++
    else if (state === 'found') summary.found++
    else if (state === 'blocked') summary.blocked++
  }
  return summary
}

export type { ExtensionManifest }

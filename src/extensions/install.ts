// ============================================================================
//  src/extensions/install.ts — the acts on one extension: install, approve,
//  the switches, block, uninstall, update, previous.
//
//  The one law: an extension does nothing until the operator says so.
//  Install copies and validates; approval records the exact contributions
//  hash; the switch says "run it here"; uninstall leaves no residue. Every
//  act is an operator act — nothing here runs at boot or on a timer.
// ============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getGlobalConfig } from '../utils/config/globalConfig.js'
import { MERCURY_PROJECT_DIR } from '../utils/projectConfig.js'
import { getSettingsForSource, removeSettingsFileIfEmpty, updateSettingsForSource } from '../utils/settings/settings.js'
import { blockReason, matchBlock } from './blocklist.js'
import { entryDirectory } from './catalogue.js'
import { contributionsHash, extensionId, parseExtensionId, readManifest, type ExtensionManifest, type SwitchKind } from './manifest.js'
import { deleteOptionValues } from './options.js'
import { getExtensionDataDir, getInstalledDir, getInstalledIdDir, getInstalledVersionDir, idFolderName, VersionFolderTraversalError } from './paths.js'
import {
  defaultSwitches,
  installedOrEmpty,
  logAct,
  readInstalled,
  sourcesOrEmpty,
  updateInstalled,
  type InstalledRecord,
} from './records.js'
import { cloneRepository, copyTree, readSourceCatalogue } from './sources.js'
import { folderSize, hashTree } from './tree.js'

export type SwitchScope = 'everywhere' | 'project'

// ── install ─────────────────────────────────────────────────────────────────

export type InstallOutcome =
  | { ok: true; id: string; record: InstalledRecord; manifest: ExtensionManifest; warnings: string[]; root: string; alreadyInstalled: boolean }
  | { ok: false; reason: string }

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Install one extension from one source into installed/<id>/<version>/.
 * The destination folder is decided from the catalogue's version BEFORE
 * any fetch; a manifest disagreeing with the catalogue refuses the install
 * (the lying-catalogue case), never a silent re-key. Nothing is approved
 * or switched on here.
 */
export async function installFromSource(label: string, name: string, options: { progress?: (line: string) => void } = {}): Promise<InstallOutcome> {
  const progress = options.progress ?? (() => {})
  const sources = sourcesOrEmpty()
  const source = sources[label]
  if (!source) return { ok: false, reason: `no source named ${label}` }
  const id = extensionId(name, label)
  const blocked = matchBlock([id, label, source.where])
  if (blocked) return { ok: false, reason: blockReason(blocked) }

  const read = readSourceCatalogue(label, source)
  if (!read.ok) return { ok: false, reason: `${label}: ${read.error}` }
  const entry = read.catalogue.extensions.find(e => e.name === name)
  if (!entry) return { ok: false, reason: `${name} is not offered by ${label}` }

  const installedRead = readInstalled()
  if (!installedRead.ok) return { ok: false, reason: `installed.json is ${installedRead.error} — fix or remove it first` }
  const existing = installedRead.data[id]
  if (existing && existing.version === entry.version && existsSync(existing.path)) {
    const manifest = readManifest(existing.path)
    if (manifest.status === 'ok') {
      return { ok: true, id, record: existing, manifest: manifest.manifest, warnings: manifest.warnings, root: existing.path, alreadyInstalled: true }
    }
  }

  // The version key: decided now, before anything is fetched. A version
  // that cannot name a folder is refused HERE — before any fetch, staging
  // or delete — so a refusal changes nothing on disk.
  let destination: string
  try {
    destination = getInstalledVersionDir(id, entry.version)
  } catch (error) {
    if (error instanceof VersionFolderTraversalError) return { ok: false, reason: `${name}: ${error.message}` }
    throw error
  }
  const staging = join(getInstalledDir(), `.installing-${idFolderName(id)}-${process.pid}-${Date.now()}`)
  mkdirSync(getInstalledDir(), { recursive: true })
  let commit: string | null = null
  if (entry.git !== undefined) {
    const entryBlocked = matchBlock([entry.git])
    if (entryBlocked) return { ok: false, reason: blockReason(entryBlocked) }
    progress(`cloning ${entry.git}…`)
    const cloned = await cloneRepository(entry.git, entry.ref ?? null, staging)
    if (!cloned.ok) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, reason: cloned.reason }
    }
    commit = cloned.commit
  } else {
    const dir = entryDirectory(read.root, entry)
    if (dir === null || !existsSync(dir)) {
      return { ok: false, reason: `${label}: ${entry.path ?? name} is missing from the source` }
    }
    progress('copying…')
    try {
      copyTree(dir, staging)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, reason: `copy failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    commit = source.commit ?? null
  }

  const manifest = readManifest(staging)
  if (manifest.status !== 'ok') {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: manifest.status === 'missing' ? `${name}: no mercury-extension.json in the fetched copy` : `${name}: manifest invalid: ${manifest.errors[0] ?? 'unknown'}` }
  }
  if (manifest.manifest.name !== entry.name) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: `catalogue says ${entry.name}, manifest says ${manifest.manifest.name}` }
  }
  if (manifest.manifest.version !== entry.version) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: `catalogue says ${entry.version}, manifest says ${manifest.manifest.version}` }
  }

  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  renameSync(staging, destination)

  const hash = contributionsHash(manifest.manifest, destination)
  const record: InstalledRecord = {
    name,
    label,
    version: entry.version,
    commit,
    contentHash: hashTree(destination),
    contributionsHash: hash,
    installedAt: existing?.installedAt ?? nowIso(),
    updatedAt: nowIso(),
    path: destination,
    previous: null,
    approval: existing?.approval && existing.approval.contributionsHash === hash ? existing.approval : null,
    switches: existing?.switches ?? defaultSwitches(),
  }
  const wrote = updateInstalled(current => ({ ...current, [id]: record }))
  if (!wrote.ok) {
    rmSync(destination, { recursive: true, force: true })
    return { ok: false, reason: wrote.error }
  }
  logAct(`installed: ${id} ${entry.version} → ${destination}`)
  return { ok: true, id, record, manifest: manifest.manifest, warnings: manifest.warnings, root: destination, alreadyInstalled: false }
}

// ── approval ────────────────────────────────────────────────────────────────

export type ApproveOutcome = { ok: true; id: string; record: InstalledRecord } | { ok: false; reason: string }

/**
 * Record the approval for the copy's CURRENT contributions hash and write
 * the switch. For an in-place extension (a project folder) the record is
 * created here with the folder as its path.
 */
export function approve(id: string, options: { scope?: SwitchScope; root?: string; switchOn?: boolean } = {}): ApproveOutcome {
  const scope = options.scope ?? 'everywhere'
  const parsed = parseExtensionId(id)
  if (!parsed) return { ok: false, reason: `not an extension id: ${id}` }
  const blocked = matchBlock([id, parsed.label])
  if (blocked) return { ok: false, reason: blockReason(blocked) }
  const installed = installedOrEmpty()
  let record = installed[id]
  const root = record?.path ?? options.root
  if (!root) return { ok: false, reason: `${id} is not installed` }
  const manifest = readManifest(root)
  if (manifest.status !== 'ok') return { ok: false, reason: manifest.status === 'missing' ? `${id}: manifest missing at ${root}` : `${id}: manifest invalid: ${manifest.errors[0]}` }
  const hash = contributionsHash(manifest.manifest, root)
  const approval = { version: manifest.manifest.version, contributionsHash: hash, at: nowIso() }
  if (!record) {
    record = {
      name: manifest.manifest.name,
      label: parsed.label,
      version: manifest.manifest.version,
      commit: null,
      contentHash: hashTree(root),
      contributionsHash: hash,
      installedAt: nowIso(),
      updatedAt: nowIso(),
      path: resolve(root),
      previous: null,
      approval,
      switches: defaultSwitches(),
    }
  } else {
    record = { ...record, contributionsHash: hash, version: manifest.manifest.version, approval, updatedAt: nowIso() }
  }
  const next = record
  const wrote = updateInstalled(current => ({ ...current, [id]: next }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`approved: ${id} ${approval.version} ${hash}`)
  if (options.switchOn !== false) {
    const switched = setSwitch(id, true, scope)
    if (!switched.ok) return { ok: false, reason: switched.reason }
  }
  return { ok: true, id, record: next }
}

// ── switches ────────────────────────────────────────────────────────────────

export type SwitchOutcome = { ok: true } | { ok: false; reason: string }

/**
 * One name active at a time — between SOURCE-installed extensions. The
 * project folder and the session flag are the sanctioned overrides (they
 * SHADOW instead), and a bundled extension is shadowed by any of the
 * three, so only two source installs can genuinely collide.
 */
function sameNameEnabledElsewhere(id: string, name: string): string | null {
  const installed = installedOrEmpty()
  for (const [otherId, record] of Object.entries(installed)) {
    if (otherId === id || record.name !== name) continue
    if (record.label === 'project' || record.label === 'session' || record.label === 'mercury') continue
    if (!record.approval || record.approval.contributionsHash !== record.contributionsHash) continue
    if (readSwitch(otherId).on) return record.label
  }
  return null
}

/** The switch as the settings say for THIS project: local > committed (a proposal) > everywhere. */
export function readSwitch(id: string): { on: boolean; scope: 'everywhere' | 'project' | 'off'; committedProposal: boolean | null } {
  const local = getSettingsForSource('localSettings')?.extensions?.enabled?.[id]
  const committed = getSettingsForSource('projectSettings')?.extensions?.enabled?.[id]
  const user = getSettingsForSource('userSettings')?.extensions?.enabled?.[id]
  if (typeof local === 'boolean') return { on: local, scope: 'project', committedProposal: typeof committed === 'boolean' ? committed : null }
  if (typeof user === 'boolean') return { on: user, scope: 'everywhere', committedProposal: typeof committed === 'boolean' ? committed : null }
  return { on: false, scope: 'off', committedProposal: typeof committed === 'boolean' ? committed : null }
}

/** Turn the switch on or off in one home. Enabling is refused when blocked, unapproved, or a same-name extension is already on. */
export function setSwitch(id: string, on: boolean, scope: SwitchScope = 'everywhere'): SwitchOutcome {
  const parsed = parseExtensionId(id)
  if (!parsed) return { ok: false, reason: `not an extension id: ${id}` }
  if (on) {
    const blocked = matchBlock([id, parsed.label])
    if (blocked) return { ok: false, reason: blockReason(blocked) }
    const record = installedOrEmpty()[id]
    if (parsed.label !== 'mercury') {
      if (!record) return { ok: false, reason: `${id} is not installed` }
      if (!record.approval || record.approval.contributionsHash !== record.contributionsHash) return { ok: false, reason: 'not approved · i approves' }
    }
    if (parsed.label !== 'project' && parsed.label !== 'session' && parsed.label !== 'mercury') {
      const elsewhere = sameNameEnabledElsewhere(id, parsed.name)
      if (elsewhere) return { ok: false, reason: `${parsed.name} is already enabled from ${elsewhere}` }
    }
  }
  const source = scope === 'project' ? 'localSettings' : 'userSettings'
  const { error } = updateSettingsForSource(source, { extensions: { enabled: { [id]: on } } } as never)
  if (error) return { ok: false, reason: `settings write failed: ${error.message}` }
  logAct(`switch: ${id} ${on ? 'on' : 'off'} (${scope})`)
  return { ok: true }
}

/** Turn one contribution kind off or on for an installed extension. */
export function setKindSwitch(id: string, kind: SwitchKind, on: boolean): SwitchOutcome {
  const installed = installedOrEmpty()
  const record = installed[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const next = { ...record, switches: { ...record.switches, [kind]: on } }
  const wrote = updateInstalled(current => ({ ...current, [id]: next }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`switch: ${id} ${kind} ${on ? 'on' : 'off'}`)
  return { ok: true }
}

/** Remove the switch from BOTH homes for the current project (uninstall). */
function removeSwitchHere(id: string): void {
  for (const source of ['userSettings', 'localSettings'] as const) {
    if (getSettingsForSource(source)?.extensions?.enabled?.[id] === undefined) continue
    updateSettingsForSource(source, { extensions: { enabled: { [id]: undefined } } } as never)
  }
}

/**
 * Uninstall's tidy-up: the EMPTY husks the deletions leave ({} under
 * enabled/options/extensions) are pruned so the settings file returns to
 * its prior bytes. Only empty objects are touched — a populated block is
 * never rewritten (config is the operator's file).
 */
function pruneEmptySettings(): void {
  for (const source of ['userSettings', 'localSettings'] as const) {
    const extensions = getSettingsForSource(source)?.extensions
    if (!extensions) continue
    const prune: Record<string, undefined> = {}
    if (extensions.enabled !== undefined && Object.keys(extensions.enabled).length === 0) prune['enabled'] = undefined
    if (extensions.options !== undefined && Object.keys(extensions.options).length === 0) prune['options'] = undefined
    if (extensions.wanted !== undefined && extensions.wanted.length === 0) prune['wanted'] = undefined
    if (extensions.blocked !== undefined && extensions.blocked.length === 0) prune['blocked'] = undefined
    if (Object.keys(prune).length > 0) updateSettingsForSource(source, { extensions: prune } as never)
    const after = getSettingsForSource(source)?.extensions
    if (after && Object.keys(after).length === 0) updateSettingsForSource(source, { extensions: undefined } as never)
    // The FILE husk: a settings file the switch write created leaves the
    // disk once nothing but the empty object remains (the secure store's
    // husk law; absent and `{}` read identically). Reached only for a
    // source that carried an extensions block, so an operator's own empty
    // file with no extension history stays untouched.
    removeSettingsFileIfEmpty(source)
  }
}

/** Remove the switch from every project-local file the global config knows (uninstall). */
function removeSwitchFromKnownProjects(id: string): string[] {
  const touched: string[] = []
  const projects = getGlobalConfig().projects ?? {}
  const here = getOriginalCwd()
  for (const projectPath of Object.keys(projects)) {
    if (resolve(projectPath) === resolve(here)) continue
    const file = join(projectPath, MERCURY_PROJECT_DIR, 'settings.local.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { extensions?: { enabled?: Record<string, boolean> } }
      if (!parsed.extensions?.enabled || parsed.extensions.enabled[id] === undefined) continue
      delete parsed.extensions.enabled[id]
      writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n')
      touched.push(file)
    } catch {
      // an unreadable file is left alone; the switch there is inert without the record
    }
  }
  return touched
}

// ── uninstall ───────────────────────────────────────────────────────────────

export type UninstallOutcome = { ok: true; steps: string[]; dataKept: boolean } | { ok: false; reason: string }

/** What the confirm line needs: the version, the source, the measured data size. */
export function uninstallPreview(id: string): { version: string; label: string; dataBytes: number; dataDir: string } | null {
  const record = installedOrEmpty()[id]
  if (!record) return null
  const dataDir = getExtensionDataDir(id)
  return { version: record.version, label: record.label, dataBytes: existsSync(dataDir) ? folderSize(dataDir) : 0, dataDir }
}

/**
 * Uninstall on disk, in the spec's order, each step logged. The running
 * session's swap (hooks unregistered, servers disconnected, catalogues
 * dropped) is the reload's job, which every caller runs after this.
 */
export function uninstall(id: string, options: { keepData?: boolean } = {}): UninstallOutcome {
  const parsed = parseExtensionId(id)
  if (!parsed) return { ok: false, reason: `not an extension id: ${id}` }
  if (parsed.label === 'mercury') return { ok: false, reason: 'a bundled extension cannot be uninstalled — space turns it off' }
  const installed = installedOrEmpty()
  const record = installed[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const steps: string[] = []
  const inPlace = parsed.label === 'project'

  removeSwitchHere(id)
  steps.push('switch removed from both homes')
  const others = removeSwitchFromKnownProjects(id)
  if (others.length > 0) steps.push(`switch removed from ${others.length} other project file${others.length === 1 ? '' : 's'}`)

  const wrote = updateInstalled(current => {
    const next = { ...current }
    delete next[id]
    return next
  })
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  steps.push('approval and installed record removed')

  deleteOptionValues(id)
  steps.push('options and secrets removed')
  pruneEmptySettings()

  if (!inPlace) {
    rmSync(getInstalledIdDir(id), { recursive: true, force: true })
    steps.push(`version folder${record.previous ? 's' : ''} deleted`)
  } else {
    steps.push('the project folder stays in the repository')
  }

  const dataDir = getExtensionDataDir(id)
  if (options.keepData) {
    steps.push('data folder kept')
  } else {
    rmSync(dataDir, { recursive: true, force: true })
    steps.push('data folder deleted')
  }
  logAct(`uninstalled: ${id} (${steps.join('; ')})`)
  return { ok: true, steps, dataKept: options.keepData === true }
}

// ── update ──────────────────────────────────────────────────────────────────

export type UpdateOutcome =
  | { ok: true; outcome: 'current'; id: string }
  | { ok: true; outcome: 'carried'; id: string; from: string; to: string; record: InstalledRecord }
  | { ok: true; outcome: 'needs-approval'; id: string; from: string; to: string; record: InstalledRecord; newManifest: ExtensionManifest; oldManifest: ExtensionManifest | null }
  | { ok: false; reason: string }

/**
 * Fetch the version the source lists into a NEW version folder, never
 * touching the running one. A contributions hash equal to the approved one
 * carries the approval over; a different one waits for the diff card
 * (`approveUpdate` / `discardUpdate`).
 */
export async function update(id: string, options: { progress?: (line: string) => void } = {}): Promise<UpdateOutcome> {
  const parsed = parseExtensionId(id)
  if (!parsed) return { ok: false, reason: `not an extension id: ${id}` }
  if (parsed.label === 'mercury') return { ok: false, reason: 'a bundled extension updates with Mercury' }
  if (parsed.label === 'project' || parsed.label === 'session') return { ok: false, reason: 'an in-place extension has no update — the folder is the version; r reloads it' }
  const record = installedOrEmpty()[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const source = sourcesOrEmpty()[record.label]
  if (!source) return { ok: false, reason: `${record.label} was removed — the copy keeps working but cannot update` }
  const blocked = matchBlock([id, record.label, source.where])
  if (blocked) return { ok: false, reason: blockReason(blocked) }
  const read = readSourceCatalogue(record.label, source)
  if (!read.ok) return { ok: false, reason: `${record.label}: ${read.error}` }
  const entry = read.catalogue.extensions.find(e => e.name === record.name)
  if (!entry) return { ok: false, reason: `no longer offered by ${record.label}` }
  if (entry.version === record.version && !changedOnDisk(record, read.root, entry)) return { ok: true, outcome: 'current', id }

  const progress = options.progress ?? (() => {})
  // The same law as the install road: a version that cannot name a folder
  // is refused before any fetch, staging or delete.
  let destination: string
  try {
    destination = getInstalledVersionDir(id, entry.version)
  } catch (error) {
    if (error instanceof VersionFolderTraversalError) return { ok: false, reason: `${record.name}: ${error.message}` }
    throw error
  }
  const staging = join(getInstalledDir(), `.updating-${idFolderName(id)}-${process.pid}-${Date.now()}`)
  let commit: string | null = null
  if (entry.git !== undefined) {
    progress(`cloning ${entry.git}…`)
    const cloned = await cloneRepository(entry.git, entry.ref ?? null, staging)
    if (!cloned.ok) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, reason: cloned.reason }
    }
    commit = cloned.commit
  } else {
    const dir = entryDirectory(read.root, entry)
    if (dir === null || !existsSync(dir)) return { ok: false, reason: `${record.label}: ${entry.path ?? record.name} is missing from the source` }
    progress('copying…')
    copyTree(dir, staging)
    commit = source.commit ?? null
  }
  const manifest = readManifest(staging)
  if (manifest.status !== 'ok') {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: manifest.status === 'missing' ? 'no mercury-extension.json in the fetched copy' : `manifest invalid: ${manifest.errors[0]}` }
  }
  if (manifest.manifest.name !== entry.name || manifest.manifest.version !== entry.version) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: manifest.manifest.name !== entry.name ? `catalogue says ${entry.name}, manifest says ${manifest.manifest.name}` : `catalogue says ${entry.version}, manifest says ${manifest.manifest.version}` }
  }
  if (resolve(destination) === resolve(record.path)) {
    // A folder source re-copied at the same version: swap the folder in place.
    const previous = `${destination}.previous`
    rmSync(previous, { recursive: true, force: true })
    renameSync(record.path, previous)
    renameSync(staging, destination)
    rmSync(previous, { recursive: true, force: true })
  } else {
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
  }
  const hash = contributionsHash(manifest.manifest, destination)
  const approved = record.approval?.contributionsHash === hash
  const oldManifest = readManifest(record.path)
  if (!approved) {
    const pending = { ...record, pendingUpdate: { version: entry.version, path: destination, contributionsHash: hash, commit } }
    const wrote = updateInstalled(current => ({ ...current, [id]: pending }))
    if (!wrote.ok) return { ok: false, reason: wrote.error }
    logAct(`update fetched: ${id} ${record.version} → ${entry.version} (needs approval)`)
    return { ok: true, outcome: 'needs-approval', id, from: record.version, to: entry.version, record: pending, newManifest: manifest.manifest, oldManifest: oldManifest.status === 'ok' ? oldManifest.manifest : null }
  }
  const moved = moveRecordToVersion(record, entry.version, destination, hash, commit)
  const wrote = updateInstalled(current => ({ ...current, [id]: moved }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`updated: ${id} ${record.version} → ${entry.version} (approval carried over)`)
  return { ok: true, outcome: 'carried', id, from: record.version, to: entry.version, record: moved }
}

function changedOnDisk(record: InstalledRecord, sourceRoot: string, entry: { path?: string }): boolean {
  if (entry.path === undefined) return false
  const source = sourcesOrEmpty()[record.label]
  if (!source || source.kind !== 'folder') return false
  const dir = entryDirectory(sourceRoot, entry as never)
  if (dir === null || !existsSync(dir)) return false
  return hashTree(dir) !== record.contentHash
}

function moveRecordToVersion(record: InstalledRecord, version: string, path: string, hash: string, commit: string | null): InstalledRecord {
  const previous = resolve(record.path) === resolve(path) ? null : { version: record.version, path: record.path, contributionsHash: record.contributionsHash }
  return {
    ...record,
    version,
    commit,
    contentHash: hashTree(path),
    contributionsHash: hash,
    updatedAt: nowIso(),
    path,
    previous,
    approval: { version, contributionsHash: hash, at: record.approval?.at ?? nowIso() },
    pendingFirstLoad: true,
    pendingUpdate: null,
  }
}

/** After the diff card's approve: the record moves to the fetched version; the previous folder is kept until a clean load. */
export function approveUpdate(id: string): UpdateOutcome {
  const record = installedOrEmpty()[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const pending = record.pendingUpdate
  if (!pending) return { ok: false, reason: `${id} has no fetched update waiting` }
  const moved = { ...moveRecordToVersion(record, pending.version, pending.path, pending.contributionsHash, pending.commit), approval: { version: pending.version, contributionsHash: pending.contributionsHash, at: nowIso() } }
  const wrote = updateInstalled(current => ({ ...current, [id]: moved }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`update approved: ${id} ${record.version} → ${pending.version}`)
  return { ok: true, outcome: 'carried', id, from: record.version, to: pending.version, record: moved }
}

/** esc / k on the diff card: the old version stays active and the fetched folder is removed. */
export function discardUpdate(id: string): SwitchOutcome {
  const record = installedOrEmpty()[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const pending = record.pendingUpdate
  if (!pending) return { ok: true }
  if (resolve(pending.path) !== resolve(record.path)) rmSync(pending.path, { recursive: true, force: true })
  const next = { ...record, pendingUpdate: null }
  const wrote = updateInstalled(current => ({ ...current, [id]: next }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`update discarded: ${id} ${pending.version}`)
  return { ok: true }
}

/** `--previous` / P: swap back to the kept previous version — its hash was approved, nothing re-asks. */
export function swapToPrevious(id: string): UpdateOutcome {
  const record = installedOrEmpty()[id]
  if (!record) return { ok: false, reason: `${id} is not installed` }
  const previous = record.previous
  if (!previous) return { ok: false, reason: `${id} keeps no previous version` }
  if (!existsSync(previous.path)) return { ok: false, reason: `the previous folder is gone: ${previous.path}` }
  const current = { version: record.version, path: record.path, contributionsHash: record.contributionsHash }
  const next: InstalledRecord = {
    ...record,
    version: previous.version,
    path: previous.path,
    contributionsHash: previous.contributionsHash,
    contentHash: hashTree(previous.path),
    updatedAt: nowIso(),
    previous: current,
    approval: { version: previous.version, contributionsHash: previous.contributionsHash, at: record.approval?.at ?? nowIso() },
    pendingFirstLoad: true,
  }
  const wrote = updateInstalled(cur => ({ ...cur, [id]: next }))
  if (!wrote.ok) return { ok: false, reason: wrote.error }
  logAct(`swapped back: ${id} ${record.version} → ${previous.version}`)
  return { ok: true, outcome: 'carried', id, from: record.version, to: previous.version, record: next }
}

/**
 * After the first load of a new version: a clean load (health ≠ broken)
 * deletes the previous folder; a broken one keeps it and the row says so.
 */
export function settleFirstLoad(id: string, broken: boolean): void {
  const record = installedOrEmpty()[id]
  if (!record || !record.pendingFirstLoad) return
  if (broken) return
  if (record.previous && resolve(record.previous.path) !== resolve(record.path)) {
    rmSync(record.previous.path, { recursive: true, force: true })
  }
  const next: InstalledRecord = { ...record, previous: null, pendingFirstLoad: false }
  updateInstalled(current => ({ ...current, [id]: next }))
  logAct(`first clean load: ${id} ${record.version}${record.previous ? ` (previous ${record.previous.version} removed)` : ''}`)
}

/** The bundled roster's first-boot approval (installing Mercury is the approval). */
export function recordBundledApproval(name: string, root: string, mercuryVersion: string): InstalledRecord | null {
  const id = extensionId(name, 'mercury')
  const manifest = readManifest(root)
  if (manifest.status !== 'ok') return null
  const hash = contributionsHash(manifest.manifest, root)
  const existing = installedOrEmpty()[id]
  if (existing && existing.contributionsHash === hash && existing.approval?.contributionsHash === hash && resolve(existing.path) === resolve(root)) return existing
  const record: InstalledRecord = {
    name,
    label: 'mercury',
    version: manifest.manifest.version,
    commit: null,
    contentHash: hashTree(root),
    contributionsHash: hash,
    installedAt: existing?.installedAt ?? nowIso(),
    updatedAt: nowIso(),
    path: resolve(root),
    previous: null,
    approval: { version: manifest.manifest.version, contributionsHash: hash, at: nowIso() },
    switches: existing?.switches ?? defaultSwitches(),
    bundledNote: existing && existing.contributionsHash !== hash ? `updated with Mercury ${mercuryVersion}` : existing?.bundledNote ?? null,
  }
  updateInstalled(current => ({ ...current, [id]: record }))
  return record
}

/** The board opened: a bundled extension's one-time note is cleared. */
export function clearBundledNote(id: string): void {
  const record = installedOrEmpty()[id]
  if (!record || !record.bundledNote) return
  updateInstalled(current => ({ ...current, [id]: { ...record, bundledNote: null } }))
}

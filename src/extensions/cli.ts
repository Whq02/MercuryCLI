// ============================================================================
//  src/extensions/cli.ts — `mercury extensions <verb>`: the headless verbs.
//
//  Every verb produces the same states the board shows, from the same
//  owners. `--yes` is the ONLY scripted approval: without it, a TTY prints
//  the card as text and asks; no TTY refuses with the card and exit 1. An
//  env var never implies it.
// ============================================================================
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { approvalCardLines } from './card.js'
import { block, unblock } from './blocklist.js'
import { computeActiveSet, publishActiveSet } from './active.js'
import { healthLine } from './health.js'
import {
  approve,
  approveUpdate,
  discardUpdate,
  installFromSource,
  setSwitch,
  swapToPrevious,
  uninstall,
  uninstallPreview,
  update,
} from './install.js'
import { NAME_PATTERN, extensionId, parseExtensionId, readManifest } from './manifest.js'
import { isOptionSet } from './options.js'
import { CATALOGUE_FILE, MANIFEST_FILE, PROJECT_EXTENSIONS_DIR } from './paths.js'
import { MERCURY_PROJECT_DIR } from '../utils/projectConfig.js'
import { installedOrEmpty, sourcesOrEmpty } from './records.js'
import { findEntry, trustStateOf } from './roster.js'
import { addSource, installedFromSource, listSources, refreshSource, removeSource, sourceState } from './sources.js'
import { formatBytes } from './tree.js'
import type { RosterEntry } from './types.js'
import { validatePath } from './validate.js'
import readmeTemplateText from '../../docs/templates/extension-source-README.md'

export type CliIo = {
  out: (line: string) => void
  err: (line: string) => void
  /** Whether a human is at the other end (a TTY). */
  interactive: boolean
  /** Ask a yes/no question on a TTY; resolves false when not interactive. */
  ask?: (question: string) => Promise<boolean>
}

export type CliResult = { exit: number }

export const defaultIo: CliIo = {
  out: line => process.stdout.write(line + '\n'),
  err: line => process.stderr.write(line + '\n'),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async question => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolveAnswer => rl.question(`${question} [y/N] `, resolveAnswer))
    rl.close()
    return /^y(es)?$/i.test(answer.trim())
  },
}

// ── shared renderers (the same words the board uses) ────────────────────────

function stateCell(entry: RosterEntry, health: ReturnType<typeof healthLine> | null): string {
  const state = trustStateOf(entry)
  switch (state) {
    case 'on':
      return health ?? '● on'
    case 'pending':
      return `◐ reload · ${entry.pending === 'update' ? `${entry.record?.previous?.version ?? '?'} → ${entry.version}` : entry.pending === 'on' ? 'turned on' : 'turned off'} · r reloads`
    case 'off':
      return `○ off${entry.shadowedBy ? ' · shadowed by project' : entry.changedSinceApproval ? ' · changed — re-approve' : !entry.approved ? ' · not approved · i approves' : ''}`
    case 'found':
      return `◇ found · ${entry.home === 'proposal' ? 'proposed · i fetches' : `${MERCURY_PROJECT_DIR}/${PROJECT_EXTENSIONS_DIR} · i installs`}`
    case 'blocked':
      return `◉ blocked · ${entry.blockedBy === 'policy' ? 'blocked by policy' : 'b unblocks'}`
    default:
      return '—'
  }
}

function noteFor(entry: RosterEntry): string {
  const notes: string[] = []
  if (entry.availableVersion) notes.push(`↑ ${entry.availableVersion} available`)
  if (entry.noLongerOffered) notes.push(`no longer offered by ${entry.label}`)
  if (entry.sourceRemoved) notes.push(`from ${entry.label} (removed)`)
  if (entry.changedOnDisk) notes.push('changed on disk')
  if (entry.record?.pendingFirstLoad && entry.previous) notes.push(`previous ${entry.previous.version} kept`)
  if (entry.bundledUpdatedWith) notes.push(entry.bundledUpdatedWith)
  return notes.join(' · ')
}

export type ListRow = {
  id: string
  name: string
  version: string
  from: string
  home: RosterEntry['home']
  state: string
  trust: ReturnType<typeof trustStateOf>
  health: { outcome: string; reasons: string[]; notes: string[] } | null
  note: string
  approved: boolean
  switch: RosterEntry['switchScope']
  blocked: RosterEntry['blockedBy']
  shadowedBy: string | null
  pending: RosterEntry['pending']
  availableVersion: string | null
  path: string | null
}

/** The roster as rows (the JSON shape of `list --json`; the same facts the board paints). */
export function listRows(): { rows: ListRow[]; problems: string[] } {
  const set = computeActiveSet()
  publishActiveSet(null)
  const rows: ListRow[] = set.roster.entries.map(entry => {
    const health = set.healthById.get(entry.id) ?? null
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      from: entry.label,
      home: entry.home,
      state: stateCell(entry, health ? healthLine(health) : null),
      trust: trustStateOf(entry),
      health: health ? { outcome: health.outcome, reasons: health.reasons, notes: health.notes } : null,
      note: noteFor(entry),
      approved: entry.approved,
      switch: entry.switchScope,
      blocked: entry.blockedBy,
      shadowedBy: entry.shadowedBy,
      pending: entry.pending,
      availableVersion: entry.availableVersion,
      path: entry.root,
    }
  })
  return { rows, problems: set.roster.problems }
}

export type SourceJsonRow = {
  label: string
  kind: string
  where: string
  ref: string | null
  state: string
  reason: string | null
  checkedAt: string | null
  commit: string | null
  offered: number
  installed: number
  updates: number
  extensions: Array<{ name: string; version: string; description: string; installed: string | null; state: string }>
}

/** The sources as rows (the JSON shape of `sources --json`). */
export function sourceRows(): SourceJsonRow[] {
  const installed = installedOrEmpty()
  return listSources().map(row => ({
    label: row.label,
    kind: row.record.kind,
    where: row.record.where,
    ref: row.record.ref ?? null,
    state: row.state,
    reason: row.reason,
    checkedAt: row.record.checkedAt,
    commit: row.record.commit ?? null,
    offered: row.offered,
    installed: row.installed,
    updates: row.updates,
    extensions: (row.catalogue?.extensions ?? []).map(entry => {
      const id = extensionId(entry.name, row.label)
      const record = installed[id]
      const state = !record ? '—' : record.version !== entry.version ? `↑ ${entry.version} available` : 'installed'
      return { name: entry.name, version: entry.version, description: entry.description, installed: record?.version ?? null, state }
    }),
  }))
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

// ── the verbs ───────────────────────────────────────────────────────────────

export async function listVerb(options: { json?: boolean; source?: string }, io: CliIo = defaultIo): Promise<CliResult> {
  if (options.source) {
    const rows = sourceRows().find(r => r.label === options.source)
    if (!rows) {
      io.err(`no source named ${options.source}`)
      return { exit: 1 }
    }
    if (options.json) {
      io.out(JSON.stringify(rows, null, 2))
      return { exit: 0 }
    }
    if (rows.extensions.length === 0) io.out('this source offers nothing yet')
    for (const e of rows.extensions) io.out(`${pad(e.state, 20)} ${pad(e.name, 24)} ${pad(e.version, 10)} ${e.description}`)
    return { exit: 0 }
  }
  const { rows, problems } = listRows()
  if (options.json) {
    io.out(JSON.stringify({ extensions: rows, problems }, null, 2))
    return { exit: 0 }
  }
  for (const problem of problems) io.err(problem)
  if (rows.length === 0) {
    io.out('no extensions yet — sources › a adds a git URL, a folder or an archive · docs/EXTENSIONS.md explains how to make one')
    return { exit: 0 }
  }
  for (const row of rows) io.out(`${pad(row.state, 34)} ${pad(row.name, 24)} ${pad(row.version, 10)} ${pad(row.from, 14)} ${row.note}`)
  return { exit: 0 }
}

export async function sourcesVerb(options: { json?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const rows = sourceRows()
  if (options.json) {
    io.out(JSON.stringify({ sources: rows }, null, 2))
    return { exit: 0 }
  }
  if (rows.length === 0) {
    io.out('no sources — add a git URL, a folder or an archive: mercury extensions add <url|path>')
    return { exit: 0 }
  }
  for (const row of rows) {
    const glyph = row.state === 'ok' ? '● ok' : row.state === 'stale' ? '↻ stale' : row.state === 'unreachable' ? '✕ unreach' : '○ unchecked'
    io.out(`${pad(glyph, 12)} ${pad(row.label, 16)} ${pad(row.kind, 8)} ${row.where} · ${row.offered} offered · ${row.installed} installed${row.updates ? ` · ${row.updates} update${row.updates === 1 ? '' : 's'}` : ''}${row.reason ? ` · ${row.reason}` : ''}`)
  }
  return { exit: 0 }
}

export async function addVerb(text: string, options: { label?: string; json?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const outcome = await addSource(text, { label: options.label, progress: line => io.err(line) })
  if (!outcome.ok) {
    io.err(`add failed at ${outcome.step}: ${outcome.reason}`)
    return { exit: 1 }
  }
  const row = sourceRows().find(r => r.label === outcome.label)
  if (options.json) io.out(JSON.stringify(row, null, 2))
  else {
    io.out(`added ${outcome.label} (${outcome.record.kind}) — ${outcome.catalogue.extensions.length} extension${outcome.catalogue.extensions.length === 1 ? '' : 's'} offered; nothing installed`)
    for (const e of outcome.catalogue.extensions) io.out(`  ${pad(e.name, 24)} ${pad(e.version, 10)} ${e.description}`)
    for (const w of outcome.warnings) io.err(`warning: ${w}`)
  }
  return { exit: 0 }
}

export async function removeVerb(label: string, options: { andExtensions?: boolean; yes?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const sources = sourcesOrEmpty()
  if (!sources[label]) {
    io.err(`no source named ${label}`)
    return { exit: 1 }
  }
  const installed = installedFromSource(label)
  if (installed.length > 0 && !options.andExtensions) {
    io.out(`${installed.length} installed from ${label}: ${installed.join(', ')} — they keep working as copies and can no longer update (--and-extensions uninstalls them too)`)
  }
  const removed = removeSource(label)
  if (!removed.ok) {
    io.err(removed.reason)
    return { exit: 1 }
  }
  io.out(`removed source ${label}`)
  if (options.andExtensions) {
    for (const id of installed) {
      const done = uninstall(id)
      io.out(done.ok ? `uninstalled ${id}` : `${id}: ${done.reason}`)
    }
  }
  return { exit: 0 }
}

export async function checkVerb(label: string | undefined, options: { json?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const labels = label ? [label] : Object.keys(sourcesOrEmpty())
  if (labels.length === 0) {
    io.out('no sources to check')
    return { exit: 0 }
  }
  let exit = 0
  const results: unknown[] = []
  for (const l of labels) {
    const outcome = await refreshSource(l, { progress: line => io.err(`${l}: ${line}`) })
    if (!outcome.ok) {
      exit = 1
      results.push({ label: l, ok: false, reason: outcome.reason })
      if (!options.json) io.out(`✕ ${l}: ${outcome.reason}`)
      continue
    }
    results.push({ label: l, ok: true, updates: outcome.updates, delisted: outcome.delisted })
    if (!options.json) {
      io.out(`● ${l}: ${outcome.catalogue.extensions.length} offered${outcome.updates.length ? ` · ${outcome.updates.length} update${outcome.updates.length === 1 ? '' : 's'}` : ''}`)
      for (const u of outcome.updates) io.out(`  ↑ ${u.id}: ${u.from} → ${u.to} available`)
      for (const d of outcome.delisted) io.out(`  ${d}: no longer offered by ${l}`)
    }
  }
  if (options.json) io.out(JSON.stringify({ checked: results }, null, 2))
  return { exit }
}

function parseTarget(target: string): { name: string; label: string | null } {
  const parsed = parseExtensionId(target)
  if (parsed) return { name: parsed.name, label: parsed.label }
  return { name: target, label: null }
}

function cardFor(root: string, label: string, kind: 'install' | 'update' | 'project folder', where: string | null, id: string): string[] | null {
  const manifest = readManifest(root)
  if (manifest.status !== 'ok') return null
  return approvalCardLines({ manifest: manifest.manifest, root, kind, from: { label, where }, optionSet: key => isOptionSet(id, manifest.manifest.needs?.options, key) })
}

/** The `--yes` law: a TTY asks after the card; no TTY refuses with the card and exit 1. */
async function consent(io: CliIo, card: string[], yes: boolean | undefined): Promise<boolean> {
  for (const line of card) io.out(line)
  if (yes) return true
  if (!io.interactive || !io.ask) {
    io.err('no terminal to ask on — re-run with --yes to approve from a script')
    return false
  }
  return io.ask('approve?')
}

export async function installVerb(target: string, options: { yes?: boolean; project?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const { name, label: givenLabel } = parseTarget(target)
  let label = givenLabel
  if (!label) {
    const offering = listSources().filter(row => row.catalogue?.extensions.some(e => e.name === name))
    if (offering.length === 0) {
      io.err(`no source offers ${name} — mercury extensions sources lists what you have`)
      return { exit: 1 }
    }
    if (offering.length > 1) {
      io.err(`${name} is offered by ${offering.map(o => o.label).join(', ')} — say which: ${name}@<label>`)
      return { exit: 1 }
    }
    label = offering[0]!.label
  }
  const installed = await installFromSource(label, name, { progress: line => io.err(line) })
  if (!installed.ok) {
    io.err(installed.reason)
    return { exit: 1 }
  }
  const source = sourcesOrEmpty()[label]
  const card = cardFor(installed.root, label, 'install', source?.where ?? null, installed.id)
  if (!card) {
    io.err(`${installed.id}: the copy's manifest is unreadable`)
    return { exit: 1 }
  }
  const ok = await consent(io, card, options.yes)
  if (!ok) {
    io.out(`${installed.id} ${installed.record.version} installed, off — mercury extensions approve ${installed.id} --yes approves`)
    return { exit: options.yes ? 0 : 1 }
  }
  const approved = approve(installed.id, { scope: options.project ? 'project' : 'everywhere' })
  if (!approved.ok) {
    io.err(approved.reason)
    return { exit: 1 }
  }
  io.out(`${installed.id} ${installed.record.version} approved and on (${options.project ? 'this project' : 'everywhere'}) — the running session picks it up on r`)
  return { exit: 0 }
}

export async function approveVerb(target: string, options: { yes?: boolean; project?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const set = computeActiveSet()
  publishActiveSet(null)
  const entry = findEntry(set.roster.entries, target)
  if (!entry) {
    io.err(`${target} is not installed or found here`)
    return { exit: 1 }
  }
  if (entry.home === 'proposal') {
    io.err(`${entry.name} is a proposal from ${entry.proposal?.source} — add that source and install it, then approve`)
    return { exit: 1 }
  }
  if (entry.root === null || entry.manifest === null) {
    io.err(`${entry.id}: ${entry.manifestErrors[0] ?? 'nothing to approve'}`)
    return { exit: 1 }
  }
  if (entry.record?.pendingUpdate) {
    const pending = entry.record.pendingUpdate
    const next = readManifest(pending.path)
    const previous = readManifest(entry.root)
    if (next.status === 'ok') {
      const card = approvalCardLines({
        manifest: next.manifest,
        root: pending.path,
        kind: 'update',
        from: { label: entry.label, where: entry.source?.where ?? null, commit: pending.commit },
        previous: previous.status === 'ok' ? { manifest: previous.manifest, root: entry.root, version: entry.version } : null,
        optionSet: key => isOptionSet(entry.id, next.manifest.needs?.options, key),
      })
      const ok = await consent(io, card, options.yes)
      if (!ok) {
        discardUpdate(entry.id)
        io.out(`${entry.id} stays at ${entry.version}; the fetched ${pending.version} was removed`)
        return { exit: 1 }
      }
      const applied = approveUpdate(entry.id)
      if (!applied.ok) {
        io.err(applied.reason)
        return { exit: 1 }
      }
      io.out(`${entry.id} ${entry.version} → ${pending.version} approved — r reloads`)
      return { exit: 0 }
    }
  }
  const kind = entry.home === 'project' ? 'project folder' : 'install'
  const card = cardFor(entry.root, entry.label, kind, entry.source?.where ?? entry.root, entry.id)
  if (!card) {
    io.err(`${entry.id}: manifest unreadable`)
    return { exit: 1 }
  }
  const ok = await consent(io, card, options.yes)
  if (!ok) return { exit: 1 }
  const approved = approve(entry.id, { scope: options.project ? 'project' : 'everywhere', root: entry.root })
  if (!approved.ok) {
    io.err(approved.reason)
    return { exit: 1 }
  }
  io.out(`${entry.id} ${entry.version} approved and on (${options.project ? 'this project' : 'everywhere'}) — r reloads`)
  return { exit: 0 }
}

export async function enableVerb(id: string, options: { project?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const outcome = setSwitch(id, true, options.project ? 'project' : 'everywhere')
  if (!outcome.ok) {
    io.err(outcome.reason)
    return { exit: 1 }
  }
  io.out(`${id} on (${options.project ? 'this project' : 'everywhere'}) — r reloads`)
  return { exit: 0 }
}

export async function disableVerb(id: string, options: { project?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const outcome = setSwitch(id, false, options.project ? 'project' : 'everywhere')
  if (!outcome.ok) {
    io.err(outcome.reason)
    return { exit: 1 }
  }
  io.out(`${id} off (${options.project ? 'this project' : 'everywhere'}) — r reloads`)
  return { exit: 0 }
}

export async function updateVerb(target: string | undefined, options: { all?: boolean; yes?: boolean; previous?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  if (options.previous) {
    if (!target) {
      io.err('--previous needs an id')
      return { exit: 1 }
    }
    const swapped = swapToPrevious(target)
    if (!swapped.ok) {
      io.err(swapped.reason)
      return { exit: 1 }
    }
    io.out(`${target} swapped back to ${swapped.outcome === 'carried' ? swapped.to : ''} — r reloads`)
    return { exit: 0 }
  }
  const ids = options.all ? Object.keys(installedOrEmpty()).filter(id => !id.endsWith('@mercury') && !id.endsWith('@project')) : target ? [target] : []
  if (ids.length === 0) {
    io.err('say which: mercury extensions update <id> | --all')
    return { exit: 1 }
  }
  let exit = 0
  for (const id of ids) {
    const outcome = await update(id, { progress: line => io.err(`${id}: ${line}`) })
    if (!outcome.ok) {
      if (!options.all) exit = 1
      io.err(`${id}: ${outcome.reason}`)
      continue
    }
    if (outcome.outcome === 'current') {
      io.out(`${id}: already current`)
      continue
    }
    if (outcome.outcome === 'carried') {
      io.out(`${id}: ${outcome.from} → ${outcome.to} (approval carried over) — r reloads`)
      continue
    }
    // needs approval
    const previous = outcome.oldManifest && outcome.record.path ? { manifest: outcome.oldManifest, root: outcome.record.path, version: outcome.from } : null
    const card = approvalCardLines({
      manifest: outcome.newManifest,
      root: outcome.record.pendingUpdate!.path,
      kind: 'update',
      from: { label: outcome.record.label, where: sourcesOrEmpty()[outcome.record.label]?.where ?? null, commit: outcome.record.pendingUpdate!.commit },
      previous,
      optionSet: key => isOptionSet(id, outcome.newManifest.needs?.options, key),
    })
    if (options.all && !options.yes && !io.interactive) {
      io.out(`${id}: ${outcome.from} → ${outcome.to} needs approval — mercury extensions approve ${id} --yes`)
      continue
    }
    const ok = await consent(io, card, options.yes)
    if (!ok) {
      discardUpdate(id)
      io.out(`${id} stays at ${outcome.from}; the fetched ${outcome.to} was removed`)
      exit = options.all ? exit : 1
      continue
    }
    const applied = approveUpdate(id)
    if (!applied.ok) {
      io.err(applied.reason)
      exit = 1
      continue
    }
    io.out(`${id}: ${outcome.from} → ${outcome.to} approved — r reloads`)
  }
  return { exit }
}

export async function uninstallVerb(id: string, options: { keepData?: boolean; yes?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const preview = uninstallPreview(id)
  if (!preview) {
    io.err(`${id} is not installed`)
    return { exit: 1 }
  }
  io.out(`uninstall ${id} ${preview.version} (${preview.label})${preview.dataBytes > 0 ? ` · data ${formatBytes(preview.dataBytes)} ${options.keepData ? 'kept' : 'deleted'}` : ''}`)
  if (!options.yes && io.interactive && io.ask) {
    const ok = await io.ask('uninstall?')
    if (!ok) return { exit: 1 }
  }
  const outcome = uninstall(id, { keepData: options.keepData })
  if (!outcome.ok) {
    io.err(outcome.reason)
    return { exit: 1 }
  }
  for (const step of outcome.steps) io.out(`  ${step}`)
  io.out(`${id} uninstalled — r reloads`)
  return { exit: 0 }
}

export async function blockVerb(entry: string, io: CliIo = defaultIo): Promise<CliResult> {
  const outcome = block(entry)
  if (!outcome.ok) {
    io.err(outcome.error)
    return { exit: 1 }
  }
  io.out(`blocked ${entry}`)
  return { exit: 0 }
}

export async function unblockVerb(entry: string, io: CliIo = defaultIo): Promise<CliResult> {
  const outcome = unblock(entry)
  if (!outcome.ok) {
    io.err(outcome.error)
    return { exit: 1 }
  }
  io.out(`unblocked ${entry}`)
  return { exit: 0 }
}

export async function validateVerb(path: string, options: { json?: boolean }, io: CliIo = defaultIo): Promise<CliResult> {
  const report = validatePath(resolve(path))
  if (options.json) {
    io.out(JSON.stringify(report, null, 2))
    return { exit: report.ok ? 0 : 1 }
  }
  io.out(`${report.kind === 'none' ? 'nothing' : report.kind} at ${report.path}: ${report.ok ? 'valid' : 'invalid'}`)
  for (const line of report.summary) io.out(`  ${line}`)
  for (const error of report.errors) io.out(`  error: ${error}`)
  for (const warning of report.warnings) io.out(`  ${warning}`)
  return { exit: report.ok ? 0 : 1 }
}

// ── init ────────────────────────────────────────────────────────────────────

/** The README template, embedded at build from docs/templates/ (the one file `init` writes and the skill ships). */
export function readmeTemplate(): string {
  return readmeTemplateText
}

export function fillReadmeTemplate(values: { name: string; url: string; extensions: string[]; needs: string[]; maintainer: string; license: string }): string {
  return readmeTemplate()
    .replaceAll('{{SOURCE_NAME}}', values.name)
    .replaceAll('{{SOURCE_URL}}', values.url)
    .replaceAll('{{EXTENSION_LINES}}', values.extensions.length ? values.extensions.map(e => `- ${e}`).join('\n') : '- (list each extension: `name` — one line)')
    .replaceAll('{{NEEDS_LINES}}', values.needs.length ? values.needs.map(n => `- ${n}`).join('\n') : '- (name the binaries, environment variables and options each one needs)')
    .replaceAll('{{MAINTAINER}}', values.maintainer)
    .replaceAll('{{LICENSE}}', values.license)
}

/** Scaffold an extension folder (or, with --source, a source root) that validates clean. */
export async function initVerb(name: string, options: { source?: boolean; dir?: string }, io: CliIo = defaultIo): Promise<CliResult> {
  if (!NAME_PATTERN.test(name)) {
    io.err(`"${name}" — lowercase letters, digits and hyphens, 1–40 characters`)
    return { exit: 1 }
  }
  const base = resolve(options.dir ?? process.cwd())
  const root = join(base, name)
  if (existsSync(root)) {
    io.err(`${root} already exists`)
    return { exit: 1 }
  }
  if (options.source) {
    mkdirSync(join(root, 'example-extension', 'skills', 'example'), { recursive: true })
    writeFileSync(
      join(root, CATALOGUE_FILE),
      JSON.stringify(
        {
          name,
          description: `${name} — extensions for Mercury`,
          extensions: [{ name: 'example-extension', version: '0.1.0', description: 'an example extension; replace it', path: './example-extension' }],
        },
        null,
        2,
      ) + '\n',
    )
    writeExtensionScaffold(join(root, 'example-extension'), 'example-extension', 'an example extension; replace it')
    writeFileSync(join(root, 'README.md'), fillReadmeTemplate({ name, url: '<the URL of this repository>', extensions: ['`example-extension` — an example extension; replace it'], needs: ['`example-extension` needs nothing'], maintainer: '<who maintains this source>', license: '<the licence>' }))
    io.out(`source scaffolded at ${root}: ${CATALOGUE_FILE}, README.md, example-extension/`)
  } else {
    writeExtensionScaffold(root, name, `${name} — say what it adds in one line`)
    io.out(`extension scaffolded at ${root}: ${MANIFEST_FILE}, README.md, skills/`)
  }
  io.out(`validate it: mercury extensions validate ${root}`)
  return { exit: 0 }
}

function writeExtensionScaffold(root: string, name: string, description: string): void {
  mkdirSync(join(root, 'skills', name), { recursive: true })
  writeFileSync(
    join(root, MANIFEST_FILE),
    JSON.stringify({ name, version: '0.1.0', description, contributes: { skills: ['./skills'] }, needs: { binaries: [], env: [] } }, null, 2) + '\n',
  )
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nSay what this skill does. Its folder is \${MERCURY_EXTENSION_ROOT}/skills/${name}.\n`,
  )
  writeFileSync(join(root, 'README.md'), `# ${name}\n\n${description}\n\nAdd this folder to a project as \`${MERCURY_PROJECT_DIR}/${PROJECT_EXTENSIONS_DIR}/${name}/\` and approve it from \`/extensions\`, or publish it as its own repository and add the URL as a source.\n`)
}


// ============================================================================
//  src/extensions/validate.ts — the maker's linter (`mercury extensions
//  validate <path>`): a manifest or a catalogue, strict, with every
//  contribution resolved and every ignored side file named. Where the
//  runtime tolerates (an unknown top-level key, a stray hooks/hooks.json),
//  the validator reports — this is where a maker finds out.
// ============================================================================
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { entryDirectory, readSourceRoot } from './catalogue.js'
import { resolveContributions, realProbes, type Probes } from './load/contributions.js'
import { IGNORED_SIDE_FILES, contributionsHash, extensionId, readManifest, shortHash } from './manifest.js'
import { CATALOGUE_FILE, MANIFEST_FILE } from './paths.js'

export type ValidationReport = {
  kind: 'extension' | 'source' | 'none'
  path: string
  ok: boolean
  errors: string[]
  warnings: string[]
  /** Side files the runtime ignores, named so a maker does not expect them to load. */
  ignored: string[]
  /** For an extension: the resolved contribution counts and the defects the runtime would report. */
  summary: string[]
}

/** Side files a maker might expect Mercury to read; it reads none of them. */
export function ignoredSideFiles(root: string): string[] {
  const found: string[] = []
  for (const rel of IGNORED_SIDE_FILES) {
    if (existsSync(join(root, rel))) found.push(rel)
  }
  // A manifest inside a hidden folder beside the root manifest is ignored too.
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const inner of readdirSync(dir)) {
      if (inner.endsWith('.json')) found.push(`${entry}/${inner}`)
    }
  }
  return found
}

export function validateExtensionFolder(root: string, probes: Probes = realProbes({ optionSet: () => true })): ValidationReport {
  const report: ValidationReport = { kind: 'extension', path: root, ok: false, errors: [], warnings: [], ignored: ignoredSideFiles(root), summary: [] }
  const read = readManifest(root, { strict: true })
  if (read.status === 'missing') {
    report.errors.push(`no ${MANIFEST_FILE} at ${root}`)
    return report
  }
  if (read.status === 'invalid') {
    report.errors.push(...read.errors)
    report.warnings.push(...read.warnings)
    return report
  }
  report.warnings.push(...read.warnings)
  const manifest = read.manifest
  const resolution = resolveContributions(manifest, root, extensionId(manifest.name, 'validate'), probes)
  for (const defect of resolution.defects) report.warnings.push(`would load partial: ${defect}`)
  for (const note of resolution.notes) report.warnings.push(`note: ${note}`)
  const counts: string[] = []
  if (resolution.skills.length) counts.push(`${resolution.skills.length} skill${resolution.skills.length === 1 ? '' : 's'}`)
  if (resolution.commands.length) counts.push(`${resolution.commands.length} command${resolution.commands.length === 1 ? '' : 's'}`)
  if (resolution.agents.length) counts.push(`${resolution.agents.length} agent${resolution.agents.length === 1 ? '' : 's'}`)
  if (resolution.hooks.length) counts.push(`${resolution.hooks.length} hook${resolution.hooks.length === 1 ? '' : 's'}`)
  if (resolution.servers.length) counts.push(`${resolution.servers.length} server${resolution.servers.length === 1 ? '' : 's'}`)
  if (resolution.language.length) counts.push(`${resolution.language.length} language server${resolution.language.length === 1 ? '' : 's'}`)
  if (resolution.channels.length) counts.push(`${resolution.channels.length} channel${resolution.channels.length === 1 ? '' : 's'}`)
  if (resolution.keybindings.length) counts.push(`${resolution.keybindings.length} keybinding${resolution.keybindings.length === 1 ? '' : 's'}`)
  report.summary.push(`${manifest.name} ${manifest.version} — ${manifest.description}`)
  report.summary.push(`adds ${counts.length > 0 ? counts.join(' · ') : 'nothing'}`)
  report.summary.push(`contributions hash ${shortHash(contributionsHash(manifest, root))} (re-approval is asked when it changes)`)
  for (const rel of report.ignored) report.warnings.push(`ignored: ${rel} (only ${MANIFEST_FILE} is read)`)
  report.ok = report.errors.length === 0
  return report
}

export function validateSourceFolder(root: string, probes?: Probes): ValidationReport {
  const report: ValidationReport = { kind: 'source', path: root, ok: false, errors: [], warnings: [], ignored: [], summary: [] }
  const read = readSourceRoot(root, { strict: true })
  if (read.status === 'none') {
    report.errors.push(read.reason)
    return report
  }
  if (read.status === 'invalid') {
    report.errors.push(...read.errors)
    report.warnings.push(...read.warnings)
    return report
  }
  report.warnings.push(...read.warnings)
  const catalogue = read.catalogue
  report.summary.push(`source ${catalogue.name} — ${catalogue.extensions.length} extension${catalogue.extensions.length === 1 ? '' : 's'}`)
  catalogue.extensions.forEach((entry, index) => {
    if (entry.git !== undefined) {
      report.summary.push(`${entry.name} ${entry.version} — git ${entry.git}${entry.ref ? ` @ ${entry.ref}` : ''} (fetched at install time)`)
      return
    }
    const dir = entryDirectory(root, entry)
    if (dir === null) {
      report.errors.push(`extensions[${index}].path escapes the root`)
      return
    }
    const inner = validateExtensionFolder(dir, probes)
    if (inner.errors.length > 0) {
      report.errors.push(...inner.errors.map(e => `${entry.name}: ${e}`))
      return
    }
    const manifest = readManifest(dir)
    if (manifest.status === 'ok') {
      if (manifest.manifest.name !== entry.name) report.errors.push(`extensions[${index}]: catalogue says ${entry.name}, manifest says ${manifest.manifest.name}`)
      if (manifest.manifest.version !== entry.version) report.errors.push(`extensions[${index}]: catalogue says ${entry.version}, manifest says ${manifest.manifest.version}`)
    }
    report.warnings.push(...inner.warnings.map(w => `${entry.name}: ${w}`))
    report.summary.push(...inner.summary.slice(0, 2).map(s => `  ${s}`))
  })
  report.ok = report.errors.length === 0
  return report
}

/** Decide by what the folder carries: a catalogue → source; a manifest → extension. */
export function validatePath(path: string): ValidationReport {
  if (!existsSync(path)) return { kind: 'none', path, ok: false, errors: [`${path} does not exist`], warnings: [], ignored: [], summary: [] }
  if (statSync(path).isFile()) {
    const name = basename(path)
    const dir = join(path, '..')
    if (name === CATALOGUE_FILE) return validateSourceFolder(dir)
    if (name === MANIFEST_FILE) return validateExtensionFolder(dir)
    return { kind: 'none', path, ok: false, errors: [`${name} is neither ${MANIFEST_FILE} nor ${CATALOGUE_FILE}`], warnings: [], ignored: [], summary: [] }
  }
  if (existsSync(join(path, CATALOGUE_FILE))) return validateSourceFolder(path)
  if (existsSync(join(path, MANIFEST_FILE))) return validateExtensionFolder(path)
  return { kind: 'none', path, ok: false, errors: [`no ${MANIFEST_FILE} or ${CATALOGUE_FILE} at ${path}`], warnings: [], ignored: ignoredSideFiles(path), summary: [] }
}

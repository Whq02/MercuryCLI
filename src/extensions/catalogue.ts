// ============================================================================
//  src/extensions/catalogue.ts — a source's catalogue: `mercury-extensions.json`.
//
//  A source root carries ONE of: this catalogue (a multi-extension source)
//  or a single `mercury-extension.json` (the repository IS the source; a
//  one-entry catalogue is synthesised with the extension's name as the
//  label). The schema carries `.describe()` on every field for the
//  contract generator.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { lazySchema } from '../utils/lazySchema.js'
import {
  DESCRIPTION_MAX,
  NAME_PATTERN,
  NAME_RULE,
  isReservedLabel,
  readManifest,
  resolveInsideRoot,
} from './manifest.js'
import { CATALOGUE_FILE } from './paths.js'

export const LABEL_RULE = `${NAME_RULE}; not one of the reserved labels project, session, mercury`

export const CatalogueEntrySchema = lazySchema(() =>
  z.strictObject({
    name: z.string().regex(NAME_PATTERN, `name: ${NAME_RULE}`).describe("The extension's name. Must equal the manifest's `name` — a mismatch is a lying catalogue and the install refuses."),
    version: z.string().min(1).regex(/^\S+$/, 'version: no whitespace').describe("The version offered. Must equal the manifest's `version` at that ref — a mismatch refuses the install."),
    description: z.string().min(1).max(DESCRIPTION_MAX).describe('One line, painted in the source view.'),
    path: z.string().optional().describe('Where the extension lives inside this source (`./review-tools`); never escapes the source root. Exactly one of `path` or `git`.'),
    git: z.string().optional().describe("A git URL when the extension lives in another repository; fetched only at install time, and the card names the URL first. Exactly one of `path` or `git`."),
    ref: z.string().optional().describe('The branch or tag to fetch for a `git` entry.'),
  }),
)

export const CatalogueSchema = lazySchema(() =>
  z.object({
    name: z.string().regex(NAME_PATTERN, `name: ${NAME_RULE}`).describe(`The source's label: ${LABEL_RULE}. Unique among the operator's sources.`),
    description: z.string().optional().describe('One line about the source, shown in the sources list.'),
    homepage: z.string().url().optional().describe('A URL for humans.'),
    extensions: z.array(CatalogueEntrySchema()).describe('The extensions this source offers.'),
  }),
)

export type Catalogue = z.infer<ReturnType<typeof CatalogueSchema>>
export type CatalogueEntry = z.infer<ReturnType<typeof CatalogueEntrySchema>>

export const KNOWN_CATALOGUE_KEYS: ReadonlySet<string> = new Set(['name', 'description', 'homepage', 'extensions'])

export type CatalogueParse =
  | { ok: true; catalogue: Catalogue; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(p => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[')
}

export function parseCatalogueValue(raw: unknown, options: { strict?: boolean } = {}): CatalogueParse {
  const warnings: string[] = []
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['catalogue must be a JSON object'], warnings }
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KNOWN_CATALOGUE_KEYS.has(key)) {
      const line = `unknown top-level key "${key}"`
      if (options.strict) errors.push(line)
      else warnings.push(line)
    }
  }
  const parsed = CatalogueSchema().safeParse(record)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issuePath(issue.path) || '<root>'}: ${issue.message}`)
    return { ok: false, errors, warnings }
  }
  const catalogue = parsed.data
  if (isReservedLabel(catalogue.name)) errors.push(`name: "${catalogue.name}" is a reserved label`)
  const seen = new Set<string>()
  catalogue.extensions.forEach((entry, index) => {
    const hasPath = entry.path !== undefined
    const hasGit = entry.git !== undefined
    if (hasPath === hasGit) errors.push(`extensions[${index}]: exactly one of "path" or "git" is required`)
    if (hasPath && !/^\.\//.test(entry.path!) && entry.path !== '.') errors.push(`extensions[${index}].path: must be ./-relative ("${entry.path}")`)
    if (entry.ref !== undefined && !hasGit) errors.push(`extensions[${index}].ref: only a "git" entry takes a ref`)
    if (seen.has(entry.name)) errors.push(`extensions[${index}].name: "${entry.name}" is listed twice`)
    seen.add(entry.name)
  })
  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, catalogue, warnings }
}

export function parseCatalogueText(text: string, options: { strict?: boolean } = {}): CatalogueParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`catalogue is not JSON: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }
  }
  return parseCatalogueValue(raw, options)
}

export type SourceRootRead =
  | { status: 'catalogue'; catalogue: Catalogue; warnings: string[]; path: string }
  | { status: 'single'; catalogue: Catalogue; warnings: string[]; path: string }
  | { status: 'none'; reason: string }
  | { status: 'invalid'; errors: string[]; warnings: string[]; path: string }

/**
 * Read a source root: the catalogue when present, else a single manifest
 * synthesised into a one-entry catalogue (label = the extension's name),
 * else "no catalogue and no manifest at the root".
 */
export function readSourceRoot(root: string, options: { strict?: boolean } = {}): SourceRootRead {
  const cataloguePath = join(root, CATALOGUE_FILE)
  let text: string | null = null
  try {
    text = readFileSync(cataloguePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { status: 'invalid', errors: [`catalogue unreadable: ${error instanceof Error ? error.message : String(error)}`], warnings: [], path: cataloguePath }
    }
  }
  if (text !== null) {
    const parsed = parseCatalogueText(text, options)
    if (!parsed.ok) return { status: 'invalid', errors: parsed.errors, warnings: parsed.warnings, path: cataloguePath }
    const escapes: string[] = []
    parsed.catalogue.extensions.forEach((entry, index) => {
      if (entry.path !== undefined && resolveInsideRoot(root, entry.path) === null) {
        escapes.push(`extensions[${index}].path: "${entry.path}" escapes the source root`)
      }
    })
    if (escapes.length > 0) return { status: 'invalid', errors: escapes, warnings: parsed.warnings, path: cataloguePath }
    return { status: 'catalogue', catalogue: parsed.catalogue, warnings: parsed.warnings, path: cataloguePath }
  }
  const manifest = readManifest(root, options)
  if (manifest.status === 'ok') {
    const m = manifest.manifest
    return {
      status: 'single',
      catalogue: { name: m.name, description: m.description, extensions: [{ name: m.name, version: m.version, description: m.description, path: '.' }] },
      warnings: manifest.warnings,
      path: manifest.path,
    }
  }
  if (manifest.status === 'invalid') return { status: 'invalid', errors: manifest.errors, warnings: manifest.warnings, path: manifest.path }
  return { status: 'none', reason: `no ${CATALOGUE_FILE} or mercury-extension.json at the root` }
}

/** The directory a `path` entry lives in, resolved inside the source root. */
export function entryDirectory(root: string, entry: CatalogueEntry): string | null {
  if (entry.path === undefined) return null
  return resolveInsideRoot(root, entry.path)
}

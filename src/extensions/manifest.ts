// ============================================================================
//  src/extensions/manifest.ts — the ONE manifest: `mercury-extension.json`.
//
//  The schema below is the contract: every field carries `.describe()`, and
//  scripts/extensions/gen-contract.ts renders the maker doc's contract
//  section and the bundled skill's CONTRACT.md from it, so the doc, the
//  skill and the runtime cannot drift apart.
//
//  Posture: unknown TOP-LEVEL keys are a warning at load (the extension
//  still loads — a maker adding a future field must not brick their users)
//  and an error under `mercury extensions validate`. Nested contribution
//  objects are STRICT: a misspelled key inside `hooks` or `servers` is an
//  error at load, because a typo there is far likelier than a legitimate
//  extension. `module` is reserved: a manifest carrying it is broken with
//  the honest reason.
// ============================================================================
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { stripBOM } from '../utils/jsonRead.js'
import { z } from 'zod'
import { HOOK_EVENTS } from '../entrypoints/sdk/coreTypes.js'
import { LspServerConfigSchema } from '../services/lsp/schema.js'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'
import { MANIFEST_FILE } from './paths.js'
import { treeFileDigests } from './tree.js'

// ── grammars (contract data) ────────────────────────────────────────────────

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
export const NAME_RULE = 'lowercase letters, digits and hyphens, 1–40 characters, starting with a letter or digit'
export const RESERVED_LABELS = ['project', 'session', 'mercury'] as const
export const RESERVED_MODULE_REASON = 'this build loads declarative extensions; `module` is reserved'
export const DESCRIPTION_MAX = 200

/** The template spellings substituted into hook/server command lines. */
export const TEMPLATE_ROOT = '${MERCURY_EXTENSION_ROOT}'
export const TEMPLATE_DATA = '${MERCURY_EXTENSION_DATA}'
export const TEMPLATE_OPTION_PREFIX = '${option.'

/** The kinds a manifest may contribute, in the order the surface lists them. */
export const CONTRIBUTION_KINDS = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'servers',
  'language',
  'channels',
  'keybindings',
] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** The per-contribution switches the operator can flip (commands ride with skills). */
export const SWITCH_KINDS = ['hooks', 'servers', 'language', 'agents', 'skills', 'channels', 'keybindings'] as const
export type SwitchKind = (typeof SWITCH_KINDS)[number]

// ── schema ──────────────────────────────────────────────────────────────────

const relativeDirSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .describe('A directory path relative to the extension root (`./skills`). It must stay inside the root.'),
)

const commandHookSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal('command').describe('Only command hooks may be contributed: a shell command Mercury runs on the event.'),
    command: z
      .string()
      .min(1)
      .describe('The command line. `${MERCURY_EXTENSION_ROOT}`, `${MERCURY_EXTENSION_DATA}` and `${option.KEY}` substitute before it runs.'),
    timeout: z.number().positive().optional().describe('Timeout for this hook, in seconds. Unset uses the hook engine default.'),
    shell: z.enum(SHELL_TYPES).optional().describe("Shell to run the command with: 'bash' or 'powershell'. Defaults to bash."),
    async: z.boolean().optional().describe('Run in the background without blocking the event.'),
    asyncRewake: z.boolean().optional().describe('Run in the background and wake the model when the hook exits with the blocking status. Implies async.'),
    if: z.string().optional().describe('Condition in permission-rule syntax (a tool name with an optional parenthesised pattern); the hook runs only when it matches.'),
    statusMessage: z.string().optional().describe('Message shown in the spinner while the hook runs.'),
    once: z.boolean().optional().describe('Run this hook once per session, then remove it.'),
  }),
)

const hookMatcherSchema = lazySchema(() =>
  z.strictObject({
    matcher: z.string().optional().describe('Pattern matched against event-related values, typically tool names (`Write|Edit`). Absent matches everything.'),
    hooks: z.array(commandHookSchema()).min(1).describe('The commands to run when the matcher matches.'),
  }),
)

const stdioServerSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal('stdio').optional().describe("The transport. Absent means 'stdio'."),
    command: z.string().min(1).describe('The executable. `${MERCURY_EXTENSION_ROOT}` and `${option.KEY}` substitute; a bare name is looked up on PATH.'),
    args: z.array(z.string()).optional().describe('Arguments, each substituted the same way.'),
    env: z.record(z.string(), z.string()).optional().describe('Environment for the server process, values substituted. MERCURY_EXTENSION_ROOT and MERCURY_EXTENSION_DATA are always set.'),
  }),
)

const remoteServerSchema = lazySchema(() =>
  z.strictObject({
    type: z.enum(['http', 'sse']).describe("The transport: 'http' (streamable HTTP) or 'sse'."),
    // C15: min(1) accepted ANY non-empty string — 'javascript:…', 'file:…',
    // no URL at all — and it rendered as an ordinary endpoint on the trust
    // card. The transports ride HTTP(S), so the scheme is the floor;
    // `${option.KEY}` still substitutes in the rest.
    url: z
      .string()
      .min(1)
      .regex(/^https?:\/\//i, "must start with http:// or https:// (the transport rides HTTP; `${option.KEY}` substitutes in the rest)")
      .describe('The endpoint URL. `${option.KEY}` substitutes.'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers, values substituted.'),
  }),
)

const serverSchema = lazySchema(() => z.union([stdioServerSchema(), remoteServerSchema()]))

const channelSchema = lazySchema(() =>
  z.strictObject({
    server: z.string().min(1).describe("One of THIS extension's servers (its key under `servers`)."),
    label: z.string().min(1).describe('How the channel is named on the approval card and in the session.'),
  }),
)

const optionSchema = lazySchema(() =>
  z.strictObject({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']).describe('The value kind the operator is asked for.'),
    title: z.string().optional().describe('The short label shown when the operator is asked.'),
    description: z.string().optional().describe('One line explaining what the value is for.'),
    required: z.boolean().optional().describe('A required option left empty makes the extension partial with the reason "option X not set".'),
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional().describe('The value used until the operator sets one.'),
    sensitive: z.boolean().optional().describe('Stored in the secure store, never the settings file; never substituted into prose the model reads (a placeholder naming the key appears instead).'),
    multiple: z.boolean().optional().describe('Accept a list of values.'),
    min: z.number().optional().describe('Lower bound for a number option.'),
    max: z.number().optional().describe('Upper bound for a number option.'),
  }),
)

export const ContributesSchema = lazySchema(() =>
  z.strictObject({
    skills: z.array(relativeDirSchema()).optional().describe('Directories whose child directories each hold a SKILL.md — one skill each, registered as /<name>:<skill>.'),
    commands: z.array(relativeDirSchema()).optional().describe('Directories of <cmd>.md prompt files (one level deep; a subdirectory namespaces /<name>:<dir>:<cmd>), registered as /<name>:<cmd>.'),
    agents: z.array(relativeDirSchema()).optional().describe('Directories of <agent>.md definitions, registered as agent type <name>:<agent>. Privilege-raising frontmatter (permission mode, hooks, servers) is ignored with a health note.'),
    hooks: z
      .record(z.string(), z.array(hookMatcherSchema()))
      .optional()
      .describe("Hook event name → matchers → command hooks, the operator's own hooks shape. The event names are the hook registry's list; a name outside it is skipped with a health note."),
    servers: z
      .record(z.string(), serverSchema())
      .optional()
      .describe("MCP servers by short name, the operator's own server shape (stdio, http or sse). Connected as ext:<name>:<server>; their tools pass the permission engine like any MCP tool."),
    language: z
      .record(z.string(), LspServerConfigSchema())
      .optional()
      .describe("Language servers by short name, Mercury's language-server config shape. Started as ext:<name>:<server>."),
    channels: z.array(channelSchema()).optional().describe("Servers of this extension allowed to post channel messages into the session after approval. A server not declared here has its posts dropped with a health note."),
    keybindings: z
      .record(z.string(), z.string())
      .optional()
      .describe("Default chords → one of THIS extension's own commands or skills (`/<name>:…`). Applied only when the operator's keybindings leave the chord free."),
  }),
)

export const NeedsSchema = lazySchema(() =>
  z.strictObject({
    binaries: z.array(z.string().min(1)).optional().describe('Executables that must be on PATH. Probed at health time; missing ⇒ partial with "x not on PATH".'),
    env: z.array(z.string().min(1)).optional().describe('Environment variables the extension reads. Probed; unset ⇒ partial with "X unset".'),
    network: z.array(z.string().min(1)).optional().describe('Hosts it talks to. Informative: painted on the approval card and the detail pane; not enforced.'),
    options: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'option keys are identifiers (letters, digits, underscore)'), optionSchema())
      .optional()
      .describe('Operator-configured values, collected on approval and editable later. Each reaches hooks as MERCURY_EXTENSION_OPTION_<KEY> and substitutes as `${option.KEY}`.'),
  }),
)

const authorSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().min(1).describe("The author's name."),
    url: z.string().url().optional().describe("The author's URL."),
  }),
)

export const ExtensionManifestSchema = lazySchema(() =>
  z.object({
    name: z.string().regex(NAME_PATTERN, `name: ${NAME_RULE}`).describe(`The extension's name — half of its id (<name>@<source label>) and the namespace of every contribution. ${NAME_RULE}.`),
    version: z.string().min(1).regex(/^\S+$/, 'version: no whitespace').describe('Any non-empty string without whitespace. Keys updates and approval; Mercury detects "different", the catalogue says which is newer.'),
    description: z.string().min(1).max(DESCRIPTION_MAX).refine(s => !s.includes('\n'), 'description: one line').describe(`One line, at most ${DESCRIPTION_MAX} characters; painted on the row.`),
    author: authorSchema().optional().describe('Shown in the detail pane.'),
    homepage: z.string().url().optional().describe('A URL, shown in the detail pane.'),
    license: z.string().optional().describe('The licence identifier, shown in the detail pane.'),
    mercury: z
      .string()
      .regex(/^>=\d+\.\d+\.\d+/, 'mercury: a version floor of the form >=x.y.z')
      .optional()
      .describe('A version floor (`>=x.y.z`). Unmet ⇒ broken with the reason "needs Mercury ≥ x.y.z".'),
    contributes: ContributesSchema().optional().describe('What the extension adds to Mercury. Every kind mirrors what the operator can place by hand in the project config estate.'),
    needs: NeedsSchema().optional().describe('What the extension requires from the machine and the operator.'),
    module: z.unknown().optional().describe(`Reserved for the in-process code tier. ${RESERVED_MODULE_REASON}.`),
  }),
)

export type ExtensionManifest = z.infer<ReturnType<typeof ExtensionManifestSchema>>
export type ManifestContributes = NonNullable<ExtensionManifest['contributes']>
export type ManifestNeeds = NonNullable<ExtensionManifest['needs']>
export type ManifestOption = z.infer<ReturnType<typeof optionSchema>>
export type ManifestHookMatcher = z.infer<ReturnType<typeof hookMatcherSchema>>
export type ManifestServer = z.infer<ReturnType<typeof serverSchema>>

/** The top-level keys the runtime knows; anything else is unknown. */
export const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'license',
  'mercury',
  'contributes',
  'needs',
  'module',
])

/** Side files a maker might expect Mercury to read; it reads none of them. */
export const IGNORED_SIDE_FILES = ['hooks/hooks.json', '.mcp.json', '.lsp.json', 'settings.json'] as const

// ── parsing ─────────────────────────────────────────────────────────────────

export type ManifestParse =
  | { ok: true; manifest: ExtensionManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(p => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[')
}

/**
 * Parse manifest text. `strict` turns unknown top-level keys into errors
 * (the validator); the loader leaves them as warnings.
 */
export function parseManifestText(text: string, options: { strict?: boolean } = {}): ManifestParse {
  let raw: unknown
  try {
    // C15 (BOM class): a BOM-led manifest.json — Windows Notepad's default —
    // IS valid JSON to its author; refusing it as 'not JSON' was a lie.
    raw = JSON.parse(stripBOM(text))
  } catch (error) {
    return { ok: false, errors: [`manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }
  }
  return parseManifestValue(raw, options)
}

export function parseManifestValue(raw: unknown, options: { strict?: boolean } = {}): ManifestParse {
  const warnings: string[] = []
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'], warnings }
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      const line = `unknown top-level key "${key}"`
      if (options.strict) errors.push(line)
      else warnings.push(line)
    }
  }
  const parsed = ExtensionManifestSchema().safeParse(record)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issuePath(issue.path) || '<root>'}: ${issue.message}`)
    }
  }
  if (record['module'] !== undefined) {
    errors.push(RESERVED_MODULE_REASON)
  }
  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, manifest: parsed.success ? parsed.data : (record as ExtensionManifest), warnings }
}

export type ManifestRead =
  | { status: 'ok'; manifest: ExtensionManifest; warnings: string[]; path: string }
  | { status: 'missing'; path: string }
  | { status: 'invalid'; errors: string[]; warnings: string[]; path: string }

/** Read `<dir>/mercury-extension.json`. A missing file is not an extension. */
export function readManifest(dir: string, options: { strict?: boolean } = {}): ManifestRead {
  const path = join(dir, MANIFEST_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing', path }
    return { status: 'invalid', errors: [`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`], warnings: [], path }
  }
  const parsed = parseManifestText(text, options)
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors, warnings: parsed.warnings, path }
  const pathErrors = manifestPathErrors(parsed.manifest, dir)
  if (pathErrors.length > 0) return { status: 'invalid', errors: pathErrors, warnings: parsed.warnings, path }
  return { status: 'ok', manifest: parsed.manifest, warnings: parsed.warnings, path }
}

// ── path containment ────────────────────────────────────────────────────────

/** Resolve a manifest-relative path against the root; null when it escapes. */
export function resolveInsideRoot(root: string, declared: string): string | null {
  const absoluteRoot = resolve(root)
  const candidate = isAbsolute(declared) ? resolve(declared) : resolve(absoluteRoot, declared)
  const rel = relative(absoluteRoot, candidate)
  if (rel === '') return candidate
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  if (rel.split(sep)[0] === '..') return null
  return candidate
}

/** Every declared directory must stay inside the root — an escape is a manifest error. */
export function manifestPathErrors(manifest: ExtensionManifest, root: string): string[] {
  const errors: string[] = []
  const contributes = manifest.contributes ?? {}
  for (const kind of ['skills', 'commands', 'agents'] as const) {
    const dirs = contributes[kind] ?? []
    dirs.forEach((dir, index) => {
      if (resolveInsideRoot(root, dir) === null) {
        errors.push(`contributes.${kind}[${index}]: path "${dir}" resolves outside the extension root`)
      }
    })
  }
  return errors
}

// ── the contributions hash (the approval key) ───────────────────────────────

/** Canonical JSON: sorted keys, no whitespace, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const HASH_EXCEPT: ReadonlySet<string> = new Set([MANIFEST_FILE])

/**
 * sha256 over the canonicalised `contributes` + `needs` blocks PLUS every
 * delivered byte under the extension root (per-file digests keyed by
 * relative path). The operator's approval binds to what the extension
 * DELIVERS — skill, command and agent bodies, hook and server scripts —
 * so a changed byte re-asks (E008-52). The root-level manifest itself
 * stays OUT of the file set: its consent-relevant halves are already the
 * canonical blocks, and keeping its bytes out lets a version-bump-only
 * update carry the approval instead of nagging.
 */
export function contributionsHash(manifest: Pick<ExtensionManifest, 'contributes' | 'needs'>, root: string): string {
  const files = treeFileDigests(root, { except: HASH_EXCEPT })
  const canonical = canonicalJson({ contributes: manifest.contributes ?? {}, needs: manifest.needs ?? {}, files })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—'
  const body = hash.replace(/^sha256:/, '')
  return body.slice(0, 7)
}

// ── ids and namespacing ─────────────────────────────────────────────────────

export function extensionId(name: string, label: string): string {
  return `${name}@${label}`
}

export function parseExtensionId(id: string): { name: string; label: string } | null {
  const at = id.indexOf('@')
  if (at <= 0 || at === id.length - 1) return null
  return { name: id.slice(0, at), label: id.slice(at + 1) }
}

/** `ext:<name>:<server>` — the fixed prefix an operator server can never take. */
export const SERVER_PREFIX = 'ext:'

export function serverRuntimeName(name: string, server: string): string {
  return `${SERVER_PREFIX}${name}:${server}`
}

export function parseServerRuntimeName(runtimeName: string): { name: string; server: string } | null {
  if (!runtimeName.startsWith(SERVER_PREFIX)) return null
  const rest = runtimeName.slice(SERVER_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0 || colon === rest.length - 1) return null
  return { name: rest.slice(0, colon), server: rest.slice(colon + 1) }
}

export function isReservedLabel(label: string): boolean {
  return (RESERVED_LABELS as readonly string[]).includes(label)
}

/** The hook registry's vocabulary — the contract for `contributes.hooks` keys. */
export const HOOK_EVENT_NAMES: ReadonlySet<string> = new Set(HOOK_EVENTS)

/** Which contribution kinds a manifest declares (non-empty). */
export function declaredKinds(manifest: ExtensionManifest): ContributionKind[] {
  const c = manifest.contributes ?? {}
  const out: ContributionKind[] = []
  for (const kind of CONTRIBUTION_KINDS) {
    const value = c[kind]
    if (value === undefined) continue
    if (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0) out.push(kind)
  }
  return out
}

/** Counts by kind for the `adds` column. */
export function contributionCounts(manifest: ExtensionManifest): Partial<Record<ContributionKind, number>> {
  const c = manifest.contributes ?? {}
  const counts: Partial<Record<ContributionKind, number>> = {}
  if (c.skills?.length) counts.skills = c.skills.length
  if (c.commands?.length) counts.commands = c.commands.length
  if (c.agents?.length) counts.agents = c.agents.length
  if (c.hooks) {
    let n = 0
    for (const matchers of Object.values(c.hooks)) for (const m of matchers) n += m.hooks.length
    if (n > 0) counts.hooks = n
  }
  if (c.servers && Object.keys(c.servers).length) counts.servers = Object.keys(c.servers).length
  if (c.language && Object.keys(c.language).length) counts.language = Object.keys(c.language).length
  if (c.channels?.length) counts.channels = c.channels.length
  if (c.keybindings && Object.keys(c.keybindings).length) counts.keybindings = Object.keys(c.keybindings).length
  return counts
}

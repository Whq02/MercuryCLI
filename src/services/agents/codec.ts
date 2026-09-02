// ============================================================================
//  codec — the ONE lossless agent-document decoder/patcher/serializer.
//
//  Truth rules:
//    · The TYPED decode rides parseFrontmatter (the same preprocessing +
//      parser the runtime loader uses), so codec fields ≡ loader fields by
//      construction — never a second YAML dialect.
//    · The LAYOUT model (line spans per top-level key) exists only for
//      surgical edits: patching one key splices exactly that key's lines and
//      byte-preserves everything else — unknown keys, comments, ordering,
//      quoting, the body, the fences, and the newline convention.
//    · Every patch is verified by RE-DECODING the result: if the edited keys
//      do not decode to the intended values, the patch throws
//      AgentCodecPatchError and writes nothing. Fail-closed, never a silent
//      coercion.
//    · Full reformat is a SEPARATE explicit action (serializeAgentMarkdown on
//      a fresh field set) — an edit never rewrites the whole document.
// ============================================================================
import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import { isInstructionProfile } from '../instructions/profile.js'
import { EFFORT_LEVELS, parseEffortValue } from '../../utils/effort.js'
import {
  FRONTMATTER_REGEX,
  type FrontmatterData,
  parseFrontmatter,
  parsePositiveIntFromFrontmatter,
} from '../../utils/frontmatterParser.js'
import {
  agentToolsFrontmatterProblem,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from '../../utils/markdownConfigLoader.js'
import {
  PERMISSION_MODES,
  decodePermissionModeSpelling,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import {
  AGENT_SPEC_VERSION,
  AgentCodecPatchError,
  type AgentDiagnostic,
  type AgentDocument,
  type AgentDocumentEdit,
  type AgentSpecFields,
  type FrontmatterEntrySpan,
  KNOWN_AGENT_KEYS,
} from './contracts.js'

// The same "needs quoting" heuristic frontmatterParser applies on read — a
// value we emit unquoted must survive that preprocessing unchanged.
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`'"]|: /
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+)\s*:(.*)$/

/** Frontmatter key ↔ typed field name (they differ only for spec-version). */
const FIELD_TO_KEY: Record<string, string> = { specVersion: 'spec-version' }
const KEY_TO_FIELD: Record<string, keyof AgentSpecFields> = {
  'spec-version': 'specVersion',
}
function keyForField(field: string): string {
  return FIELD_TO_KEY[field] ?? field
}

function isKnownKey(key: string): boolean {
  return (KNOWN_AGENT_KEYS as readonly string[]).includes(key)
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function isBlankOrComment(line: string): boolean {
  const s = stripCr(line).trim()
  return s === '' || s.startsWith('#')
}

/** Build layout spans over the frontmatter lines. Trailing comment/blank runs
 *  inside a span re-attach to the FOLLOWING entry (a comment above a key
 *  documents that key and must move/survive with it). */
function computeEntrySpans(lines: string[]): FrontmatterEntrySpan[] {
  const spans: FrontmatterEntrySpan[] = []
  let current: FrontmatterEntrySpan | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i] ?? '')
    const m = line.match(TOP_LEVEL_KEY)
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current) {
        current.endLine = i
        spans.push(current)
      }
      const rest = (m[2] ?? '').trim()
      let style: FrontmatterEntrySpan['style']
      if (rest === '') style = 'empty'
      else if (rest.startsWith('[')) style = 'flow-list'
      else if (rest.startsWith('|') || rest.startsWith('>')) style = 'nested'
      else style = 'scalar'
      current = { key: m[1] ?? '', startLine: i, endLine: i + 1, style }
    } else if (current) {
      current.endLine = i + 1
      // An empty-valued key followed by sequence/mapping lines is a block
      // collection; refine the style from the first continuation line.
      if (current.style === 'empty' && !isBlankOrComment(line)) {
        current.style = /^\s*-\s/.test(line) ? 'block-seq' : 'nested'
      }
    }
    // lines before the first key (comments/blanks) belong to no entry
  }
  if (current) {
    current.endLine = lines.length
    spans.push(current)
  }
  // Re-attach trailing comment/blank runs to the following entry.
  for (let s = 0; s < spans.length - 1; s++) {
    const span = spans[s]!
    let end = span.endLine
    while (end > span.startLine + 1 && isBlankOrComment(lines[end - 1] ?? '')) {
      end--
    }
    if (end !== span.endLine) {
      spans[s + 1]!.startLine = end
      span.endLine = end
    }
  }
  return spans
}

/** The ONE typed extraction — mirrors the runtime loader's semantics exactly
 * Never throws; every
 *  invalid value becomes a diagnostic and the field stays absent. */
function extractFields(
  frontmatter: FrontmatterData,
  diagnostics: AgentDiagnostic[],
  lineOf: (key: string) => number | undefined,
): { fields: AgentSpecFields; unknownKeys: string[] } {
  const diag = (
    severity: AgentDiagnostic['severity'],
    code: string,
    field: string,
    message: string,
  ): void => {
    diagnostics.push({ severity, code, message, field, line: lineOf(field) })
  }

  const nameRaw = frontmatter['name']
  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : ''
  if (!name) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-name',
      message: "Missing required 'name' field in frontmatter",
      field: 'name',
    })
  }

  const descRaw = frontmatter['description']
  let description = ''
  if (typeof descRaw === 'string' && descRaw) {
    // Unescape newlines that were escaped for single-line YAML (the loader's
    // long-standing convention; a literal backslash-n is indistinguishable —
    // a known, documented limitation carried over unchanged).
    description = descRaw.replace(/\\n/g, '\n')
  } else {
    diag(
      'error',
      'missing-description',
      'description',
      "Missing required 'description' field in frontmatter",
    )
  }

  const fields: AgentSpecFields = { name, description }

  // An unreadable restriction refuses the DEFINITION (FC-142): activating a
  // file whose `tools:` could not be read hands the agent the widest grant a
  // restriction author cannot have meant — and for disallowedTools, dropping
  // unread entries widens the deny the other way. Same law as the writer:
  // error diagnostics refuse.
  const toolsProblem = agentToolsFrontmatterProblem(frontmatter['tools'])
  if (toolsProblem) {
    diag(
      'error',
      'invalid-tools',
      'tools',
      `tools must be a list of tool names — got ${toolsProblem}`,
    )
  } else {
    const tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])
    if (tools !== undefined) fields.tools = tools
  }

  if (frontmatter['disallowedTools'] !== undefined) {
    const disallowedProblem = agentToolsFrontmatterProblem(frontmatter['disallowedTools'])
    if (disallowedProblem) {
      diag(
        'error',
        'invalid-disallowed-tools',
        'disallowedTools',
        `disallowedTools must be a list of tool names — got ${disallowedProblem}`,
      )
    } else {
      const disallowed = parseAgentToolsFromFrontmatter(
        frontmatter['disallowedTools'],
      )
      if (disallowed !== undefined) fields.disallowedTools = disallowed
    }
  }

  const skills = parseSlashCommandToolsFromFrontmatter(frontmatter['skills'])
  if (skills.length > 0) fields.skills = skills

  const mcpServersRaw = frontmatter['mcpServers']
  if (mcpServersRaw !== undefined) {
    if (Array.isArray(mcpServersRaw)) {
      fields.mcpServers = mcpServersRaw
    } else {
      diag(
        'error',
        'invalid-mcp-servers',
        'mcpServers',
        'mcpServers must be a list of server names or inline definitions',
      )
    }
  }

  if (frontmatter['hooks'] !== undefined && frontmatter['hooks'] !== null) {
    fields.hooks = frontmatter['hooks']
  }

  const colorRaw = frontmatter['color']
  if (colorRaw !== undefined) {
    if (
      typeof colorRaw === 'string' &&
      AGENT_COLORS.includes(colorRaw as AgentColorName)
    ) {
      fields.color = colorRaw as AgentColorName
    } else {
      diag(
        'warning',
        'invalid-color',
        'color',
        `Invalid color '${String(colorRaw)}'. Valid options: ${AGENT_COLORS.join(', ')}`,
      )
    }
  }

  const modelRaw = frontmatter['model']
  if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
    const trimmed = modelRaw.trim()
    fields.model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
  }

  const effortRaw = frontmatter['effort']
  if (effortRaw !== undefined && effortRaw !== null) {
    const parsed = parseEffortValue(effortRaw)
    if (parsed !== undefined) {
      fields.effort = parsed
    } else {
      diag(
        'error',
        'invalid-effort',
        'effort',
        `Invalid effort '${String(effortRaw)}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }
  }

  const profileRaw = frontmatter['instructionProfile']
  if (profileRaw !== undefined) {
    if (isInstructionProfile(profileRaw)) {
      fields.instructionProfile = profileRaw
    } else {
      diag(
        'error',
        'invalid-instruction-profile',
        'instructionProfile',
        `Invalid instructionProfile '${String(profileRaw)}'. Valid options: auto, native`,
      )
    }
  }

  const permissionModeRaw = frontmatter['permissionMode']
  if (permissionModeRaw !== undefined) {
    // Agent files persist on disk (and arrive from the `.claude/` compat
    // estate), so a retired mode spelling decodes through the bounded alias
    // before validation; re-emission writes only the new id.
    const permissionModeDecoded =
      typeof permissionModeRaw === 'string'
        ? decodePermissionModeSpelling(permissionModeRaw)
        : permissionModeRaw
    if (
      typeof permissionModeDecoded === 'string' &&
      (PERMISSION_MODES as readonly string[]).includes(permissionModeDecoded)
    ) {
      fields.permissionMode = permissionModeDecoded as PermissionMode
    } else {
      diag(
        'error',
        'invalid-permission-mode',
        'permissionMode',
        `Invalid permissionMode '${String(permissionModeRaw)}'. Valid options: ${PERMISSION_MODES.join(', ')}`,
      )
    }
  }

  const maxTurnsRaw = frontmatter['maxTurns']
  if (maxTurnsRaw !== undefined) {
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurns !== undefined) {
      fields.maxTurns = maxTurns
    } else {
      diag(
        'error',
        'invalid-max-turns',
        'maxTurns',
        `Invalid maxTurns '${String(maxTurnsRaw)}'. Must be a positive integer.`,
      )
    }
  }

  const backgroundRaw = frontmatter['background']
  if (backgroundRaw !== undefined) {
    if (
      backgroundRaw === 'true' ||
      backgroundRaw === 'false' ||
      backgroundRaw === true ||
      backgroundRaw === false
    ) {
      if (backgroundRaw === 'true' || backgroundRaw === true) {
        fields.background = true
      }
    } else {
      diag(
        'error',
        'invalid-background',
        'background',
        `Invalid background value '${String(backgroundRaw)}'. Must be 'true', 'false', or omitted.`,
      )
    }
  }

  const initialPromptRaw = frontmatter['initialPrompt']
  if (typeof initialPromptRaw === 'string' && initialPromptRaw.trim()) {
    fields.initialPrompt = initialPromptRaw
  }

  const memoryRaw = frontmatter['memory']
  if (memoryRaw !== undefined && memoryRaw !== null) {
    const VALID: AgentMemoryScope[] = ['user', 'project', 'local']
    if (VALID.includes(memoryRaw as AgentMemoryScope)) {
      fields.memory = memoryRaw as AgentMemoryScope
    } else {
      diag(
        'error',
        'invalid-memory',
        'memory',
        `Invalid memory value '${String(memoryRaw)}'. Valid options: ${VALID.join(', ')}`,
      )
    }
  }

  const isolationRaw = frontmatter['isolation']
  if (isolationRaw !== undefined && isolationRaw !== null) {
    if (isolationRaw === 'worktree') {
      fields.isolation = 'worktree'
    } else {
      diag(
        'error',
        'invalid-isolation',
        'isolation',
        `Invalid isolation value '${String(isolationRaw)}'. Valid options: worktree`,
      )
    }
  }

  const specVersionRaw = frontmatter['spec-version']
  if (specVersionRaw !== undefined && specVersionRaw !== null) {
    const v = parsePositiveIntFromFrontmatter(specVersionRaw)
    if (v !== undefined) {
      fields.specVersion = v
      if (v > AGENT_SPEC_VERSION) {
        diag(
          'info',
          'future-spec-version',
          'spec-version',
          `Declared spec-version ${v} is newer than this build (${AGENT_SPEC_VERSION}); all content is preserved as-is.`,
        )
      }
    } else {
      diag(
        'error',
        'invalid-spec-version',
        'spec-version',
        `Invalid spec-version '${String(specVersionRaw)}'. Must be a positive integer.`,
      )
    }
  }

  const unknownKeys = Object.keys(frontmatter).filter(k => !isKnownKey(k))
  return { fields, unknownKeys }
}

/**
 * The ONE identifier rule (validation, slug derivation, and every LOADING
 * door — writer and loaders hold the same law). An agent's name becomes a
 * filesystem path segment (agent memory) and a line on the inventory, so
 * path words, separators, whitespace and control characters are all
 * outside the grammar. Lives in this leaf so the loaders can run it
 * without a store → watch → loader import cycle.
 */
export function validateAgentIdentifier(name: string): string | null {
  if (!name) return 'Agent identifier is required'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(name)) {
    return 'Identifier must start and end with alphanumerics and contain only letters, numbers, and hyphens'
  }
  if (name.length < 3) return 'Identifier must be at least 3 characters'
  if (name.length > 50) return 'Identifier must be at most 50 characters'
  return null
}

/** Decode raw file text into the lossless document form. Never throws. */
export function decodeAgentDocument(
  raw: string,
  filePath?: string,
): AgentDocument {
  const newline: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n'
  const diagnostics: AgentDiagnostic[] = []
  const match = raw.match(FRONTMATTER_REGEX)

  if (!match) {
    if (raw.trimStart().startsWith('---')) {
      diagnostics.push({
        severity: 'error',
        code: 'unterminated-frontmatter',
        message:
          'Frontmatter opening fence found but no closing fence — the whole file is treated as body',
        line: 1,
      })
    } else {
      diagnostics.push({
        severity: 'error',
        code: 'missing-frontmatter',
        message: 'No YAML frontmatter block found (expected `---` fences)',
        line: 1,
      })
    }
    return {
      raw,
      newline,
      hasFrontmatter: false,
      frontmatterStart: 0,
      frontmatterEnd: 0,
      frontmatterLines: [],
      entries: [],
      body: raw,
      fields: { name: '', description: '' },
      unknownKeys: [],
      diagnostics,
    }
  }

  // Inner text offsets: after the opening fence line, before the closing fence.
  const openEnd = raw.indexOf('\n') + 1
  const inner = match[1] ?? ''
  const frontmatterStart = openEnd
  const frontmatterEnd = openEnd + inner.length
  const body = raw.slice(match[0].length)

  // Verbatim inner lines (no trailing phantom element for the closing '\n').
  const frontmatterLines = inner.length === 0 ? [] : inner.split('\n')
  if (frontmatterLines.length > 0 && frontmatterLines[frontmatterLines.length - 1] === '') {
    frontmatterLines.pop()
  }
  const entries = computeEntrySpans(frontmatterLines)

  // Typed decode through the SAME parser the runtime loader uses.
  const { frontmatter } = parseFrontmatter(raw, filePath)
  const lineOf = (field: string): number | undefined => {
    const key = keyForField(field)
    const span = entries.find(e => e.key === key)
    if (!span) return undefined
    // +1 for the opening fence line, +1 for 1-based numbering.
    let keyLine = span.startLine
    while (
      keyLine < span.endLine &&
      isBlankOrComment(frontmatterLines[keyLine] ?? '')
    ) {
      keyLine++
    }
    return keyLine + 2
  }
  const { fields, unknownKeys } = extractFields(frontmatter, diagnostics, lineOf)

  return {
    raw,
    newline,
    hasFrontmatter: true,
    frontmatterStart,
    frontmatterEnd,
    frontmatterLines,
    entries,
    body,
    fields,
    unknownKeys,
    diagnostics,
  }
}

// ── Value emission ──────────────────────────────────────────────────────────

function quoteDouble(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\\\n')}"`
}

function emitScalar(value: string): string {
  if (value === '') return "''"
  if (
    YAML_SPECIAL_CHARS.test(value) ||
    /^[\s?:,-]|\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]/.test(value)
  ) {
    return quoteDouble(value)
  }
  return value
}

/** Emit the replacement lines for one known key. Lists re-emit in the entry's
 *  existing style (block sequence stays a block sequence). */
function emitEntryLines(
  field: keyof AgentSpecFields,
  value: unknown,
  existingStyle: FrontmatterEntrySpan['style'] | undefined,
): string[] {
  const key = keyForField(field)
  if (value === undefined) return []
  switch (field) {
    case 'name':
    case 'model':
    case 'color':
    case 'memory':
    case 'isolation':
    case 'permissionMode':
    case 'instructionProfile':
      return [`${key}: ${emitScalar(String(value))}`]
    case 'description':
    case 'initialPrompt':
      return [`${key}: ${quoteDouble(String(value))}`]
    case 'maxTurns':
    case 'specVersion':
      return [`${key}: ${String(value)}`]
    case 'background':
      return [`${key}: ${value ? 'true' : 'false'}`]
    case 'effort':
      return [
        `${key}: ${typeof value === 'number' ? String(value) : emitScalar(String(value))}`,
      ]
    case 'tools':
    case 'disallowedTools':
    case 'skills': {
      const items = value as string[]
      if (items.length === 0) return [`${key}:`]
      if (existingStyle === 'block-seq') {
        return [`${key}:`, ...items.map(i => `  - ${emitScalar(i)}`)]
      }
      return [`${key}: ${items.join(', ')}`]
    }
    case 'mcpServers':
    case 'hooks':
      throw new AgentCodecPatchError(
        `Field '${key}' is a nested structure — edit it in the raw view; the codec preserves it but never rewrites it`,
        key,
      )
    default:
      throw new AgentCodecPatchError(`Unpatchable field '${String(field)}'`, key)
  }
}

function fieldsEqual(field: keyof AgentSpecFields, a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (field === 'description' || field === 'initialPrompt') {
    return String(a ?? '') === String(b ?? '')
  }
  return a === b
}

/** Surgically apply a field/body edit. Byte-preserves everything outside the
 *  edited entries; verifies by re-decode; throws AgentCodecPatchError (writing
 *  NOTHING) on any mismatch. */
export function patchAgentDocument(
  doc: AgentDocument,
  edit: AgentDocumentEdit,
): AgentDocument {
  const cr = doc.newline === '\r\n' ? '\r' : ''
  const setEntries = Object.entries(edit.set ?? {}) as [
    keyof AgentSpecFields,
    unknown,
  ][]
  const removes = edit.remove ?? []

  let lines = [...doc.frontmatterLines]
  let spans = computeEntrySpans(lines)

  const spliceEntry = (
    field: keyof AgentSpecFields,
    newLines: string[] | null,
  ): void => {
    const key = keyForField(field)
    const span = spans.find(e => e.key === key)
    if (span) {
      // Keep attached prefix comments; replace from the key line down.
      let keyLine = span.startLine
      while (keyLine < span.endLine && isBlankOrComment(lines[keyLine] ?? '')) {
        keyLine++
      }
      lines.splice(
        keyLine,
        span.endLine - keyLine,
        ...(newLines ?? []).map(l => l + cr),
      )
    } else if (newLines) {
      lines.push(...newLines.map(l => l + cr))
    }
    spans = computeEntrySpans(lines)
  }

  for (const [field, value] of setEntries) {
    const key = keyForField(field)
    const existing = spans.find(e => e.key === key)
    if (value === undefined) {
      spliceEntry(field, null)
      continue
    }
    spliceEntry(field, emitEntryLines(field, value, existing?.style))
  }
  for (const field of removes) {
    spliceEntry(field, null)
  }

  // Lines carry their own '\r' (split preserved it); the joiner is always
  // '\n', and a non-empty inner always ends with one trailing '\n'.
  let newInner = lines.join('\n')
  if (newInner.length > 0) newInner += '\n'

  let newRaw: string
  if (doc.hasFrontmatter) {
    newRaw =
      doc.raw.slice(0, doc.frontmatterStart) +
      newInner +
      doc.raw.slice(doc.frontmatterEnd)
    if (edit.body !== undefined) {
      const beforeBody =
        doc.raw.slice(0, doc.frontmatterStart) +
        newInner +
        doc.raw.slice(doc.frontmatterEnd, doc.raw.length - doc.body.length)
      newRaw = beforeBody + edit.body
    }
  } else {
    // No frontmatter block existed — create one above the body.
    const body = edit.body !== undefined ? edit.body : doc.body
    newRaw = `---${cr}\n${newInner}---${cr}\n${cr}\n${body}`
  }

  const patched = decodeAgentDocument(newRaw)

  // Fail-closed verification: every edited field must decode to its intent.
  for (const [field, value] of setEntries) {
    const got = patched.fields[field]
    if (value === undefined) {
      if (got !== undefined) {
        throw new AgentCodecPatchError(
          `Patched document still carries '${String(field)}' after removal`,
          keyForField(field),
        )
      }
      continue
    }
    if (!fieldsEqual(field, got, value)) {
      throw new AgentCodecPatchError(
        `Patched document decodes '${String(field)}' as ${JSON.stringify(got)} — expected ${JSON.stringify(value)}`,
        keyForField(field),
      )
    }
  }
  for (const field of removes) {
    if (patched.fields[field] !== undefined) {
      throw new AgentCodecPatchError(
        `Patched document still carries '${String(field)}' after removal`,
        keyForField(field),
      )
    }
  }
  if (edit.body !== undefined && patched.body !== edit.body) {
    throw new AgentCodecPatchError('Patched body does not match intent', 'body')
  }

  return patched
}

/** Serialize a FRESH agent document from typed fields + body (creation and
 *  explicit reformat only — edits go through patchAgentDocument). Nested
 *  structures (mcpServers/hooks) are never authored here. */
export function serializeAgentMarkdown(
  fields: AgentSpecFields,
  body: string,
): string {
  if (fields.mcpServers !== undefined || fields.hooks !== undefined) {
    throw new AgentCodecPatchError(
      'serializeAgentMarkdown cannot author nested structures (mcpServers/hooks) — clone the source document instead',
      fields.mcpServers !== undefined ? 'mcpServers' : 'hooks',
    )
  }
  const lines: string[] = []
  const push = (field: keyof AgentSpecFields): void => {
    const value = fields[field]
    if (value === undefined) return
    // Omit `tools` entirely for all-tools (undefined already returns above);
    // an explicit empty list is emitted as an empty value (= no tools).
    lines.push(...emitEntryLines(field, value, undefined))
  }
  push('name')
  push('description')
  push('tools')
  push('disallowedTools')
  push('skills')
  push('model')
  push('effort')
  push('permissionMode')
  push('maxTurns')
  push('memory')
  push('background')
  push('isolation')
  push('initialPrompt')
  push('instructionProfile')
  push('color')
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/\s+$/, '')}\n`
}

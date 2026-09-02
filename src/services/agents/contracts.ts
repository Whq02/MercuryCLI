// ============================================================================
//  contracts — the ONE typed, versioned agent-definition layer.
//
//  An agent definition on disk is a Markdown file with YAML frontmatter (the
//  native format, unchanged). This module names the typed contract every
//  consumer shares:
//
//    · AgentSpecFields  — the typed KNOWN fields (superset the runtime loader
//                         understands; loadAgentsDir maps them onto
//                         AgentDefinition and stays the runtime projection).
//    · AgentDocument    — the LOSSLESS document form (codec.ts): typed fields
//                         + unknown-key passthrough + exact layout, so editing
//                         one field never erases anything else.
//    · AgentFileIdentity— the exact discovered file identity: path + revision
//                         digest. Edits/deletes address THIS, never a path
//                         reconstructed from cwd or display name.
//    · AgentDiagnostic  — the one diagnostics shape (Studio, CLI, /health).
//
//  Versioning: today's on-disk format IS spec v1 (`AGENT_SPEC_VERSION`). Files
//  MAY carry a `spec-version` key; absent ⇒ 1. Fresh writes deliberately omit
//  it so native files stay byte-compatible with the shared `.claude` ecosystem;
//  a future v2 starts stamping. A file declaring a NEWER version is preserved
//  losslessly and flagged (info) — never coerced, never dropped.
// ============================================================================
import { createHash } from 'node:crypto'
import type { InstructionProfile } from '../../services/instructions/contracts.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import type { EffortValue } from '../../utils/effort.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'

export const AGENT_SPEC_VERSION = 1

/** The typed known fields of an agent definition (frontmatter + body).
 *  Optionality mirrors the runtime loader: absent means "not declared". */
export type AgentSpecFields = {
  /** Stable identifier (`name:`). Identity comes from THIS, not the filename. */
  name: string
  /** Delegation cue (`description:`) — newline-unescaped semantic value. */
  description: string
  /** undefined = all tools; [] = none (mirrors parseAgentToolsFromFrontmatter). */
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  /** Raw mcpServers entries — validated by the loader's zod schema (the one
   *  validator); preserved verbatim by the codec. */
  mcpServers?: unknown[]
  /** Raw hooks value — validated by HooksSchema at load; preserved verbatim. */
  hooks?: unknown
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  instructionProfile?: InstructionProfile
  permissionMode?: PermissionMode
  maxTurns?: number
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree'
  /** Declared spec version (`spec-version:`); absent ⇒ AGENT_SPEC_VERSION. */
  specVersion?: number
}

/** Frontmatter keys the codec types. Everything else is unknown passthrough. */
export const KNOWN_AGENT_KEYS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'skills',
  'mcpServers',
  'hooks',
  'color',
  'model',
  'effort',
  'instructionProfile',
  'permissionMode',
  'maxTurns',
  'background',
  'initialPrompt',
  'memory',
  'isolation',
  'spec-version',
] as const

export type AgentDiagnosticSeverity = 'error' | 'warning' | 'info'

export type AgentDiagnostic = {
  severity: AgentDiagnosticSeverity
  /** Stable machine code, e.g. 'missing-name', 'invalid-effort', 'shadowed'. */
  code: string
  message: string
  /** 1-based line in the source file, when the location is known. */
  line?: number
  /** The frontmatter key the diagnostic is about, when field-scoped. */
  field?: string
}

/** One top-level frontmatter entry's exact layout (for surgical patching). */
export type FrontmatterEntrySpan = {
  key: string
  /** Index of the first line of this entry WITHIN the frontmatter line array
   *  (comments/blank lines directly above the key attach to the entry). */
  startLine: number
  /** Exclusive end index within the frontmatter line array. */
  endLine: number
  /** Detected value style, used to re-emit edits in kind. */
  style: 'scalar' | 'flow-list' | 'block-seq' | 'nested' | 'empty'
}

/** The lossless document form. `raw` is the exact original text; every edit
 *  path goes through codec.patchAgentDocument so unknown keys, comments,
 *  ordering, and the body survive byte-for-byte outside the edited entry. */
export type AgentDocument = {
  raw: string
  newline: '\n' | '\r\n'
  /** Whether a frontmatter block was found at all. */
  hasFrontmatter: boolean
  /** Offsets of the frontmatter INNER text within `raw` (fences exclusive) —
   *  patching splices this range so both fences stay byte-identical. */
  frontmatterStart: number
  frontmatterEnd: number
  /** The verbatim frontmatter lines (between the `---` fences, exclusive). */
  frontmatterLines: string[]
  /** Layout spans for each top-level key, in file order. */
  entries: FrontmatterEntrySpan[]
  /** The exact body text after the closing fence (verbatim). */
  body: string
  /** Typed decode of the known keys (the ONE extraction). */
  fields: AgentSpecFields
  /** Top-level keys present but not typed — preserved passthrough. */
  unknownKeys: string[]
  /** Parse/typing diagnostics found during decode. */
  diagnostics: AgentDiagnostic[]
}

/** Exact discovered identity of a file-backed definition. */
export type AgentFileIdentity = {
  /** Absolute path the definition was DISCOVERED at. */
  filePath: string
  /** Content revision digest of the discovered bytes (revisionDigest). */
  revision: string
}

/** Content revision digest — sha256 over the exact file text, 16 hex chars.
 *  Stable, cheap, and long enough that a collision is not a practical event
 *  for a config directory. */
export function revisionDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16)
}

/** Field-level edit request for patchAgentDocument. `set` writes/replaces
 *  keys; `remove` deletes them; `body` replaces the markdown body. Keys not
 *  named are byte-preserved. */
export type AgentDocumentEdit = {
  set?: Partial<AgentSpecFields>
  remove?: (keyof AgentSpecFields)[]
  body?: string
}

export class AgentCodecPatchError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message)
    this.name = 'AgentCodecPatchError'
  }
}

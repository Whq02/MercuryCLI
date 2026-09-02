/* ============================================================================
   capability/manifest — capability descriptor model, validator, and risk-card
   compiler (item 15).
   ----------------------------------------------------------------------------
   For any Tool we derive a small, stable capability descriptor:

     { name, category, risk, provenance }

   and compile it to a one-line risk card, e.g. '[risk:high · exec · builtin]'.

   The descriptor reuses the EXISTING item-2 MCP risk classifier
   (classifyMcpToolRisk in services/mcp/toolPolicy) for MCP tools, and derives a
   risk for built-ins from the Tool interface's own annotations
   (isReadOnly / isDestructive / isOpenWorld) plus a small name-based fallback
   for the inherently-powerful tools (Bash, Web*).

   This core is ADDITIVE and INERT: it reads a tool's annotations and returns a
   descriptor / card string. It never mutates the tool, never decides whether a
   tool is available, and never affects execution. The ToolSearch surfacing that
   consumes compileCapabilityCard only decorates the search listing.

   Dependency-light + defensive: a tool with missing/garbage annotations
   degrades to 'other' / 'medium', and NOTHING here ever throws. Tool predicate
   methods (isReadOnly, isDestructive, isMcp, isOpenWorld) are probed with an
   empty input inside try/catch — a tool that throws on a bad probe input is
   treated as if the signal were absent.
   ============================================================================ */

import {
  classifyMcpToolRisk,
  type McpRisk,
  type McpToolAnnotations,
} from '../../services/mcp/toolPolicy.js'
import type { Tool } from '../../Tool.js'
import { declaredCapability } from './contract.js'

/** Reuse the item-2 risk vocabulary verbatim — low < medium < high. */
export type CapabilityRisk = McpRisk

/**
 * The coarse capability category. Deliberately small and closed:
 *   - read  : read-only inspection (Read, Grep, Glob, list-*, get-*)
 *   - edit  : mutates local files / state (Edit, Write, NotebookEdit)
 *   - exec  : runs arbitrary code / shells (Bash, PowerShell, REPL)
 *   - net   : reaches the network (WebFetch, WebSearch)
 *   - coord : agent / team / task / schedule coordination
 *   - mcp   : an MCP server tool (provenance also names the server)
 *   - other : anything we can't confidently bucket
 */
export type CapabilityCategory =
  | 'read'
  | 'edit'
  | 'exec'
  | 'net'
  | 'coord'
  | 'mcp'
  | 'other'

/**
 * Provenance: where the capability comes from. Built-ins are 'builtin', skills
 * are 'skill', and an MCP tool is 'mcp:<server>' (the server name is part of the
 * provenance so the card names the trust boundary).
 */
export type CapabilityProvenance = 'builtin' | 'skill' | `mcp:${string}`

/** The derived, stable capability descriptor for one tool. */
export interface CapabilityDescriptor {
  name: string
  category: CapabilityCategory
  risk: CapabilityRisk
  provenance: CapabilityProvenance
}

const CATEGORIES: readonly CapabilityCategory[] = [
  'read',
  'edit',
  'exec',
  'net',
  'coord',
  'mcp',
  'other',
]

const RISKS: readonly CapabilityRisk[] = ['low', 'medium', 'high']

/** The Skill tool's name (item-15 provenance maps it to 'skill'). */
const SKILL_TOOL_NAME = 'Skill'

/**
 * Tools that run arbitrary code / shells. Matched case-insensitively as a
 * substring so renamed or aliased variants still resolve
 * (BashTool exports 'Bash', PowerShell, REPL).
 */
const EXEC_NAME_HINTS = ['bash', 'powershell', 'shell', 'repl']

/** Tools that reach the network. */
const NET_NAME_HINTS = ['webfetch', 'websearch', 'fetch']

/**
 * Coordination tools: agents, teams, tasks, schedules, fleets, messaging. These
 * are control-plane, not file/exec; bucketed as 'coord'.
 */
const COORD_NAME_HINTS = [
  'agent',
  'task',
  'team',
  'cron',
  'schedule',
  'wakeup',
  'fleet',
  'sendmessage',
  'remotetrigger',
  'pushnotification',
  'monitor',
  'worktree',
]

/** Read-flavoured built-in name hints (used only as a fallback signal). */
const READ_NAME_HINTS = ['read', 'grep', 'glob', 'search', 'list', 'get']

/** Edit-flavoured built-in name hints. */
const EDIT_NAME_HINTS = ['edit', 'write', 'notebook']

function lc(s: string): string {
  return typeof s === 'string' ? s.toLowerCase() : ''
}

function nameMatchesAny(name: string, hints: readonly string[]): boolean {
  const n = lc(name)
  for (const h of hints) {
    if (n.includes(h)) return true
  }
  return false
}

/**
 * Probe a Tool predicate (isReadOnly / isDestructive / isOpenWorld) with an
 * empty input, defensively. Returns undefined if the method is absent or throws
 * — the caller treats undefined as "signal not present".
 */
function probe(
  fn: ((input: Record<string, never>) => boolean) | undefined,
): boolean | undefined {
  if (typeof fn !== 'function') return undefined
  try {
    return fn({} as Record<string, never>) === true
  } catch {
    return undefined
  }
}

/**
 * Build an McpToolAnnotations-shaped object from a Tool's own predicate methods,
 * so the SAME item-2 classifier (classifyMcpToolRisk) can be reused for MCP
 * tools. The Tool interface exposes isReadOnly / isDestructive / isOpenWorld;
 * these map onto the readOnlyHint / destructiveHint / openWorldHint the
 * classifier reads. Only flags we positively observed are set (an unset flag
 * lets the classifier fall through to 'medium').
 */
function annotationsFromTool(tool: Tool): McpToolAnnotations {
  const out: { [key: string]: unknown } = {}
  const ro = probe(tool.isReadOnly)
  const de = probe(tool.isDestructive)
  const ow = probe(tool.isOpenWorld)
  if (ro !== undefined) out.readOnlyHint = ro
  if (de !== undefined) out.destructiveHint = de
  if (ow !== undefined) out.openWorldHint = ow
  return out
}

/**
 * Resolve a tool's MCP server name, if any. Reuses mcpInfo.serverName (the
 * unnormalized server name) when present; otherwise parses the mcp__server__tool
 * convention off the name. Returns null for non-MCP tools.
 */
function mcpServerName(tool: Tool): string | null {
  if (tool && tool.mcpInfo && typeof tool.mcpInfo.serverName === 'string') {
    const s = tool.mcpInfo.serverName.trim()
    if (s) return s
  }
  const name = typeof tool?.name === 'string' ? tool.name : ''
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const server = rest.split('__')[0]
    if (server) return server
  }
  return null
}

function isMcpTool(tool: Tool): boolean {
  if (!tool) return false
  if (tool.isMcp === true) return true
  return typeof tool.name === 'string' && tool.name.startsWith('mcp__')
}

/** Derive provenance: 'skill' | 'mcp:<server>' | 'builtin'. */
export function deriveProvenance(tool: Tool): CapabilityProvenance {
  if (isMcpTool(tool)) {
    const server = mcpServerName(tool)
    return `mcp:${server ?? 'unknown'}`
  }
  if (typeof tool?.name === 'string' && tool.name === SKILL_TOOL_NAME) {
    return 'skill'
  }
  return 'builtin'
}

/**
 * Derive the coarse category. MCP tools are 'mcp'. Built-ins are bucketed by
 * their own read-only flag first (the strongest signal), then by name hints in
 * priority order (exec > net > coord > edit > read), defaulting to 'other'.
 */
export function deriveCategory(tool: Tool): CapabilityCategory {
  if (isMcpTool(tool)) return 'mcp'
  const name = typeof tool?.name === 'string' ? tool.name : ''

  // Exec / net / coord are intrinsic to the tool regardless of read-only-ness,
  // so they take priority over the read-only fast path.
  if (nameMatchesAny(name, EXEC_NAME_HINTS)) return 'exec'
  if (nameMatchesAny(name, NET_NAME_HINTS)) return 'net'
  if (nameMatchesAny(name, COORD_NAME_HINTS)) return 'coord'

  // Read-only built-ins are 'read'.
  if (probe(tool?.isReadOnly) === true) return 'read'

  if (nameMatchesAny(name, EDIT_NAME_HINTS)) return 'edit'
  if (nameMatchesAny(name, READ_NAME_HINTS)) return 'read'
  return 'other'
}

/**
 * Derive the risk for a tool.
 *
 * MCP tools reuse the item-2 classifier verbatim (classifyMcpToolRisk over the
 * tool's read-only/destructive/open-world flags).
 *
 * Built-ins:
 *   - read-only            → 'low'
 *   - destructive OR exec OR net (Bash, Web*) → 'high'
 *   - otherwise            → 'medium'  (the defensive default)
 */
export function deriveRisk(tool: Tool): CapabilityRisk {
  // MCP: reuse the existing classifier (single source of truth for MCP risk).
  if (isMcpTool(tool)) {
    return classifyMcpToolRisk(annotationsFromTool(tool))
  }

  const readOnly = probe(tool?.isReadOnly)
  if (readOnly === true) return 'low'

  const destructive = probe(tool?.isDestructive)
  const openWorld = probe(tool?.isOpenWorld)
  const name = typeof tool?.name === 'string' ? tool.name : ''

  if (
    destructive === true ||
    openWorld === true ||
    nameMatchesAny(name, EXEC_NAME_HINTS) ||
    nameMatchesAny(name, NET_NAME_HINTS)
  ) {
    return 'high'
  }

  return 'medium'
}

/**
 * Derive a full capability descriptor for a tool. Never throws — a null/garbage
 * tool yields a safe-default descriptor ('other' / 'medium' / 'builtin').
 */
export function deriveCapabilityDescriptor(tool: Tool): CapabilityDescriptor {
  try {
    const name = typeof tool?.name === 'string' ? tool.name : ''
    return {
      name,
      category: deriveCategory(tool),
      risk: deriveRisk(tool),
      provenance: deriveProvenance(tool),
    }
  } catch {
    // Total fail-safe: any unexpected throw still produces a well-formed
    // descriptor rather than propagating.
    return {
      name: typeof tool?.name === 'string' ? tool.name : '',
      category: 'other',
      risk: 'medium',
      provenance: 'builtin',
    }
  }
}

/**
 * Compile a descriptor to a short one-line risk card, e.g.
 *   '[risk:high · exec · builtin]'
 *   '[risk:low · read · builtin]'
 *   '[risk:medium · mcp · mcp:github]'
 *
 * Defensive: a malformed descriptor is coerced to safe defaults rather than
 * throwing, so a caller can blindly decorate any descriptor.
 */
export function compileCapabilityCard(input: unknown): string {
  const d =
    input != null && typeof input === 'object'
      ? (input as Partial<CapabilityDescriptor>)
      : {}
  const category =
    typeof d.category === 'string' &&
    CATEGORIES.includes(d.category as CapabilityCategory)
      ? d.category
      : 'other'
  const risk =
    typeof d.risk === 'string' && RISKS.includes(d.risk as CapabilityRisk)
      ? d.risk
      : 'medium'
  const provenance =
    typeof d.provenance === 'string' && d.provenance.length > 0
      ? d.provenance
      : 'builtin'
  return `[risk:${risk} · ${category} · ${provenance}]`
}

/**
 * Probe a Tool.isEnabled() defensively. Returns `false` ONLY when the tool
 * definitively answers isEnabled()===false; a missing method or a throwing
 * probe reads `true` (absence of signal ⇒ never demote / never mislabel).
 */
function probeToolEnabled(tool: Tool): boolean {
  const fn = (tool as { isEnabled?: () => boolean }).isEnabled
  if (typeof fn !== 'function') return true
  try {
    return fn.call(tool) !== false
  } catch {
    return true
  }
}

/**
 * Convenience: compile the one-line capability card ToolSearch prepends to a
 * tool's search listing. Never throws.
 *
 * When the tool carries a DECLARED capability contract (
 * declaredCapability), the card is upgraded to a capability-aware line:
 *
 *   [mutation · structural-mutation · interactive · available] for: <intents>
 *   [mutation · structural-mutation · interactive · conditional: <cond>] for: …
 *   [mutation · structural-mutation · interactive · unavailable] for: <intents>
 *
 * The availability segment is honest and LIVE-derived: a tool whose
 * isEnabled() returns false reads `unavailable` (never presented as usable);
 * an enabled tool that names runtime conditions reads `conditional: <first
 * condition>`; otherwise `available`. The `for:` tail names the first few
 * declared intents so the search listing states what the tool is FOR.
 *
 * Undeclared tools (MCP servers and any tool without a contract) keep the
 * derived heuristic card `[risk:… · category · provenance]` verbatim — existing
 * behavior is preserved for everything the constitution has not yet declared.
 */
export function compileToolCapabilityCard(tool: Tool): string {
  try {
    const cap = declaredCapability(tool)
    if (cap) {
      const unit = cap.units[0] ?? cap.class
      let availability: string
      if (probeToolEnabled(tool) === false) {
        availability = 'unavailable'
      } else if (cap.conditions && cap.conditions.length > 0) {
        availability = `conditional: ${cap.conditions[0]}`
      } else {
        availability = 'available'
      }
      const intents = cap.intents.slice(0, 3).join('; ')
      return `[${cap.class} · ${unit} · ${cap.latency} · ${availability}] for: ${intents}`
    }
  } catch {
    // Fall through to the derived heuristic card — the card must never throw.
  }
  return compileCapabilityCard(deriveCapabilityDescriptor(tool))
}

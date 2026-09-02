


import {
  classifyMcpToolRisk,
  type McpRisk,
  type McpToolAnnotations,
} from '../../services/mcp/toolPolicy.js'
import type { Tool } from '../../Tool.js'
import { declaredCapability } from './contract.js'

export type CapabilityRisk = McpRisk

export type CapabilityCategory =
  | 'read'
  | 'edit'
  | 'exec'
  | 'net'
  | 'coord'
  | 'mcp'
  | 'other'

export type CapabilityProvenance = 'builtin' | 'skill' | `mcp:${string}`

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

const SKILL_TOOL_NAME = 'Skill'

const EXEC_NAME_HINTS = ['bash', 'powershell', 'shell', 'repl']

const NET_NAME_HINTS = ['webfetch', 'websearch', 'fetch']

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

const READ_NAME_HINTS = ['read', 'grep', 'glob', 'search', 'list', 'get']

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

export function deriveCategory(tool: Tool): CapabilityCategory {
  if (isMcpTool(tool)) return 'mcp'
  const name = typeof tool?.name === 'string' ? tool.name : ''

  if (nameMatchesAny(name, EXEC_NAME_HINTS)) return 'exec'
  if (nameMatchesAny(name, NET_NAME_HINTS)) return 'net'
  if (nameMatchesAny(name, COORD_NAME_HINTS)) return 'coord'

  if (probe(tool?.isReadOnly) === true) return 'read'

  if (nameMatchesAny(name, EDIT_NAME_HINTS)) return 'edit'
  if (nameMatchesAny(name, READ_NAME_HINTS)) return 'read'
  return 'other'
}

export function deriveRisk(tool: Tool): CapabilityRisk {
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
    return {
      name: typeof tool?.name === 'string' ? tool.name : '',
      category: 'other',
      risk: 'medium',
      provenance: 'builtin',
    }
  }
}

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

function probeToolEnabled(tool: Tool): boolean {
  const fn = (tool as { isEnabled?: () => boolean }).isEnabled
  if (typeof fn !== 'function') return true
  try {
    return fn.call(tool) !== false
  } catch {
    return true
  }
}

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
  }
  return compileCapabilityCard(deriveCapabilityDescriptor(tool))
}

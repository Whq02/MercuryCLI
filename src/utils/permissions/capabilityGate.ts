


import { getMainThreadAgentType } from '../../bootstrap/state.js'
import type { Tool } from '../../Tool.js'
import { deriveCategory, deriveRisk, type CapabilityCategory } from '../capability/manifest.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const ALL_AGENTS = '*'
const ALL_TOOLS = '*'

const MCP_PREFIX = 'mcp__'

function mcpServerOfTool(toolName: string): string | undefined {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) {
    return undefined
  }
  const rest = toolName.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  const server = sep === -1 ? rest : rest.slice(0, sep)
  return server || undefined
}

const killStore: Map<string, Set<string>> = new Map()

function normalizeAgentType(agentType: string | undefined): string {
  return agentType ?? ''
}

export function killCapability(
  agentType: string | undefined,
  toolName: string,
): void {
  const tool = typeof toolName === 'string' ? toolName.trim() : ''
  if (!tool) return
  const key = normalizeAgentType(agentType)
  let set = killStore.get(key)
  if (!set) {
    set = new Set<string>()
    killStore.set(key, set)
  }
  set.add(tool)
}

export function restoreCapability(
  agentType: string | undefined,
  toolName: string,
): void {
  const key = normalizeAgentType(agentType)
  const set = killStore.get(key)
  if (!set) return
  set.delete(toolName)
  if (set.size === 0) {
    killStore.delete(key)
  }
}

function currentAgentTypeSafe(): string | undefined {
  try {
    return getMainThreadAgentType()
  } catch {
    return undefined
  }
}

export function isCapabilityKilled(
  toolName: string,
  agentType: string | undefined = currentAgentTypeSafe(),
): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  const key = normalizeAgentType(agentType)
  return (
    setKillsTool(killStore.get(key), toolName) ||
    setKillsTool(killStore.get(ALL_AGENTS), toolName)
  )
}

function setKillsTool(set: Set<string> | undefined, toolName: string): boolean {
  if (!set || set.size === 0) return false
  if (set.has(ALL_TOOLS) || set.has(toolName)) return true
  const server = mcpServerOfTool(toolName)
  if (server && (set.has(server) || set.has(MCP_PREFIX + server))) return true
  if (!toolName.startsWith(MCP_PREFIX)) {
    const folded = toolName.toLowerCase()
    for (const entry of set) {
      if (!entry.startsWith(MCP_PREFIX) && entry.toLowerCase() === folded) return true
    }
  }
  return false
}

export type CapabilityKillReason = { kind: 'capability-gate'; killPattern: string }

export type HermesKillInfo = {
  kind: string
  killPattern?: string
  tool: string
  target?: string
}

export function capabilityKillReason(
  toolName: string,
  agentType: string | undefined = currentAgentTypeSafe(),
): CapabilityKillReason | null {
  if (typeof toolName !== 'string' || toolName.length === 0) return null
  const key = normalizeAgentType(agentType)
  const server = mcpServerOfTool(toolName)
  for (const probeKey of [key, ALL_AGENTS]) {
    const set = killStore.get(probeKey)
    if (!set || set.size === 0) continue
    const agentTok = probeKey === '' ? ALL_AGENTS : probeKey
    let matchedTool: string | undefined
    if (set.has(toolName)) matchedTool = toolName
    else if (set.has(ALL_TOOLS)) matchedTool = ALL_TOOLS
    else if (server && set.has(server)) matchedTool = server
    else if (server && set.has(MCP_PREFIX + server)) matchedTool = MCP_PREFIX + server
    else if (!toolName.startsWith(MCP_PREFIX)) {
      const folded = toolName.toLowerCase()
      matchedTool = [...set].find(e => !e.startsWith(MCP_PREFIX) && e.toLowerCase() === folded)
    }
    if (matchedTool) {
      return { kind: 'capability-gate', killPattern: `${agentTok}:${matchedTool}` }
    }
  }
  return null
}

type AgentCapRule = { maxRisk?: 'low' | 'medium' | 'high'; denyCat?: Set<CapabilityCategory> }
const AGENT_CAP_RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }
const VALID_CATS: ReadonlySet<string> = new Set(['read', 'edit', 'exec', 'net', 'coord', 'mcp', 'other'])

function parseAgentCapPolicyWithRejects(): { policy: Map<string, AgentCapRule>; rejects: string[] } {
  const out = new Map<string, AgentCapRule>()
  const rejects: string[] = []
  const clamped = new Set<string>()
  const rawEnv = flagEnv('MERCURY_AGENT_CAP')
  const raw = typeof rawEnv === 'string' ? rawEnv.trim().replace(/^["']+|["']+$/g, '').trim() : ''
  if (!raw) return { policy: out, rejects }
  const failClosed = (agent: string, offending: string): void => {
    rejects.push(offending)
    clamped.add(agent)
    const existing = out.get(agent) ?? {}
    existing.maxRisk = 'low'
    out.set(agent, existing)
  }
  const segments = raw.split(';')
  for (let i = 0; i < segments.length; i++) {
    const part = (segments[i] ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
    if (!part) continue
    const colon = part.indexOf(':')
    if (colon === -1) {
      rejects.push(part)
      continue
    }
    const agent = part.slice(0, colon).trim() || ALL_AGENTS
    const rule = part.slice(colon + 1).trim()
    const eq = rule.indexOf('=')
    if (eq === -1) {
      failClosed(agent, part)
      continue
    }
    const lhs = rule.slice(0, eq).trim().toLowerCase()
    const rhs = rule.slice(eq + 1).trim()
    const existing = out.get(agent) ?? {}
    if (lhs === 'max-risk') {
      const tokens = rhs.split(',')
      for (const tail of tokens.slice(1)) {
        const t = tail.trim()
        if (!t) continue
        if (t.includes(':') && t.includes('=')) segments.push(t)
        else rejects.push(t)
      }
      const r = (tokens[0] ?? '').trim().toLowerCase()
      if (r === 'low' || r === 'medium' || r === 'high') {
        if (!clamped.has(agent)) existing.maxRisk = r
        out.set(agent, existing)
      } else {
        failClosed(agent, part)
      }
    } else if (lhs === 'deny-cat') {
      const cats = existing.denyCat ?? new Set<CapabilityCategory>()
      let anyValid = false
      for (const c of rhs.split(',')) {
        const cc = c.trim().toLowerCase()
        if (!cc) continue
        if (VALID_CATS.has(cc)) {
          cats.add(cc as CapabilityCategory)
          anyValid = true
        } else {
          rejects.push(cc)
        }
      }
      if (anyValid) {
        existing.denyCat = cats
        out.set(agent, existing)
      } else {
        failClosed(agent, part)
      }
    } else {
      failClosed(agent, part)
    }
  }
  if (out.size === 0 && rejects.length > 0) out.set(ALL_AGENTS, { maxRisk: 'low' })
  return { policy: out, rejects }
}

function parseAgentCapPolicy(): Map<string, AgentCapRule> {
  return parseAgentCapPolicyWithRejects().policy
}

export function getAgentCapParseRejects(): string[] {
  try {
    return parseAgentCapPolicyWithRejects().rejects
  } catch {
    return []
  }
}

function agentPolicyDenies(
  tool: { name: string; aliases?: string[] },
  agentType: string | undefined,
): boolean {
  try {
    if (!flagEnv('MERCURY_AGENT_CAP')) return false
    
    const policy = parseAgentCapPolicy()
    if (policy.size === 0) return false
    const key = normalizeAgentType(agentType ?? currentAgentTypeSafe())
    const specific = policy.get(key)
    const all = policy.get(ALL_AGENTS)
    if (!specific && !all) return false
    const t = tool as Tool
    const risk = deriveRisk(t)
    const cat = deriveCategory(t)
    for (const rule of [specific, all]) {
      if (!rule) continue
      if (rule.maxRisk && AGENT_CAP_RISK_RANK[risk] > AGENT_CAP_RISK_RANK[rule.maxRisk]) return true
      if (rule.denyCat && rule.denyCat.has(cat)) return true
    }
    return false
  } catch {
    return false
  }
}

function agentPolicyReason(
  tool: { name: string; aliases?: string[] },
  agentType: string | undefined,
): CapabilityKillReason | null {
  try {
    if (!flagEnv('MERCURY_AGENT_CAP') || false) return null
    const policy = parseAgentCapPolicy()
    if (policy.size === 0) return null
    const key = normalizeAgentType(agentType ?? currentAgentTypeSafe())
    const t = tool as Tool
    const risk = deriveRisk(t)
    const cat = deriveCategory(t)
    for (const [probeKey, rule] of [
      [key, policy.get(key)] as const,
      [ALL_AGENTS, policy.get(ALL_AGENTS)] as const,
    ]) {
      if (!rule) continue
      const agentTok = probeKey === '' ? ALL_AGENTS : probeKey
      if (rule.maxRisk && AGENT_CAP_RISK_RANK[risk] > AGENT_CAP_RISK_RANK[rule.maxRisk]) {
        return { kind: 'capability-gate', killPattern: `${agentTok}:max-risk=${rule.maxRisk}` }
      }
      if (rule.denyCat && rule.denyCat.has(cat)) {
        return { kind: 'capability-gate', killPattern: `${agentTok}:deny-cat=${cat}` }
      }
    }
    return null
  } catch {
    return null
  }
}

export function isToolKilled(
  tool: { name: string; aliases?: string[] },
  agentType?: string,
): boolean {
  if (isCapabilityKilled(tool.name, agentType)) return true
  for (const alias of tool.aliases ?? []) {
    if (isCapabilityKilled(alias, agentType)) return true
  }
  if (agentPolicyDenies(tool, agentType)) return true
  return false
}

export function toolKillReason(
  tool: { name: string; aliases?: string[] },
  agentType?: string,
): CapabilityKillReason | null {
  const primary = capabilityKillReason(tool.name, agentType)
  if (primary) return primary
  for (const alias of tool.aliases ?? []) {
    const r = capabilityKillReason(alias, agentType)
    if (r) return r
  }
  return agentPolicyReason(tool, agentType)
}

export function listCapabilityKills(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [agentType, tools] of killStore) {
    out[agentType] = [...tools]
  }
  return out
}

export function clearAllCapabilityKills(): void {
  killStore.clear()
}

function seedFromEnv(): void {
  try {
    const raw = flagEnv('MERCURY_KILL')
    if (!raw || typeof raw !== 'string') return
    for (const entry of raw.split(/[,;]/)) {
      const trimmed = entry.trim().replace(/^["']+|["']+$/g, '').trim()
      if (!trimmed) continue
      const sep = trimmed.indexOf(':')
      if (sep === -1) {
        killCapability(ALL_AGENTS, trimmed)
      } else {
        const agentType = trimmed.slice(0, sep).trim() || ALL_AGENTS
        const toolName = trimmed.slice(sep + 1).trim()
        if (toolName) killCapability(agentType, toolName)
      }
    }
  } catch {
  }
}

export function reseedCapabilityKillsFromEnv(): void {
  seedFromEnv()
}

seedFromEnv()

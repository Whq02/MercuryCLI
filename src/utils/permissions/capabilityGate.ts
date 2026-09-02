/* ============================================================================
   capabilityGate — per-agent capability kill-switch (bypass-immune deny).
   ----------------------------------------------------------------------------
   A runtime store of "killed" capabilities keyed by agent type. The operator
   can switch a tool OFF for one agent type (or all agents) at runtime.

   ENFORCEMENT POINTS (load-bearing first):
     1. services/tools/toolExecution.ts checkPermissionsAndCallTool — the
        UNIVERSAL execution gate, reached even under headless / sovereign
        / --dangerously-skip-permissions / flow. THIS is what makes the kill
        bypass-immune.
     2. utils/permissions/permissions.ts hasPermissionsToUseToolInner — an early,
        clean permission-path deny for interactive modes (not load-bearing; #1 is
        the guarantee).
     3. entrypoints/mcp.ts (`mercury mcp serve`) — this path calls tool.call()
        directly (not via #1), so it carries its own kill guard + filters killed
        tools out of ListTools.
   checkRuleBasedPermissions does NOT duplicate the kill (it would be redundant
   with #1/#2); earlier docs claimed it did — that was inaccurate.

   PER-AGENT SCOPING: callers pass the PER-CALL agent type (toolUseContext.agentType
   for a Task/AgentTool subagent; undefined for the main thread → falls back to
   getMainThreadAgentType()), so `agent:Tool` kills scope to the actual (sub)agent.
   The '*' (all-agents) and bare-tool kills never depend on the agent key and are
   always reliable.

   DENY-ONLY by construction: this store can only refuse a tool that a kill
   switched off. It never auto-allows anything. An empty store ⇒ no opinion ⇒
   the normal permission ladder decides.

   Keying:
     - agentType '*'  → applies to ALL agent types.
     - toolName  '*'  → kills ALL tools for that agent type.
   The current agent type is read from getMainThreadAgentType() (undefined for
   the default main thread → treated as the literal key '' so a kill on '' or
   '*' still fires).

   MCP SERVER-SCOPED KILL (additive deny, never loosens): MCP tools carry a
   fully-qualified name `mcp__<server>__<tool>`. Killing the bare server name
   (`MERCURY_KILL=github`) OR `mcp__github` kills EVERY tool from that server,
   so an operator does not have to enumerate each tool. This is matched in
   ADDITION to the exact name — it can only ever add a denial, never remove one.

   FAIL-CLOSED ON ERROR: isCapabilityKilled is on the universal deny path. Its
   only external dependency (getMainThreadAgentType) is wrapped so a throw there
   degrades to the all-agents check rather than blowing up the permission ladder.
   A throw is NOT silently treated as "allowed" — wildcard/all-agents kills still
   fire even if the per-agent key can't be resolved.

   Side-effect-free on import beyond reading MERCURY_KILL (see seedFromEnv).
   ============================================================================ */

import { getMainThreadAgentType } from '../../bootstrap/state.js'
import type { Tool } from '../../Tool.js'
import { deriveCategory, deriveRisk, type CapabilityCategory } from '../capability/manifest.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// Wildcard sentinels.
export const ALL_AGENTS = '*'
const ALL_TOOLS = '*'

// MCP fully-qualified tool name shape: mcp__<server>__<tool>.
const MCP_PREFIX = 'mcp__'

/**
 * The MCP server name a tool belongs to, or undefined for a non-MCP tool.
 * `mcp__github__create_issue` → `github`. Server-scoped kills key off this so an
 * operator can switch off a whole server with one entry.
 */
function mcpServerOfTool(toolName: string): string | undefined {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) {
    return undefined
  }
  const rest = toolName.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  const server = sep === -1 ? rest : rest.slice(0, sep)
  return server || undefined
}

// agentType → set of killed tool names ('*' = every tool for that agent).
// Map/Set keep this dependency-light and side-effect-free.
const killStore: Map<string, Set<string>> = new Map()

/**
 * Normalize an agent-type key. undefined (the default main thread, no --agent)
 * collapses to the empty string so a kill registered against '' matches the
 * default agent. '*' is preserved as the all-agents wildcard.
 */
function normalizeAgentType(agentType: string | undefined): string {
  return agentType ?? ''
}

/**
 * Kill a capability (tool) for an agent type.
 * @param agentType agent type, or '*' for all agents (undefined → default agent '').
 * @param toolName  tool name, or '*' to kill every tool for that agent.
 */
export function killCapability(
  agentType: string | undefined,
  toolName: string,
): void {
  const tool = typeof toolName === 'string' ? toolName.trim() : ''
  if (!tool) return // never store an empty kill (would be a no-op anyway)
  const key = normalizeAgentType(agentType)
  let set = killStore.get(key)
  if (!set) {
    set = new Set<string>()
    killStore.set(key, set)
  }
  set.add(tool)
}

/**
 * Restore (un-kill) a capability for an agent type. Restoring a tool that was
 * never killed is a no-op. Restoring '*' clears the all-tools kill for that
 * agent but leaves any per-tool kills intact.
 */
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

/**
 * Resolve the current agent type without ever throwing. getMainThreadAgentType
 * is a plain getter today, but this gate is on the universal deny path: if it
 * ever throws we degrade to the all-agents check (undefined → '') rather than
 * letting the exception escape the permission ladder. Wildcard/all-agents kills
 * therefore still fire even when the per-agent key is unresolvable.
 */
function currentAgentTypeSafe(): string | undefined {
  try {
    return getMainThreadAgentType()
  } catch {
    return undefined
  }
}

/**
 * Is `toolName` currently killed for `agentType`?
 *
 * A tool is killed when, for either the specific agent key OR the all-agents
 * '*' key, the kill set contains the all-tools '*' wildcard, the EXACT tool
 * name, or — for an MCP tool `mcp__<server>__<tool>` — the server-scoped key
 * (`<server>` or `mcp__<server>`). Defaults agentType to the current
 * main-thread agent type. Empty store ⇒ false (no opinion). Never throws.
 */
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
  // MCP server-scoped kill: a kill on the bare server name (or its mcp__ form)
  // takes down every tool from that server. Additive — only ever adds a denial.
  const server = mcpServerOfTool(toolName)
  if (server && (set.has(server) || set.has(MCP_PREFIX + server))) return true
  // Mis-cased entry (FC-005): for a NON-mcp tool a kill entry differing only
  // by case must still fire — `MERCURY_KILL=bash` is a kill switch, and a
  // kill switch that kills nothing silently is the worse failure. MCP tools
  // keep exact + server matching (a lowercase entry there is a server name;
  // the unambiguous server spelling is mcp__<server>).
  if (!toolName.startsWith(MCP_PREFIX)) {
    const folded = toolName.toLowerCase()
    for (const entry of set) {
      if (!entry.startsWith(MCP_PREFIX) && entry.toLowerCase() === folded) return true
    }
  }
  return false
}

export type CapabilityKillReason = { kind: 'capability-gate'; killPattern: string }

// The render descriptor a killed tool carries on its (non-model-visible)
// toolUseResult so the transcript can draw the `× <tool> <target> └ blocked · …`
// row without the kill taxonomy ever entering the model-visible tool_result.
export type HermesKillInfo = {
  kind: string
  killPattern?: string
  tool: string
  target?: string
}

// Why a tool is killed: returns the gate kind + the MERCURY_KILL pattern that
// matched, reconstructed in the env grammar (agentType:toolName, '*' wildcards),
// so the UI can show the rule without sniffing prose. null when not killed.
// Never throws (mirrors isCapabilityKilled's safety).
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
      // Mirror setKillsTool's mis-case arm so the reported pattern names the
      // entry the operator actually wrote.
      const folded = toolName.toLowerCase()
      matchedTool = [...set].find(e => !e.startsWith(MCP_PREFIX) && e.toLowerCase() === folded)
    }
    if (matchedTool) {
      return { kind: 'capability-gate', killPattern: `${agentTok}:${matchedTool}` }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// PER-AGENT DEFAULT CAPABILITY POSTURE (MERCURY_AGENT_CAP) — a stamp-gated
// category/risk policy layer ON TOP of the explicit kill store.
//
// The kill store is deny-ONLY but also enumerate-only: locking a worker agent
// type down to read-class tools means hand-listing every dangerous tool. This
// adds a DEFAULT posture per agent type, classified via the manifest's own
// deriveRisk/deriveCategory (single source of truth):
//   MERCURY_AGENT_CAP=worker:max-risk=low
//   MERCURY_AGENT_CAP=worker:deny-cat=exec,net;reviewer:max-risk=medium
// '*' applies to all agents. ';' separates agent directives, ',' separates cats.
//
// INVARIANTS (so this stays safe on the universal deny path):
//   - Evaluated AFTER the explicit-kill check and only ever ADDS a denial — it
//     never returns "allowed", so the deny-only contract is preserved.
//   - Only active when MERCURY_AGENT_CAP is set ⇒ unset/empty is
//     byte-identical.
//   - Parse fails CLOSED for real (FC-145): an unreadable directive clamps its
//     agent to max-risk=low and a SET-but-unintelligible value clamps ALL
//     agents — a garbled cap narrows, never evaporates — with the unread parts
//     recorded (getAgentCapParseRejects) for the reporting surfaces. Distinct
//     from the RUNTIME leg: any classifier throw still degrades to NO added
//     denial (never over-deny on error, never break the permission ladder).
// ---------------------------------------------------------------------------
type AgentCapRule = { maxRisk?: 'low' | 'medium' | 'high'; denyCat?: Set<CapabilityCategory> }
const AGENT_CAP_RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }
const VALID_CATS: ReadonlySet<string> = new Set(['read', 'edit', 'exec', 'net', 'coord', 'mcp', 'other'])

/** Parse MERCURY_AGENT_CAP into per-agent rules, recording what could not be
 *  read. FAILS CLOSED for real (FC-145 — the invariant above always claimed
 *  it; an empty map denies NOTHING, which is the OPEN state): an unreadable
 *  directive clamps its named agent to max-risk=low (the posture's narrowest
 *  lever — a garbled security cap must not evaporate), a clamped agent can
 *  never be re-widened by a later clean directive, and a SET value that
 *  expresses nothing clamps ALL agents. Ordinary spelling drifts are
 *  forgiven first: stray surrounding quotes are stripped, and a comma where
 *  the semicolon belongs (`worker:max-risk=low,reviewer:max-risk=medium`)
 *  re-enters the directive queue. Clean values parse byte-identically to the
 *  old grammar (incl. last-wins duplicates). Never throws. */
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
      // No agent:directive shape at all — nothing to clamp by name; the
      // expresses-nothing arm below catches an all-junk value.
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
      // Forgive the sibling separator: tokens after a comma that look like
      // directives re-enter the queue; the rest are rejects.
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
  // A SET posture that expressed nothing must not evaporate: clamp everyone.
  if (out.size === 0 && rejects.length > 0) out.set(ALL_AGENTS, { maxRisk: 'low' })
  return { policy: out, rejects }
}

/** Parse MERCURY_AGENT_CAP into per-agent rules (fails closed; see above). */
function parseAgentCapPolicy(): Map<string, AgentCapRule> {
  return parseAgentCapPolicyWithRejects().policy
}

/**
 * The parts of the current MERCURY_AGENT_CAP value the parser could not read.
 * Empty for unset/clean values. Each reject clamped something to max-risk=low
 * (fail closed); surfaces use this to say so instead of echoing the raw value
 * as cleanly armed (FC-145). Never throws.
 */
export function getAgentCapParseRejects(): string[] {
  try {
    return parseAgentCapPolicyWithRejects().rejects
  } catch {
    return []
  }
}

/** Does the per-agent DEFAULT posture deny this tool? Additive (only ever true to
 *  deny). Flag-gated, only when MERCURY_AGENT_CAP is set; fails to no-denial. */
function agentPolicyDenies(
  tool: { name: string; aliases?: string[] },
  agentType: string | undefined,
): boolean {
  try {
    if (!flagEnv('MERCURY_AGENT_CAP')) return false // common case: no policy
    
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

/** The reason a per-agent posture denied a tool (for the render descriptor), or
 *  null. Mirrors agentPolicyDenies; numeric/enum-only pattern, never throws. */
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

/**
 * Alias-aware kill check for a RESOLVED tool. A tool can be invoked by an alias
 * (toolMatchesName checks name OR aliases), so a kill on EITHER the canonical
 * name or any alias must fire. Prefer this over isCapabilityKilled at call sites
 * that hold the resolved Tool. Structural param keeps this module dependency-light.
 */
export function isToolKilled(
  tool: { name: string; aliases?: string[] },
  agentType?: string,
): boolean {
  if (isCapabilityKilled(tool.name, agentType)) return true
  for (const alias of tool.aliases ?? []) {
    if (isCapabilityKilled(alias, agentType)) return true
  }
  // Per-agent DEFAULT posture (additive deny; explicit kills above always win).
  if (agentPolicyDenies(tool, agentType)) return true
  return false
}

/** Alias-aware kill reason — checks the primary name then each alias, so the
 *  reported pattern reflects whichever name the operator actually killed. */
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
  // Fall back to the per-agent DEFAULT posture (matches isToolKilled's order).
  return agentPolicyReason(tool, agentType)
}

/**
 * Snapshot of all current kills, as a plain object { agentType: toolName[] }.
 * For diagnostics / a future operator panel. Returns a fresh copy each call.
 */
export function listCapabilityKills(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [agentType, tools] of killStore) {
    out[agentType] = [...tools]
  }
  return out
}

/** Clear every kill. Test/operator helper. */
export function clearAllCapabilityKills(): void {
  killStore.clear()
}

/**
 * Seed kills from the MERCURY_KILL env var. Format is a comma-separated list of
 * tool names killed for ALL agents, e.g.
 *   MERCURY_KILL=Bash,WebFetch
 * Each entry may optionally scope to an agent type with `agentType:toolName`,
 * e.g. MERCURY_KILL=explorer:Bash,*:WebFetch . A bare entry (no colon) is an
 * all-agents kill. An MCP server name (bare or `mcp__server`) kills every tool
 * from that server (see mcpServerOfTool). Whitespace is trimmed; empty entries
 * are skipped.
 *
 * ADDITIVE: seeding only ADDS kills (it never clears existing ones), so calling
 * it again after the operator updates MERCURY_KILL can only tighten, never
 * loosen — safe to expose as reseedCapabilityKillsFromEnv().
 *
 * Never throws (a junk env value just yields no kills). This is the only
 * import-time side effect, and it only READS env.
 */
function seedFromEnv(): void {
  try {
    const raw = flagEnv('MERCURY_KILL')
    if (!raw || typeof raw !== 'string') return
    // Forgiving list grammar (FC-005): `;` separates like `,` (the wrongly
    // separated list killed nothing), and stray surrounding quotes — the
    // Windows `set VAR="Bash"` form keeps them in the value — are stripped
    // per entry.
    for (const entry of raw.split(/[,;]/)) {
      const trimmed = entry.trim().replace(/^["']+|["']+$/g, '').trim()
      if (!trimmed) continue
      const sep = trimmed.indexOf(':')
      if (sep === -1) {
        // Bare tool / server name → kill for all agents.
        killCapability(ALL_AGENTS, trimmed)
      } else {
        const agentType = trimmed.slice(0, sep).trim() || ALL_AGENTS
        const toolName = trimmed.slice(sep + 1).trim()
        if (toolName) killCapability(agentType, toolName)
      }
    }
  } catch {
    // Defensive: a malformed env must never break import. No kills is the
    // honest default (the empty store has no opinion).
  }
}

/**
 * Re-read MERCURY_KILL and ADD any new kills (operator action after launch).
 * Additive-only by construction — see seedFromEnv. Returns nothing; inspect via
 * listCapabilityKills(). Safe to call repeatedly.
 */
export function reseedCapabilityKillsFromEnv(): void {
  seedFromEnv()
}

seedFromEnv()

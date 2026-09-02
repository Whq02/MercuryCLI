


import { isTrustedMcpServer } from './toolCard.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type McpRisk = 'low' | 'medium' | 'high'

const RISK_RANK: Record<McpRisk, number> = { low: 0, medium: 1, high: 2 }

function clampRisk(risk: McpRisk, ceiling: McpRisk): McpRisk {
  return RISK_RANK[risk] <= RISK_RANK[ceiling] ? risk : ceiling
}

function floorRisk(risk: McpRisk, floor: McpRisk): McpRisk {
  return RISK_RANK[risk] >= RISK_RANK[floor] ? risk : floor
}

const UNTRUSTED_HARDENING_ENV = 'MERCURY_MCP_UNTRUSTED_HARDENING'

export function isUntrustedMcpHardeningOn(): boolean {
  
  return flagEnv(UNTRUSTED_HARDENING_ENV) === '1'
}

export type McpToolAnnotations =
  | {
      readOnlyHint?: boolean
      destructiveHint?: boolean
      openWorldHint?: boolean
      [key: string]: unknown
    }
  | undefined

export function classifyMcpToolRisk(annotations: McpToolAnnotations): McpRisk {
  if (!annotations || typeof annotations !== 'object') return 'medium'
  if (
    annotations.readOnlyHint === true &&
    annotations.destructiveHint !== true &&
    annotations.openWorldHint !== true
  ) {
    return 'low'
  }
  if (annotations.destructiveHint === true || annotations.openWorldHint === true) {
    return 'high'
  }
  return 'medium'
}

function normalizeRisk(s: string): McpRisk | null {
  const r = s.trim().toLowerCase()
  return r === 'low' || r === 'medium' || r === 'high' ? r : null
}

function stripStrayQuotes(s: string): string {
  return s.trim().replace(/^["']+|["']+$/g, '').trim()
}

function parseRiskPolicy(): { fallback: McpRisk; perServer: Map<string, McpRisk>; rejects: string[] } {
  const v = flagEnv('MERCURY_MCP_MAX_RISK')
  const raw = stripStrayQuotes(typeof v === 'string' ? v : '')
  let fallback: McpRisk = 'high'
  const perServer = new Map<string, McpRisk>()
  const rejects: string[] = []
  if (!raw) return { fallback, perServer, rejects }
  for (const seg of raw.split(/[,;]/)) {
    const part = stripStrayQuotes(seg)
    if (!part) continue
    const colon = part.indexOf(':')
    if (colon === -1) {
      const r = normalizeRisk(part)
      if (r) fallback = r
      else rejects.push(part)
    } else {
      const server = part.slice(0, colon).trim().toLowerCase()
      const r = normalizeRisk(part.slice(colon + 1))
      if (server && r) perServer.set(server, r)
      else rejects.push(part)
    }
  }
  return { fallback, perServer, rejects }
}

export function getMcpPolicyRejects(): string[] {
  return parseRiskPolicy().rejects
}

export function getMaxExposedRisk(): McpRisk {
  return parseRiskPolicy().fallback
}

export function getMaxExposedRiskForServer(serverName: string): McpRisk {
  const { fallback, perServer } = parseRiskPolicy()
  const override = perServer.get((typeof serverName === 'string' ? serverName : '').trim().toLowerCase())
  return override ?? fallback
}

export function isMcpPolicyActive(): boolean {
  const { fallback, perServer } = parseRiskPolicy()
  return fallback !== 'high' || perServer.size > 0
}

export function describeMcpPolicy(): string {
  const { fallback, perServer, rejects } = parseRiskPolicy()
  const rejected = rejects.length
    ? ` · REJECTED: ${rejects.map(t => JSON.stringify(t)).join(', ')}`
    : ''
  if (fallback === 'high' && perServer.size === 0) return `high · permissive${rejected}`
  const overrides = Array.from(perServer.entries())
    .map(([srv, r]) => `${srv}:${r}`)
    .sort()
  const head = `default ${fallback}`
  return (overrides.length ? `${head} · ${overrides.join(' · ')}` : head) + rejected
}

function effectiveToolRisk(
  serverName: string,
  annotations: McpToolAnnotations,
): McpRisk {
  const risk = classifyMcpToolRisk(annotations)
  if (!isUntrustedMcpHardeningOn() || isTrustedMcpServer(serverName))
    return risk
  return floorRisk(risk, 'medium')
}

function effectiveExposureCeiling(serverName: string): McpRisk {
  const configured = getMaxExposedRiskForServer(serverName)
  if (!isUntrustedMcpHardeningOn() || isTrustedMcpServer(serverName))
    return configured
  const { perServer } = parseRiskPolicy()
  const hasOverride = perServer.has(
    (typeof serverName === 'string' ? serverName : '').trim().toLowerCase(),
  )
  if (hasOverride) return configured
  return clampRisk(configured, 'medium')
}

export function describeUntrustedMcpHardening(): string {
  return isUntrustedMcpHardeningOn()
    ? 'untrusted servers clamped to medium (third-party gate)'
    : 'untrusted-hardening off'
}

export function mcpToolAllowed(
  serverName: string,
  _toolName: string,
  annotations: McpToolAnnotations,
): boolean {
  const risk = effectiveToolRisk(serverName, annotations)
  const max = effectiveExposureCeiling(serverName)
  return RISK_RANK[risk] <= RISK_RANK[max]
}

export type UrlElicitationVerdict = {
  refuse: boolean
  posture: string
}

export function urlElicitationVerdict(serverName: string): UrlElicitationVerdict {
  const ceiling = effectiveExposureCeiling(serverName)
  if (ceiling === 'low') {
    return {
      refuse: true,
      posture: `risk ceiling low (MERCURY_MCP_MAX_RISK) — URL-open requests from "${serverName}" are refused by policy`,
    }
  }
  const hardened =
    isUntrustedMcpHardeningOn() && !isTrustedMcpServer(serverName)
  const clamp = isMcpPolicyActive() ? `risk ceiling ${ceiling}` : 'risk ceiling high (no MERCURY_MCP_MAX_RISK clamp)'
  return {
    refuse: false,
    posture: hardened ? `${clamp} · untrusted server (third-party gate)` : clamp,
  }
}

export function mcpPolicyDenyReason(
  serverName: string,
  toolName: string,
  annotations: McpToolAnnotations,
): string {
  const risk = effectiveToolRisk(serverName, annotations)
  const max = effectiveExposureCeiling(serverName)
  const hardened =
    isUntrustedMcpHardeningOn() &&
    !isTrustedMcpServer(serverName) &&
    (max !== getMaxExposedRiskForServer(serverName) ||
      risk !== classifyMcpToolRisk(annotations))
  const knob = hardened
    ? `untrusted-server hardening — add "${serverName}" to MERCURY_MCP_TRUSTED_SERVERS, ` +
      `or set MERCURY_MCP_UNTRUSTED_HARDENING=0`
    : 'MERCURY_MCP_MAX_RISK'
  return (
    `MCP tool ${serverName}/${toolName} is ${risk}-risk, which exceeds the ` +
    `policy maximum of ${max} for this server (${knob}).`
  )
}

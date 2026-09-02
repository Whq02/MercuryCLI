/* ============================================================================
   toolPolicy — MCP discovery + invocation policy gate.
   ----------------------------------------------------------------------------
   Classify an MCP tool's risk from its annotations and decide, against an
   operator-configurable max-exposed-risk threshold, whether the tool may be
   exposed to the model and invoked.

   The boundary is OUTSIDE the model loop: a tool that exceeds the policy is
   never built into the exposed tool set (discovery filter), and the same
   predicate is re-checked at invocation time so a tool that slipped through
   discovery (e.g. a list_changed race) is still denied before it runs.

   DEFAULT IS PERMISSIVE: with no MERCURY_MCP_MAX_RISK set, the threshold is
   'high' → every tool is exposed and allowed, so nothing changes unless the
   operator tightens it. Pure + fail-open-to-permissive only on its OWN parse
   (a junk env value falls back to the permissive default) — but NEVER
   silently: unreadable tokens are recorded (getMcpPolicyRejects) and every
   policy description names them, so a mistyped tightening cannot pass for a
   deliberate default (FC-141). The allow/deny predicate itself never throws.

   FORK UNTRUSTED HARDENING (MERCURY_MCP_UNTRUSTED_HARDENING=1, DEFAULT-OFF opt-in):
   on top of the explicit MERCURY_MCP_MAX_RISK knob above, a Mercury build can link
   the trust allowlist (MERCURY_MCP_TRUSTED_SERVERS) to the gate so a third-party
   server is protected without per-tool tuning. For a server NOT on the allowlist
   we (a) CLAMP its effective max-exposed-risk ceiling to 'medium' — unless the
   operator set an EXPLICIT `srv:risk` override, which is honored as a deliberate
   opt-in — so an open-world/destructive tool is denied, and (b) FLOOR its
   classified risk at 'medium' so an unverified `readOnlyHint:true` can never buy
   'low'. This CHANGES which MCP tools the model can call, so it is OFF by default:
   the env unset and `MERCURY_MCP_UNTRUSTED_HARDENING != '1'` are
   ALL byte-identical to the bare gate above. Only the exact value '1' opts in.
   ============================================================================ */

import { isTrustedMcpServer } from './toolCard.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Risk ordering, low < medium < high. */
export type McpRisk = 'low' | 'medium' | 'high'

const RISK_RANK: Record<McpRisk, number> = { low: 0, medium: 1, high: 2 }

/** Lower-ranked of two risks (apply a CEILING — never raise above it). */
function clampRisk(risk: McpRisk, ceiling: McpRisk): McpRisk {
  return RISK_RANK[risk] <= RISK_RANK[ceiling] ? risk : ceiling
}

/** Higher-ranked of two risks (apply a FLOOR — never drop below it). */
function floorRisk(risk: McpRisk, floor: McpRisk): McpRisk {
  return RISK_RANK[risk] >= RISK_RANK[floor] ? risk : floor
}

/** Env switch for Mercury's untrusted-server risk hardening. */
const UNTRUSTED_HARDENING_ENV = 'MERCURY_MCP_UNTRUSTED_HARDENING'

/**
 * Is Mercury's untrusted-server risk hardening active? DEFAULT-OFF: it changes
 * which MCP tools the model can call (could silently break a user's MCP tools),
 * so it ships off and is opted into with `MERCURY_MCP_UNTRUSTED_HARDENING=1`
 * (the exact value '1' — anything else, including unset, is OFF).
 * Read fresh each call so the
 * switch takes effect mid-session.
 */
export function isUntrustedMcpHardeningOn(): boolean {
  
  return flagEnv(UNTRUSTED_HARDENING_ENV) === '1'
}

/**
 * The annotation shape we read off an MCP tool. Matches the optional hints the
 * MCP spec defines (and that client.ts already reads): readOnlyHint,
 * destructiveHint, openWorldHint. All optional / possibly undefined.
 */
export type McpToolAnnotations =
  | {
      readOnlyHint?: boolean
      destructiveHint?: boolean
      openWorldHint?: boolean
      [key: string]: unknown
    }
  | undefined

/**
 * Classify an MCP tool's risk from its annotations.
 *   - readOnlyHint            → 'low'
 *   - destructiveHint OR openWorldHint → 'high'
 *   - otherwise               → 'medium'
 *
 * readOnlyHint grants 'low' ONLY when the tool is neither destructive nor
 * open-world: a read-only tool that can still reach the open internet
 * (openWorldHint) is an exfiltration vector (it can READ local state AND send it
 * out), so it must NOT slip the gate as 'low' — it falls through to 'high'.
 * A tool with no annotations is 'medium' (unknown ⇒ not low).
 *
 * Robust to hostile annotation shapes: the hints are attacker-controllable
 * (a server can send any JSON), so we compare with `=== true` only — a truthy
 * non-boolean (e.g. `readOnlyHint: "yes"`, `1`, `{}`) is NOT treated as
 * read-only. This means a server can never DOWNGRADE its risk with a non-bool
 * truthy value; it can only ever be classified at-or-above its honest risk.
 * Never throws.
 */
export function classifyMcpToolRisk(annotations: McpToolAnnotations): McpRisk {
  if (!annotations || typeof annotations !== 'object') return 'medium'
  // Strict boolean reads: a non-boolean readOnlyHint does NOT grant 'low'.
  // Honor read-only as 'low' ONLY when the server hasn't ALSO flagged the tool
  // destructive OR open-world — either of those (incl. a contradictory
  // read-only+destructive annotation) refuses the low downgrade and falls
  // through to the high check below.
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

/** Normalize one risk token; null if it isn't a recognized level. */
function normalizeRisk(s: string): McpRisk | null {
  const r = s.trim().toLowerCase()
  return r === 'low' || r === 'medium' || r === 'high' ? r : null
}

/** Strip one layer of stray surrounding quotes (the Windows `set VAR="X"`
 *  form keeps them in the value), then trim. */
function stripStrayQuotes(s: string): string {
  return s.trim().replace(/^["']+|["']+$/g, '').trim()
}

/**
 * Parse MERCURY_MCP_MAX_RISK into a default threshold + optional per-server
 * overrides. The grammar is the original bare value PLUS optional `server:risk`
 * segments, comma-separated (`;` separates like `,` — the sibling posture
 * flag's separator, forgiven here so a habit carried across kills nothing;
 * stray surrounding quotes are stripped per segment):
 *   MERCURY_MCP_MAX_RISK=high                          (bare — global default)
 *   MERCURY_MCP_MAX_RISK=high,untrusted-srv:low        (trust your own, clamp theirs)
 *   MERCURY_MCP_MAX_RISK=low,scratch:medium,ci:high    (default low, two overrides)
 * A bare segment sets the default; a `server:risk` segment overrides one server
 * (case-insensitive server match). A token that still fails to parse keeps the
 * documented permissive fallback for its slot BUT is RECORDED in `rejects` —
 * the silent-widening ban (FC-141): a tightened-but-mistyped ceiling must
 * never look like a clean permissive one, so every reporting surface names
 * the rejected tokens. Never throws.
 */
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
      if (r) fallback = r // bare value → the global default
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

/**
 * The tokens the current MERCURY_MCP_MAX_RISK value carries that the parser
 * could not read. Empty for unset/clean values. Surfaces (doctor's MCP policy
 * row first) use this to WARN instead of certifying a mistyped tightening as
 * a deliberate permissive default. Never throws.
 */
export function getMcpPolicyRejects(): string[] {
  return parseRiskPolicy().rejects
}

/**
 * Resolve the operator's GLOBAL max-exposed-risk threshold from
 * MERCURY_MCP_MAX_RISK (the bare value). Anything else — unset, empty, junk —
 * falls back to the permissive default 'high' so default behavior exposes
 * everything. Per-server overrides are resolved by getMaxExposedRiskForServer.
 */
export function getMaxExposedRisk(): McpRisk {
  return parseRiskPolicy().fallback
}

/**
 * Resolve the max-exposed-risk threshold for a SPECIFIC server: its per-server
 * override if one is set, else the global default. Lets an operator trust their
 * own internal server while clamping an untrusted third-party one to read-only,
 * instead of one threshold stripping tools from both. Default (bare value only)
 * is byte-identical to getMaxExposedRisk for every server.
 */
export function getMaxExposedRiskForServer(serverName: string): McpRisk {
  const { fallback, perServer } = parseRiskPolicy()
  const override = perServer.get((typeof serverName === 'string' ? serverName : '').trim().toLowerCase())
  return override ?? fallback
}

/**
 * Is the MCP risk-policy gate ACTUALLY enforcing anything? True when the global
 * default is tighter than the permissive 'high' OR when ANY per-server override
 * is set. A per-server clamp with no bare default (e.g.
 * MERCURY_MCP_MAX_RISK=untrusted-srv:low) leaves the global fallback at 'high' yet
 * actively DENIES that server's tools at discovery + invocation
 * (getMaxExposedRiskForServer honors it) — so deriving "gate on" from
 * `getMaxExposedRisk() !== 'high'` alone is WRONG: it ignores per-server
 * overrides and reports a live gate as OFF/permissive across every STATUS
 * surface. This is the single source of truth for every surface's on/off.
 *
 * Default (no env, fallback 'high', empty perServer) => false — byte-identical
 * to the old `maxRisk !== 'high'` check. Never throws.
 */
export function isMcpPolicyActive(): boolean {
  const { fallback, perServer } = parseRiskPolicy()
  return fallback !== 'high' || perServer.size > 0
}

/**
 * A short human description of the EFFECTIVE policy, including per-server
 * overrides, for status hints. Examples:
 *   no env                                  -> 'high · permissive'
 *   MERCURY_MCP_MAX_RISK=low                  -> 'default low'
 *   MERCURY_MCP_MAX_RISK=untrusted-srv:low    -> 'default high · untrusted-srv:low'
 *   MERCURY_MCP_MAX_RISK=low,scratch:medium   -> 'default low · scratch:medium'
 * The bare 'high · permissive' is emitted ONLY when truly wide open (default
 * high AND no overrides). Overrides are sorted for a stable render. Never throws.
 */
export function describeMcpPolicy(): string {
  const { fallback, perServer, rejects } = parseRiskPolicy()
  // Rejected tokens ride EVERY description of the policy (FC-141): the one
  // thing a mistyped tightening must never produce is a clean-looking line.
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

/**
 * The risk a tool is gated at, AFTER the untrusted-server floor. For a
 * NON-trusted server (not on MERCURY_MCP_TRUSTED_SERVERS) with hardening ON, the
 * classified risk is floored at 'medium' — a server's unverified
 * `readOnlyHint:true` can never grant 'low'. Trusted servers (and hardening
 * OFF — the default) get the raw classifyMcpToolRisk verbatim ⇒ byte-identical.
 */
function effectiveToolRisk(
  serverName: string,
  annotations: McpToolAnnotations,
): McpRisk {
  const risk = classifyMcpToolRisk(annotations)
  if (!isUntrustedMcpHardeningOn() || isTrustedMcpServer(serverName))
    return risk
  return floorRisk(risk, 'medium')
}

/**
 * The max-exposed-risk ceiling a server is gated against, AFTER the
 * untrusted-server clamp. For a NON-trusted server with hardening ON, the
 * configured ceiling is clamped to 'medium' so an open-world/destructive
 * third-party tool is denied — UNLESS the operator set an EXPLICIT `srv:risk`
 * override for that server, which is honored as a deliberate opt-in. Trusted
 * servers (and hardening OFF — the default) keep getMaxExposedRiskForServer ⇒
 * byte-identical.
 */
function effectiveExposureCeiling(serverName: string): McpRisk {
  const configured = getMaxExposedRiskForServer(serverName)
  if (!isUntrustedMcpHardeningOn() || isTrustedMcpServer(serverName))
    return configured
  // An explicit per-server override is the operator deliberately setting this
  // server's ceiling — honor it (could be wider OR narrower than the clamp).
  const { perServer } = parseRiskPolicy()
  const hasOverride = perServer.has(
    (typeof serverName === 'string' ? serverName : '').trim().toLowerCase(),
  )
  if (hasOverride) return configured
  return clampRisk(configured, 'medium')
}

/**
 * A short human description of the untrusted-server hardening for status
 * surfaces (/policy, /health). Describes BOTH states honestly — its first real
 * consumer is the /health MCP check, which composes it into an
 * evidence line; returning '' for OFF dangled a separator there. Stays about the
 * third-party gate only (getMaxExposedRisk / describeMcpPolicy own the
 * MERCURY_MCP_MAX_RISK knob). Never throws.
 */
export function describeUntrustedMcpHardening(): string {
  return isUntrustedMcpHardeningOn()
    ? 'untrusted servers clamped to medium (third-party gate)'
    : 'untrusted-hardening off'
}

/**
 * Is an MCP tool with these annotations allowed under the current policy?
 *
 * A tool is allowed when its EFFECTIVE risk (after the untrusted-server floor)
 * is at or below the EFFECTIVE max-exposed-risk ceiling FOR ITS SERVER (after
 * the untrusted-server clamp). With hardening OFF (the default) both reduce to
 * the bare classifyMcpToolRisk / getMaxExposedRiskForServer ⇒ byte-identical.
 * toolName is accepted for diagnostics.
 *
 * Default (threshold 'high', hardening off) → always true.
 */
export function mcpToolAllowed(
  serverName: string,
  _toolName: string,
  annotations: McpToolAnnotations,
): boolean {
  const risk = effectiveToolRisk(serverName, annotations)
  const max = effectiveExposureCeiling(serverName)
  // Both ranks come from the closed RISK_RANK table keyed by our own validated
  // enums, so this comparison cannot be NaN. The predicate is total and never
  // throws — discovery + invocation both depend on it being decisive.
  return RISK_RANK[risk] <= RISK_RANK[max]
}

/**
 * Human-readable reason a tool is being denied by the policy. Used in the
 * invocation-time deny message so the model/operator sees WHY. When the
 * untrusted-server hardening (not the bare MERCURY_MCP_MAX_RISK) moved the
 * verdict, name the actionable lift: trust the server or set the switch off.
 */
/**
 * URL-mode elicitation (SEP-1036, spec rev) is a first-class
 * phishing surface: a server asks the CLIENT to open a browser URL. Verdict:
 *
 *   - REFUSE (auto-decline before any dialog renders) when the server's
 *     EFFECTIVE risk ceiling is 'low' — the operator clamped it via
 *     MERCURY_MCP_MAX_RISK (per-server or global). A server not trusted with
 *     medium-risk tools is not trusted to pop browser-opens at the operator.
 *   - Otherwise the request reaches the explicit consent card, which shows the
 *     full URL + this posture line and NEVER auto-opens (accept is a keypress).
 *
 * Default (no policy env) ⇒ ceiling 'high' ⇒ card, byte-identical behavior.
 */
export type UrlElicitationVerdict = {
  refuse: boolean
  /** Short posture line for the consent card / decline log. */
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

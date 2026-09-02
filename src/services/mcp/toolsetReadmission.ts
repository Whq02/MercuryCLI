/* ============================================================================
   toolsetReadmission — MCP list_changed re-admission gate (ITEM 7).
   ----------------------------------------------------------------------------
   When an MCP server fires tools/list_changed and its advertised toolset
   changes, the NEW toolset must be re-admitted through the operator policy
   (mcpToolAllowed, the item-2 gate) rather than silently widening the exposed
   pool. This module is the pure substrate for that gate:

     - toolsetHash(tools): a stable, order-independent fingerprint of a toolset
       (name + risk-bearing annotations). A list_changed that doesn't actually
       change the admitted surface produces the SAME hash → no-op.

     - needsReadmission(admittedHash, liveHash): has the toolset changed since
       it was last admitted? Conservative on unknown (empty) hashes — an unknown
       hash on EITHER side forces re-admission.

     - readmitTools(serverName, tools): re-run the item-2 policy filter over a
       (re)fetched toolset, returning only the tools that still pass
       mcpToolAllowed. The SAME predicate the discovery filter and the
       invocation-time recheck use — one policy, three call sites.

   DEFAULT IS A NO-OP PASS: with the default MERCURY_MCP_MAX_RISK=high every tool
   is admitted, so readmitTools returns the toolset unchanged and the only
   observable effect of a hash change is a debug log. The gate only ever
   NARROWS (drops tools the operator policy forbids); it never adds or reorders.
   Pure + defensive: never throws on junk input.
   ============================================================================ */

import { createHash } from 'crypto'
import type { Tool } from '../../Tool.js'
import { mcpToolAllowed, type McpToolAnnotations } from './toolPolicy.js'

/**
 * The risk-bearing facets of a single tool that the policy gate reads. Two
 * toolsets with the same set of (name, readOnly, destructive, openWorld) tuples
 * admit identically, so they hash to the same value. Description/schema churn
 * that doesn't move a tool across the risk threshold is intentionally ignored —
 * re-admission is about the EXPOSED-RISK surface, not cosmetic drift.
 */
function toolFingerprint(tool: {
  name?: string
  annotations?: McpToolAnnotations
}): string {
  const a = tool.annotations
  const ro = a && typeof a === 'object' && a.readOnlyHint === true ? '1' : '0'
  const de =
    a && typeof a === 'object' && a.destructiveHint === true ? '1' : '0'
  const ow = a && typeof a === 'object' && a.openWorldHint === true ? '1' : '0'
  return `${tool.name ?? ''}\x00${ro}${de}${ow}`
}

/**
 * Stable, order-independent fingerprint of a toolset. Sorting the per-tool
 * fingerprints makes the hash insensitive to the order tools/list returns them
 * in (servers don't promise a stable order), so a pure reordering is NOT a
 * change. Empty toolset → '' (the unknown sentinel; needsReadmission treats it
 * conservatively). Never throws.
 */
export function toolsetHash(
  tools: ReadonlyArray<{ name?: string; annotations?: McpToolAnnotations }>,
): string {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  try {
    const parts = tools.map(toolFingerprint).sort()
    return createHash('sha256').update(parts.join('\x01')).digest('hex')
  } catch {
    // Defensive: a hash failure must not crash the list_changed handler. Return
    // the unknown sentinel so the caller re-admits conservatively.
    return ''
  }
}

/**
 * Has the toolset changed since it was last admitted (a list_changed event)?
 * When the live hash differs from the admitted hash the toolset must NOT be
 * auto-trusted → re-admission required.
 *
 * Conservative on unknown: an empty hash on EITHER side (never admitted, or an
 * empty/failed live fetch) returns true so the caller re-runs the policy
 * filter.
 */
export function needsReadmission(
  admittedHash: string | undefined,
  liveHash: string | undefined,
): boolean {
  const admitted = typeof admittedHash === 'string' ? admittedHash : ''
  const live = typeof liveHash === 'string' ? liveHash : ''
  if (!admitted || !live) return true
  return admitted !== live
}

/**
 * Re-admit a (re)fetched toolset through the item-2 policy: keep only the tools
 * that still pass mcpToolAllowed for `serverName`. The fully-qualified
 * `tool.name` carries the mcp__ prefix; the policy keys on the server name +
 * the bare tool name (from mcpInfo), so we read mcpInfo.toolName when present
 * and fall back to the tool's own name.
 *
 * Default policy (threshold 'high') admits everything → returns `tools`
 * unchanged. Never throws; on any per-tool error the tool is KEPT (fail-open to
 * the permissive default — the invocation-time recheck in client.ts is the
 * backstop that still denies it before it runs).
 */
export function readmitTools(serverName: string, tools: Tool[]): Tool[] {
  if (!Array.isArray(tools)) return []
  return tools.filter(tool => {
    try {
      const toolName = tool.mcpInfo?.toolName ?? tool.name ?? ''
      const annotations = readToolAnnotations(tool)
      return mcpToolAllowed(serverName, toolName, annotations)
    } catch {
      return true
    }
  })
}

/**
 * Reconstruct the policy-relevant annotation hints from a built Tool. The
 * discovery path stashes them on the tool's predicate methods (isReadOnly /
 * isDestructive / isOpenWorld), so we read those back rather than re-parsing the
 * raw MCP annotations (which aren't retained on the Tool object).
 */
function readToolAnnotations(tool: Tool): McpToolAnnotations {
  const read = (fn: unknown): boolean => {
    if (typeof fn !== 'function') return false
    try {
      return (fn as () => boolean)() === true
    } catch {
      return false
    }
  }
  return {
    readOnlyHint: read(tool.isReadOnly),
    destructiveHint: read(tool.isDestructive),
    openWorldHint: read((tool as { isOpenWorld?: () => boolean }).isOpenWorld),
  }
}

// ============================================================================
//  capability/census — the machine-generated tool-capability census
//
//
//  ONE derivation over the LIVE catalog (getAllBaseTools) answering, per
//  built-in production tool: what it is, what operations it exposes, its
//  observation/mutation class, its lifecycle integrations, and what proves
//  it. Consumed by scripts/builtin-tools/census-gen.ts (writes the committed
//  census doc), scripts/builtin-tools/prove-builtin-tools-census.ts (the drift gate),
//  and the doctor TOOL CAPABILITY section.
//
//  Honesty rules:
//    · every ENRICHMENT claim names a mechanical cross-check — a gate flag
//      must exist in flagRegistry, a proof path must exist on disk, an
//      execution kind must be classified in EXECUTION_DOMAIN_CENSUS, a
//      resource kind must be registered in the resource registry;
//    · live state (enabledNow, support) is INFORMATIONAL — the drift anchor
//      compares only environment-stable fields;
//    · a tool the derivation cannot classify reads 'unclassified', never a
//      guessed value. The gap ratchet (prove-builtin-tools-census) refuses NEW
//      unclassified tools while the committed gap list burns down.
// ============================================================================

import { getAllBaseTools } from '../../tools.js'
import { toolMatchesName, type Tool } from '../../Tool.js'
import {
  deriveCapabilityDescriptor,
  type CapabilityCategory,
  type CapabilityRisk,
} from './manifest.js'
import type { ToolCapability } from './contract.js'
import { declaredCapability } from './contract.js'

export const CENSUS_VERSION = 1

/** The capability-unit vocabulary (the score axis — NOT raw tool count). */
export const CAPABILITY_UNITS = [
  'source-reading',
  'text-mutation',
  'structural-mutation',
  'code-intelligence',
  'debugging',
  'process-execution',
  'persistent-evaluation',
  'service-management',
  'resource-inspection',
  'task-coordination',
  'git-inspection',
  'git-transactions',
  'application-verification',
  'capability-discovery',
  'web-access',
  'memory',
  'planning',
  'operator-io',
  'scheduling',
  'game-engine',
  // driving a real local browser (the Browser tool) — distinct
  // from 'web-access' (plain HTTP fetch, no page runtime).
  'browser-drive',
  // pixel-art authoring through the local Aseprite's batch CLI (the
  // Aseprite tool) — game-dev CONTENT, distinct from 'game-engine'
  // (driving an engine's editor).
  'pixel-art',
] as const
export type CapabilityUnit = (typeof CAPABILITY_UNITS)[number]

export type SupportState = 'available' | 'conditional' | 'degraded' | 'unavailable'

export interface ToolCensusRow {
  name: string
  /** In the assembled catalog RIGHT NOW (live informational — a gated-out
   *  production tool still gets a census row, support 'unavailable'). */
  inCatalogNow: boolean
  /** Existing manifest derivation (category × risk). */
  category: CapabilityCategory
  risk: CapabilityRisk
  /** isReadOnly({}) probe — null when the probe is unanswerable. */
  readOnlyProbe: boolean | null
  concurrencySafeProbe: boolean | null
  /** interruptBehavior() — the cancellation contract on operator steer. */
  cancellation: 'cancel' | 'block'
  deferred: boolean
  /** Op-dispatch vocabulary extracted from the zod schema (null = single-op). */
  operations: string[] | null
  /** The DECLARED capability contract — null until declared. */
  declared: ToolCapability | null
  /** Capability units — declared units win; otherwise 'unclassified'. */
  units: string[]
  /** Focused behavioural suite covering this tool (cross-checked on disk). */
  proof: string | null
  /** Live-at-generation informational state (NOT drift-anchored). */
  enabledNow: boolean
  support: SupportState
}

export interface ToolCensus {
  version: number
  rows: ToolCensusRow[]
  summary: {
    tools: number
    bySupport: Record<SupportState, number>
    byClass: { observation: number; mutation: number; execution: number; coordination: number; unclassified: number }
    declared: number
    operations: number
    unitsCovered: string[]
    unclassified: string[]
    withTransactionIntegration: number
    withExecutionIntegration: number
    withResourceOutputs: number
    withProof: number
  }
}

// ── focused-proof map (every path is existence-checked by the gate) ─────────
// Maintained: maps a tool to the focused suite that exercises its behaviour.
// A tool without a row reads proof:null — a NAMED gap, never a claim.
const PROOF_MAP: Record<string, string> = {
  Bash: 'scripts/tools/prove-stream-watchdog.ts',
  Read: 'scripts/project-services/prove-change-anchors.ts',
  Edit: 'scripts/project-services/prove-change-receipts.ts',
  Write: 'scripts/project-services/prove-change-receipts.ts',
  LSP: 'scripts/lsp/run-all.sh',
  Inspect: 'scripts/project-services/prove-resource-plane.ts',
  Workshop: 'scripts/project-services/prove-workshop.ts',
  Service: 'scripts/project-services/prove-services.ts',
  Debug: 'scripts/ide/prove-native-debug.ts',
  Test: 'scripts/ide/prove-python-tests.ts',
  Launch: 'scripts/ide/prove-launch-profiles.ts',
  Transaction: 'scripts/ide/prove-closed-loop.ts',
  Structure: 'scripts/builtin-tools/prove-structure-query.ts',
  Git: 'scripts/builtin-tools/prove-git-graph.ts',
  Journey: 'scripts/builtin-tools/prove-journeys.ts',
  ToolSearch: 'scripts/tools/prove-toolsearch-cooccur.ts',
  Workflow: 'scripts/workflows/run-all.sh',
  Agent: 'scripts/tools/prove-tool-contracts.ts',
  SendMessage: 'scripts/scribe/run-all.sh',
  Sleep: 'scripts/tools/prove-sleep-tool.ts',
  Godot: 'scripts/vulcan/run-all.sh',
  SetTier: 'scripts/autopilot/run-all.sh',
}

function extractOperations(tool: Tool): string[] | null {
  try {
    const schema = tool.inputSchema as unknown as {
      shape?: Record<string, unknown> | (() => Record<string, unknown>)
    }
    const shapeRaw = schema?.shape
    const shape = typeof shapeRaw === 'function' ? shapeRaw() : shapeRaw
    let node = shape?.op as
      | { options?: unknown; unwrap?: () => unknown; _def?: { innerType?: unknown } }
      | undefined
    for (let i = 0; i < 4 && node; i++) {
      if (Array.isArray(node.options)) {
        const ops = node.options.filter((o): o is string => typeof o === 'string')
        return ops.length > 0 ? ops : null
      }
      node = (node._def?.innerType ?? node.unwrap?.()) as typeof node
    }
    return null
  } catch {
    return null
  }
}

function probe(fn: ((input: Record<string, never>) => boolean) | undefined): boolean | null {
  if (typeof fn !== 'function') return null
  try {
    return fn({} as Record<string, never>) === true
  } catch {
    return null
  }
}

function liveSupport(declared: ToolCapability | null, enabledNow: boolean): SupportState {
  if (enabledNow) {
    // Declared conditions (a binary, a server, a project shape) mean the
    // tool can degrade at runtime even while catalog-enabled.
    return declared?.conditions?.length ? 'conditional' : 'available'
  }
  // In the catalog but currently answering isEnabled()=false: present,
  // runtime-gated (an LSP tool without a connected server, a room tool
  // without a room). Distinct from 'unavailable' (not in the catalog at
  // all — the caller never sees such a tool here).
  return 'conditional'
}

function unitsFor(declared: ToolCapability | null): string[] {
  if (declared?.units && declared.units.length > 0) return [...declared.units]
  return ['unclassified']
}

export function buildToolCensusRow(tool: Tool, inCatalogNow: boolean): ToolCensusRow {
  const descriptor = deriveCapabilityDescriptor(tool)
  const declared = declaredCapability(tool)
  let enabledNow = false
  try {
    enabledNow = inCatalogNow && tool.isEnabled()
  } catch {
    enabledNow = false
  }
  return {
    name: tool.name,
    inCatalogNow,
    category: descriptor.category,
    risk: descriptor.risk,
    readOnlyProbe: probe(tool.isReadOnly),
    concurrencySafeProbe: probe(tool.isConcurrencySafe),
    cancellation: tool.interruptBehavior?.() ?? 'block',
    deferred: tool.shouldDefer === true,
    operations: declared?.operations ? [...declared.operations] : extractOperations(tool),
    declared,
    units: unitsFor(declared),
    proof: declared?.proof ?? PROOF_MAP[tool.name] ?? null,
    enabledNow,
    support: inCatalogNow ? liveSupport(declared, enabledNow) : 'unavailable',
  }
}

/**
 * The conditional estate: production tools whose CATALOG presence is
 * environment/flag-dependent (search-binary availability, opt-in flags,
 * mode gates). The census must still ROW them — a gated-out tool reads
 * support 'unavailable', it never silently vanishes. Lazy requires keep
 * import cost off the hot path; a module that fails to load in this
 * environment is skipped (its absence is then genuinely environmental,
 * e.g. win32-only PowerShell on darwin).
 */
function supplementalTools(): Tool[] {
  const loaders: Array<() => Tool> = [
    /* eslint-disable @typescript-eslint/no-require-imports */
    () => require('../../tools/GlobTool/GlobTool.js').GlobTool,
    () => require('../../tools/GrepTool/GrepTool.js').GrepTool,
    () => require('../../tools/TaskCreateTool/TaskCreateTool.js').TaskCreateTool,
    () => require('../../tools/TaskGetTool/TaskGetTool.js').TaskGetTool,
    () => require('../../tools/TaskUpdateTool/TaskUpdateTool.js').TaskUpdateTool,
    () => require('../../tools/TaskListTool/TaskListTool.js').TaskListTool,
    () => require('../../tools/GodotTool/GodotTool.js').GodotTool,
    () => require('../../tools/AsepriteTool/AsepriteTool.js').AsepriteTool,
    () => require('../../tools/SetTierTool/SetTierTool.js').SetTierTool,
    () => require('../../tools/ToolSearchTool/ToolSearchTool.js').ToolSearchTool,
    () => require('../../tools/MemoryTools/MemoryTools.js').RetainTool,
    () => require('../../tools/MemoryTools/MemoryTools.js').RecallTool,
    () => require('../../tools/MemoryTools/MemoryTools.js').ReflectTool,
    () => require('../../tools/MemoryTools/MemoryTools.js').CorrectTool,
    /* eslint-enable @typescript-eslint/no-require-imports */
  ]
  const out: Tool[] = []
  for (const load of loaders) {
    try {
      const tool = load()
      if (tool && typeof tool.name === 'string') out.push(tool)
    } catch {
      /* environmentally unloadable — genuinely absent here */
    }
  }
  return out
}

export function buildToolCensus(): ToolCensus {
  const catalog = getAllBaseTools().filter(t => t.name !== 'TestingPermission')
  const rows = [
    ...catalog.map(t => buildToolCensusRow(t, true)),
    ...supplementalTools()
      .filter(s => !catalog.some(t => toolMatchesName(t, s.name)))
      .map(t => buildToolCensusRow(t, false)),
  ].sort((a, b) => a.name.localeCompare(b.name))

  const bySupport: Record<SupportState, number> = {
    available: 0,
    conditional: 0,
    degraded: 0,
    unavailable: 0,
  }
  const byClass = { observation: 0, mutation: 0, execution: 0, coordination: 0, unclassified: 0 }
  const unitsCovered = new Set<string>()
  const unclassified: string[] = []
  let declared = 0
  let operations = 0
  let withTransactionIntegration = 0
  let withExecutionIntegration = 0
  let withResourceOutputs = 0
  let withProof = 0

  for (const row of rows) {
    bySupport[row.support]++
    const cls = row.declared?.class ?? (row.readOnlyProbe === true ? 'observation' : null)
    if (cls && cls in byClass) byClass[cls as keyof typeof byClass]++
    else byClass.unclassified++
    for (const u of row.units) {
      if (u === 'unclassified') unclassified.push(row.name)
      else unitsCovered.add(u)
    }
    if (row.declared) declared++
    operations += row.operations?.length ?? 1
    if (row.declared?.transaction) withTransactionIntegration++
    if (row.declared?.execution) withExecutionIntegration++
    if (row.declared?.resources?.length) withResourceOutputs++
    if (row.proof) withProof++
  }

  return {
    version: CENSUS_VERSION,
    rows,
    summary: {
      tools: rows.length,
      bySupport,
      byClass,
      declared,
      operations,
      unitsCovered: [...unitsCovered].sort(),
      unclassified: [...new Set(unclassified)].sort(),
      withTransactionIntegration,
      withExecutionIntegration,
      withResourceOutputs,
      withProof,
    },
  }
}

/**
 * The DRIFT ANCHOR: environment-stable projection of the census. Live
 * fields (enabledNow, support) are dropped — a laptop without a Godot
 * project must produce the same anchor as CI.
 */
export interface StableCensusRow {
  name: string
  category: CapabilityCategory
  risk: CapabilityRisk
  cancellation: 'cancel' | 'block'
  deferred: boolean
  operations: string[] | null
  units: string[]
  proof: string | null
  declared: ToolCapability | null
}

export function stableCensus(census: ToolCensus): StableCensusRow[] {
  return census.rows.map(r => ({
    name: r.name,
    category: r.category,
    risk: r.risk,
    cancellation: r.cancellation,
    deferred: r.deferred,
    operations: r.operations,
    units: r.units,
    proof: r.proof,
    declared: r.declared,
  }))
}

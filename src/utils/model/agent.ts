/**
 * Subagent model resolution — every path funnels through ONE exported
 * chokepoint that applies the never-small-model floor to the fully-resolved
 * string.
 */
import { MODEL_ALIASES } from './aliases.js'
import { enforceSubagentModelFloor } from './modelFloor.js'
import { getCanonicalName, parseUserSpecifiedModel, getRuntimeMainLoopModel } from './model.js'

/** The inherit sentinel (contract data). */
const INHERIT = 'inherit'

export type AgentModelAlias = (typeof MODEL_ALIASES)[number] | typeof INHERIT

/** The FULL accepted agent-model values — the alias list plus inherit. This
 *  is the type source (agent definitions/frontmatter validate against it), so
 *  it still admits the small family, `best` and the plan alias. */
export const AGENT_MODEL_OPTIONS: readonly string[] = [...MODEL_ALIASES, INHERIT]

export function getDefaultSubagentModel(): string {
  return INHERIT
}

// ---------------------------------------------------------------------------
// Tier matching
// ---------------------------------------------------------------------------

/** The bare family aliases plus the frontier family that match a parent tier.
 *  Suffixed aliases, `best` and the plan alias never match. */
const TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'mythos'])

function familyToken(canonical: string): string | null {
  const match = canonical.match(/claude-(opus|sonnet|haiku|fable)/)
  return match ? match[1] : null
}

function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const lowered = alias.trim().toLowerCase()
  if (!TIER_ALIASES.has(lowered)) return false
  // The frontier mirror (mythos) folds to the fable canonical, so matching
  // the family token covers both.
  const parentFamily = familyToken(getCanonicalName(parentModel))
  const aliasFamily = familyToken(getCanonicalName(parseUserSpecifiedModel(lowered)))
  return parentFamily !== null && parentFamily === aliasFamily
}

// ---------------------------------------------------------------------------
// The raw resolver (module-private) + the floored chokepoints
// ---------------------------------------------------------------------------

function resolveAgentModelRaw(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): string {
  // 1. A tool-specified model: a bare family alias matching the parent tier
  //    inherits the parent's EXACT string; otherwise parse.
  if (toolSpecifiedModel !== undefined && toolSpecifiedModel !== '') {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) return parentModel
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  // 2. The agent's declared model, defaulting to inherit. "inherit" resolves
  //    through the runtime model resolver against the PARENT model, so
  //    plan-mode alias resolution applies while a subagent still tracks its
  //    parent.
  const declared = agentModel ?? INHERIT
  if (declared === INHERIT) {
    return getRuntimeMainLoopModel({
      mainLoopModel: parentModel,
      permissionMode,
    })
  }

  // 3. Otherwise the same alias-matches-parent-tier rule, then parse.
  if (aliasMatchesParentTier(declared, parentModel)) return parentModel
  return parseUserSpecifiedModel(declared)
}

/** The exported chokepoint: floors the fully-resolved string. */
export function getAgentModelWithFloorNote(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): { model: string; flooredFrom?: string } {
  const raw = resolveAgentModelRaw(agentModel, parentModel, toolSpecifiedModel, permissionMode)
  const floored = enforceSubagentModelFloor(raw, 'getAgentModel')
  return floored === raw ? { model: floored } : { model: floored, flooredFrom: raw }
}

export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): string {
  return getAgentModelWithFloorNote(agentModel, parentModel, toolSpecifiedModel, permissionMode).model
}

// ---------------------------------------------------------------------------
// Display + picker options
// ---------------------------------------------------------------------------

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

/** The default-model display: no model → inheriting + default marker; the
 *  explicit inherit value → inheriting without the marker; else capitalized. */
export function getAgentModelDisplay(model: string | undefined | null): string {
  if (model === undefined || model === null) return 'Inherit from parent (default)'
  if (model === INHERIT) return 'Inherit from parent'
  return capitalizeFirst(model)
}

// The static picker list (getAgentModelOptions + FAMILY_BLURBS) RETIRED
// (the multiauth mandate): the picker road rides
// agentModelPicker.getAgentModelPickerRows — THE ONE catalogue owner's
// agent projection (getModelOptions), provider-neutral in the catalogue's
// own order. AGENT_MODEL_OPTIONS above stays: it is the frontmatter
// VALIDATION type source, never a picker.

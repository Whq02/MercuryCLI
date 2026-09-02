// ============================================================================
//  agentModelPicker — THE MULTIAUTH MANDATE's one derivation (the
//  operator's frontier pass): AGENTS CAN BE ANY MODEL FROM THE
//  AVAILABLE CATALOGUE.
//
//  The rows ride THE ONE catalogue owner (getModelOptions — the /model
//  picker's own feed, the cross-surface precedent) in the catalogue's OWN
//  order and grouping: no family privileged, no family hidden — the
//  neutrality law is structural here, not editorial. Both agent-form skins
//  (the in-chat ModelSelector and the Boot face's pick layer) consume THIS
//  list; the old static alias list (getAgentModelOptions) retired from the
//  picker road with it.
//
//  Two principled exclusions, each the catalogue's own grammar:
//    · the null Default pseudo-row — 'Inherit' is the agent grammar's own
//      default (an agent follows its parent, not the account default);
//    · Anthropic haiku-tier rows — the subagent floor (modelFloor) would
//      silently rewrite the pick, and offering a row the floor rewrites is
//      dishonest (non-Anthropic ids with 'haiku' in the slug stay, by the
//      floor's own routing exemption).
//
//  UNAVAILABLE rows stay VISIBLE wearing their reason, and picking one — or
//  a connect/attach ACTION row — answers `needs-sign-in`: the skins route
//  it to the sign-in door (the face swaps to its Logins layer and returns;
//  the chat names /logins on the note). A definition may still SAVE a model
//  that is unavailable right now (availability is a session fact, the
//  born-held precedent) — the form and review wear the truth instead of
//  refusing the durable intent.
// ============================================================================
import {
  ANTHROPIC_MODEL_GROUP,
  getModelOptions,
  isProviderActionRow,
  type ModelOption,
} from './modelOptions.js'
import { isHaikuTier } from './modelFloor.js'

/** The inherit sentinel (the agent contract's own word). */
const INHERIT = 'inherit'

export type AgentModelPickerRow = {
  /** What the definition's `model:` field stores when picked ('inherit'
   *  maps to an ABSENT field at commit — the machine's own law). */
  value: string
  label: string
  description: string
  /** The catalogue's own group heading (the /model picker's spelling). */
  group: string
  kind: 'inherit' | 'model' | 'connect'
  /** Present ⇔ visible but not selectable as a model — picking routes to
   *  the sign-in door with this reason. */
  unavailable?: string
}

export function getAgentModelPickerRows(
  catalogue: ModelOption[] = getModelOptions(),
): AgentModelPickerRow[] {
  const rows: AgentModelPickerRow[] = [
    {
      value: INHERIT,
      label: 'Inherit',
      description: 'Use the same model as the parent session',
      group: 'Agent',
      kind: 'inherit',
    },
  ]
  for (const opt of catalogue) {
    if (opt.value === null) continue
    if (isHaikuTier(opt.value)) continue
    const group = opt.group ?? ANTHROPIC_MODEL_GROUP
    if (isProviderActionRow(opt.value)) {
      rows.push({ value: opt.value, label: opt.label, description: opt.description, group, kind: 'connect' })
      continue
    }
    rows.push({
      value: opt.value,
      label: opt.label,
      description: opt.description,
      group,
      kind: 'model',
      ...(opt.unavailable !== undefined ? { unavailable: opt.unavailable } : {}),
    })
  }
  return rows
}

/** The SESSION availability note for a definition's saved model — null for
 *  inherit/absent, for an available row, and for an id the catalogue does
 *  not know (unknown is not unavailable: a custom id may dispatch fine;
 *  the provider answers at call time). The surfaces wear this beside the
 *  effective model so a durable definition whose provider is signed out
 *  says so instead of failing silently at dispatch — availability is a
 *  session fact, never a validation error (the born-held precedent). */
export function agentModelAvailabilityNote(
  model: string | undefined,
  rows: AgentModelPickerRow[] = getAgentModelPickerRows(),
): string | null {
  if (model === undefined || model === INHERIT) return null
  const row = rows.find(r => r.value === model)
  return row?.unavailable ?? null
}

export type AgentModelPickOutcome =
  | { kind: 'picked'; model: string | undefined }
  | { kind: 'needs-sign-in'; hint: string }

/** The ONE pick adjudication both skins share: a connect row IS a sign-in
 *  door; an unavailable model routes there with its reason; a live model
 *  commits ('inherit' commits the absent field). */
export function agentModelPickOutcome(row: AgentModelPickerRow): AgentModelPickOutcome {
  if (row.kind === 'connect') return { kind: 'needs-sign-in', hint: `${row.label} — ${row.description}` }
  if (row.unavailable !== undefined) return { kind: 'needs-sign-in', hint: `${row.label} — ${row.unavailable}` }
  return { kind: 'picked', model: row.kind === 'inherit' ? undefined : row.value }
}

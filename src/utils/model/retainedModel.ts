// ============================================================================
//  utils/model/retainedModel — the ONE conversation-model retention law.
//
//  Two readers walk a transcript backwards for the model that actually
//  served it: the interactive/headless predicate (sessionRestore's
//  restoreConversationModelFromMessages) and the daemon supervisor's
//  resumeModelKeyOf. Both must answer identically, so the two laws they
//  share live here, in a leaf the daemon can import without the session
//  restore estate:
//
//    · row eligibility is PROVENANCE, never id spelling — every
//      locally-fabricated assistant row (interrupts, API-error stand-ins,
//      model-switch breadcrumbs, resume sentinels) stamps the factories'
//      SYNTHETIC_MODEL and is skipped; every row a transport codec settles
//      stamps the id the wire actually served and retains verbatim.
//    · the billing-safe form — when the conversation ran the current
//      default's base id, retention answers the default SETTING (context
//      annotation intact) so a resumed session is posture-identical to a
//      fresh one; anything else answers the served id verbatim, never an
//      invented suffix.
// ============================================================================
import { SYNTHETIC_MODEL } from '../messages/factories.js'
import {
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from './model.js'

/** The served model of one transcript row, or undefined when the row is
 *  not an assistant row a wire actually served (the provenance law). */
export function servedModelOfAssistantRow(row: {
  type?: unknown
  message?: { model?: unknown }
}): string | undefined {
  if (row.type !== 'assistant') return undefined
  const model = row.message?.model
  return typeof model === 'string' && model !== '' && model !== SYNTHETIC_MODEL ? model : undefined
}

/** The billing-safe retained form of a served id. The annotation strip is
 *  the model owner's (normalizeModelStringForAPI), never a local regex. */
export function billingSafeRetainedForm(servedModel: string): string {
  const resolvedDefault = parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
  return servedModel === normalizeModelStringForAPI(resolvedDefault) ? resolvedDefault : servedModel
}

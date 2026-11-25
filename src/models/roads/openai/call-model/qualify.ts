import { withDeadline } from '../../../../platform/async/deadline.js'
import { modelNotOfferedByCatalogue } from '../../catalogueAdmission.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  evaluateGptCandidate,
  qualifiedGptCandidates,
  refreshOpenaiCatalogue,
  type GptCandidate,
} from '../openaiCatalogue.js'

type QualificationOutcome =
  | { kind: 'ok'; modelId: string; candidate: GptCandidate }
  | { kind: 'degraded'; modelId: string; note: string }
  | { kind: 'refused'; message: string }

export async function qualifyRequestedModel(
  requestedId: string,
  auth: OpenaiRequestAuth,
  signal: AbortSignal,
): Promise<QualificationOutcome> {
  const sourceKind = auth.account.kind
  const snapshot = await withDeadline(refreshOpenaiCatalogue(sourceKind), Number.POSITIVE_INFINITY, () => null, { signal, onAbort: () => null })
  if (requestedId === 'gpt') {
    const candidates = qualifiedGptCandidates('specialist', sourceKind)
    const head = candidates[0]
    if (head) return { kind: 'ok', modelId: head.identity.canonicalId, candidate: head }
    return {
      kind: 'refused',
      message: snapshot?.lastError
        ? `the GPT class alias cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact id (e.g. gpt-5.6-sol) or retry when the catalogue reachability recovers.`
        : `the GPT class alias cannot resolve — the ${auth.account.label} catalogue offers no usable GPT model.`,
    }
  }
  const evaluated = evaluateGptCandidate(requestedId, sourceKind)
  if (evaluated.ok) {
    return { kind: 'ok', modelId: evaluated.candidate.identity.canonicalId, candidate: evaluated.candidate }
  }
  const why = evaluated.why
  if (why.reason === 'catalogue-unavailable') {
    return {
      kind: 'degraded',
      modelId: requestedId,
      note: `[openai] the live model catalogue is unavailable${why.detail ? ` (${why.detail})` : ''} — proceeding with '${requestedId}' on the provider's default reasoning effort (no live effort vocabulary to resolve against).`,
    }
  }
  const qualified = qualifiedGptCandidates('specialist', sourceKind)
    .map(c => c.identity.canonicalId)
    .join(', ')
  if (why.reason === 'not-in-live-catalogue') {
    return { kind: 'refused', message: modelNotOfferedByCatalogue(requestedId, auth.account.label, qualified ? qualified.split(', ') : []) }
  }
  const catalogueHint = qualified ? ` The catalogue offers: ${qualified}.` : ''
  const reasonText =
    why.reason === 'hidden-or-retired'
        ? `is hidden/retired in the live catalogue (${why.detail})`
        : why.reason === 'unparseable-id'
          ? `is not a parseable GPT model id`
          : `is not accepted by the live catalogue (${why.reason})`
  return {
    kind: 'refused',
    message: `model '${requestedId}' ${reasonText}.${catalogueHint}`,
  }
}

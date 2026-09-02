import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { recognizeModelId, unrecognisedModelIdReason } from './idSpaces.js'
import { canonicalWireModelId } from './routeLaw.js'

export interface HomeLaneAdmissionReads {
  firstPartyBaseUrl?: () => boolean
  env?: Record<string, string | undefined>
}

export function homeLaneAdmissionRefusal(
  model: string,
  reads?: HomeLaneAdmissionReads,
): string | null {
  const firstPartyOrigin = reads?.firstPartyBaseUrl?.() ?? isFirstPartyAnthropicBaseUrl()
  if (!firstPartyOrigin) return null
  const verdict = canonicalWireModelId(model)
  if (!verdict.ok) return verdict.reason
  const recognition = recognizeModelId(model, reads?.env)
  if (recognition.kind !== 'unrecognised') return null
  return `${unrecognisedModelIdReason(model)}. Refused before any request — the /model picker lists the live catalogues.`
}

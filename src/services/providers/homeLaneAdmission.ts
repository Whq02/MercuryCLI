// ============================================================================
//  providers/homeLaneAdmission — the ONE pre-wire admission of a model id to
//  the home (Anthropic-compatible) lane, shared by the /model typing door
//  (validateModel) and the dispatch seam (routedCallModel's home arm).
//
//  THE LAW (the operator's neutrality ruling): the home lane is
//  a declared family, not the unmarked remainder, and it EARNS every ride.
//  An id NO family declares still CLASSES home (the routing law stays a
//  total classifier), but it reaches the wire only on an operator-owned
//  fact:
//    (a) an ANTHROPIC_* model env pin names the id — recognition then says
//        first-party/env-pin, so it never arrives here unrecognised; or
//    (b) the home lane is re-pointed at a gateway (ANTHROPIC_BASE_URL off
//        the first-party host) — the operator named the endpoint, and the
//        endpoint owns its ids.
//  With NEITHER fact the id refuses HERE, typed and before any HTTP,
//  credentialed or not. A credential is not an earned fact: letting a
//  credentialed wire adjudicate an id no family declares was still a
//  silent first-party classing (and a burned request); the refusal names
//  the id, the declared vocabulary and both earned roads instead. Every
//  recognised id admits (first-party ids keep the lane's own auth refusal;
//  declared families never reach this arm).
//
//  ABSENCE IS NOT UNKNOWNNESS, and both are first-class now (the operator's
//  phase-2 ruling): classifyModelRoute answers 'absence' for no-id-at-all
//  and 'unrecognised' for an id nobody declares — neither is any family's
//  remainder. This owner's input is a RESOLVED id: the dispatch seam and
//  the typing door resolve or refuse absence at their own doors first.
//
//  THE WIRE-ID LAW IS NOT SUSPENDED ON THE HOME LANE (windows field
//  w3-f07-01: a carrier-shaped id — 'anthropic/claude-opus-5', a catalogue
//  row spelled without its carrier — reached api.anthropic.com verbatim
//  because the one canonicalizing owner was asked on every bare lane except
//  this one). On the FIRST-PARTY origin the owner's verdict decides first:
//  no first-party id carries a path separator, so a '/' id can never be
//  served there and refuses with the owner's own catalogue words,
//  credentialed or not. A gateway base URL admits it — proxies that front
//  several vendors on an Anthropic-compatible wire serve exactly such ids,
//  and the operator named the endpoint.
//
//  Any failed read ADMITS — a broken presence read must never refuse a turn
//  the wire would have served (the base-URL read's own unparseable arm
//  already answers "gateway", which admits).
// ============================================================================
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { recognizeModelId, unrecognisedModelIdReason } from './idSpaces.js'
import { canonicalWireModelId } from './routeLaw.js'

/** Injectable reads for provers; production callers pass nothing. */
export interface HomeLaneAdmissionReads {
  firstPartyBaseUrl?: () => boolean
  env?: Record<string, string | undefined>
}

/**
 * null = admitted to the home wire; a string = the typed refusal (the
 * reason names the id, the declared families, both earned roads and the
 * remedy — surfaces render it verbatim).
 */
export function homeLaneAdmissionRefusal(
  model: string,
  reads?: HomeLaneAdmissionReads,
): string | null {
  const firstPartyOrigin = reads?.firstPartyBaseUrl?.() ?? isFirstPartyAnthropicBaseUrl()
  // Earned road (b): the operator re-pointed the home lane — the endpoint
  // owns its ids.
  if (!firstPartyOrigin) return null
  // The wire-id owner first: junk for the first-party wire is junk (a
  // bare-family '/' id, dressing beyond Mercury's own annotations).
  const verdict = canonicalWireModelId(model)
  if (!verdict.ok) return verdict.reason
  // Earned road (a) lives inside recognition: an ANTHROPIC_* pin makes the
  // id first-party/env-pin, never unrecognised.
  const recognition = recognizeModelId(model, reads?.env)
  if (recognition.kind !== 'unrecognised') return null
  return `${unrecognisedModelIdReason(model)}. Refused before any request — the /model picker lists the live catalogues.`
}

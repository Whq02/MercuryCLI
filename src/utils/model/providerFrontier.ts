// ============================================================================
//  model/providerFrontier — the per-provider frontier recommendation fact
// ONE home for "the frontier model we
//  are aware of, per provider" and its copy line, consumed by every chooser
//  that groups models by provider (the /model picker's group details, the
//  coordinator picker's group headers).
//
//  Laws: the frontier is MEASURED, never remembered — every fact here is a
//  projection from the owning model-truth record, and a fact that is a
//  static pin carries its observedAt date in the copy. Where no owner
//  records a frontier fact at all (a live-only catalogue, an aggregator, an
//  operator-named endpoint) the answer is undefined — never an invented
//  ranking.
//
//  Sources, per family:
//    anthropic   frontierPolicy's registered candidate order (the
//                seam) — awareness = the highest-ranked candidate that is
//                actually registered live (eligibility is the account's
//                business, not awareness's); observedAt rides only when the
//                winning fact is a future-catalog static.
//    openai      the GPT display pins (last-observed records) ranked by the
//                real id grammar (major, minor) — dated.
//    zai · moonshot · deepseek
//                the lane's own pin table, flagship-first by construction —
//                dated.
//    gemini · openrouter · openai-compat
//                no recorded frontier fact (live-only catalogue / 400+ model
//                aggregator / operator-named endpoint) ⇒ undefined.
//    huggingface the live router catalogue's FIRST row (the router's own
//                ordering, undated) when fetched, else the first dated pin.
//    local       no ranking exists for an operator's own box ⇒ undefined.
// ============================================================================
import { declaredRouteOf, type CallModelRoute } from '../../services/providers/routeLaw.js'
import { GPT_DISPLAY_PINS, parseGptModelId } from '../../services/providers/openai/gptPins.js'
import { frontierOperatorDecision } from './frontierPolicy.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getMarketingNameForModel,
  getSmallFastModel,
} from './model.js'
import { keyLanePins } from './modelOptions.js'

export interface ProviderFrontierFact {
  modelId: string
  displayName: string
  /** YYYY-MM-DD the fact was last verified — present exactly when the fact
   *  is a static record; a live/registered fact carries none. */
  observedAt?: string
}

/** The frontier model this build is AWARE of for one provider family, from
 *  that family's own model-truth owner. undefined = no owner records one. */
export function providerFrontierFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        // Awareness, not eligibility: the frontier decision's leading
        // candidate (operator pins outrank at dispatch).
        const decision = frontierOperatorDecision()
        const aware = decision.candidates[0]
        if (!aware) return undefined
        return {
          modelId: aware.id,
          displayName: getMarketingNameForModel(aware.id) ?? aware.id,
        }
      }
      case 'openai': {
        // The pins ranked by the REAL id grammar — never list order alone.
        let best: { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number } | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          const identity = parseGptModelId(pin.id)
          if (!identity) continue
          if (
            best === undefined ||
            identity.major > best.major ||
            (identity.major === best.major && identity.minor > best.minor)
          ) {
            best = { pin, major: identity.major, minor: identity.minor }
          }
        }
        if (!best) return undefined
        return { modelId: best.pin.id, displayName: best.pin.displayName, observedAt: best.pin.observedAt }
      }
      case 'zai':
      case 'moonshot':
      case 'deepseek': {
        const pin = keyLanePins(route)[0]
        if (!pin) return undefined
        return { modelId: pin.id, displayName: pin.displayName, observedAt: pin.observedAt }
      }
      // No owner records a frontier fact for these lanes — an invented
      // ranking would be a remembered frontier, so the answer is silence.
      case 'gemini':
      case 'openrouter':
      case 'openai-compat':
      case 'local':
        return undefined
      case 'huggingface': {
        const { getCachedHuggingfaceCatalogue } =
          require('../../services/providers/huggingface/huggingfaceCatalogue.js') as typeof import('../../services/providers/huggingface/huggingfaceCatalogue.js')
        const live = getCachedHuggingfaceCatalogue()?.models[0]
        if (live) {
          const { huggingfaceSlugModelName } =
            require('../../services/providers/huggingface/huggingfacePins.js') as typeof import('../../services/providers/huggingface/huggingfacePins.js')
          return { modelId: `huggingface/${live.id}`, displayName: huggingfaceSlugModelName(live.id) }
        }
        const { HUGGINGFACE_DISPLAY_PINS } =
          require('../../services/providers/huggingface/huggingfacePins.js') as typeof import('../../services/providers/huggingface/huggingfacePins.js')
        const pin = HUGGINGFACE_DISPLAY_PINS[0]
        if (!pin) return undefined
        return { modelId: `huggingface/${pin.id}`, displayName: pin.displayName, observedAt: pin.observedAt }
      }
    }
  } catch {
    return undefined // a broken read never breaks a chooser — no claim
  }
}

/** The LIGHT-tier model this build is aware of for one provider family —
 *  the sub-frontier working tier (operator policy: standing side surfaces
 *  such as the Minerva curator default LIGHT, never frontier-class).
 *  anthropic answers through the mid-class owner (the sonnet-class row);
 *  openai through the pin grammar — the highest BASE-variant row whose
 *  parsed identity sits strictly below the frontier pin's. No other
 *  family's truth owner records a tier ranking, so the answer is silence —
 *  the same doctrine as the frontier fact (an invented ranking would be a
 *  remembered tier). */
export function providerLightFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        const modelId = getDefaultSonnetModel()
        return { modelId, displayName: getMarketingNameForModel(modelId) ?? modelId }
      }
      case 'openai': {
        const frontier = providerFrontierFact('openai')
        const ceiling = frontier ? parseGptModelId(frontier.modelId) : undefined
        if (!ceiling) return undefined
        let best: { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number } | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          const identity = parseGptModelId(pin.id)
          if (!identity || identity.variant !== '') continue
          const below =
            identity.major < ceiling.major ||
            (identity.major === ceiling.major && identity.minor < ceiling.minor)
          if (!below) continue
          if (
            best === undefined ||
            identity.major > best.major ||
            (identity.major === best.major && identity.minor > best.minor)
          ) {
            best = { pin, major: identity.major, minor: identity.minor }
          }
        }
        if (!best) return undefined
        return { modelId: best.pin.id, displayName: best.pin.displayName, observedAt: best.pin.observedAt }
      }
      default:
        return undefined
    }
  } catch {
    return undefined // a broken read never breaks a chooser — no claim
  }
}

/** The SMALL-FAST utility tier this build is aware of for one provider
 *  family — the tier utility one-shots ride (titles, recaps, state
 *  classification: cheap, quick, never the working tier). anthropic answers
 *  through the ratified small-tier owner (getSmallFastModel — the
 *  ANTHROPIC_SMALL_FAST_MODEL pin honoured, haiku the family default);
 *  openai through the pin grammar — the highest (major, minor) recorded pin
 *  whose variant is exactly 'mini' or 'nano' (OpenAI's own small-tier
 *  naming; availability-noted pins are excluded — a research preview is not
 *  a utility default). No other family's truth owner records a small tier,
 *  so the answer is silence — the same doctrine as the frontier and light
 *  facts (an invented ranking would be a remembered tier). */
export function providerSmallFastFact(route: CallModelRoute): ProviderFrontierFact | undefined {
  try {
    switch (route) {
      case 'anthropic': {
        const modelId = getSmallFastModel()
        return { modelId, displayName: getMarketingNameForModel(modelId) ?? modelId }
      }
      case 'openai': {
        let best:
          | { pin: (typeof GPT_DISPLAY_PINS)[number]; major: number; minor: number }
          | undefined
        for (const pin of GPT_DISPLAY_PINS) {
          if (pin.availabilityNote !== undefined) continue
          const identity = parseGptModelId(pin.id)
          if (!identity || (identity.variant !== 'mini' && identity.variant !== 'nano')) continue
          if (
            best === undefined ||
            identity.major > best.major ||
            (identity.major === best.major && identity.minor > best.minor)
          ) {
            best = { pin, major: identity.major, minor: identity.minor }
          }
        }
        if (!best) return undefined
        return { modelId: best.pin.id, displayName: best.pin.displayName, observedAt: best.pin.observedAt }
      }
      default:
        return undefined
    }
  } catch {
    return undefined // a broken read never breaks a utility call — no claim
  }
}

/**
 * The utility-call model for a session riding `sessionModel` — the routing
 * law decides the family, the family's recorded small-fast fact decides the
 * tier, and a family recording none follows the session's own model (never
 * a silent cross-family hop: a model id always rides its own wire, so the
 * account that serves the session serves its utility calls). The
 * ANTHROPIC_SMALL_FAST_MODEL pin applies exactly where its name says — the
 * anthropic route.
 */
export function smallFastModelFor(sessionModel: string): string {
  const route = declaredRouteOf(sessionModel)
  if (route === 'anthropic') return getSmallFastModel()
  // A stranger session's utility calls ride its own id on its own earned
  // lane — never a borrowed family's small tier.
  if (route === null) return sessionModel
  return providerSmallFastFact(route)?.modelId ?? sessionModel
}

/** The main-loop session's utility-call model (the common caller shape). */
export function sessionSmallFastModel(): string {
  return smallFastModelFor(getMainLoopModel())
}

/**
 * The light AGENT tier for the main-loop session — delegated verification
 * work (the hook agent) that must never ride the small tier (the never-Haiku
 * floor's law) and should not silently escalate to frontier-class either.
 * anthropic answers the mid-class owner (the same id the floor's fallback
 * names, so the anthropic default is unchanged by construction); elsewhere
 * the family's recorded light fact, and a family recording none follows the
 * session's own model.
 */
export function sessionLightModel(): string {
  const sessionModel = getMainLoopModel()
  const route = declaredRouteOf(sessionModel)
  if (route === 'anthropic') return getDefaultSonnetModel()
  if (route === null) return sessionModel
  return providerLightFact(route)?.modelId ?? sessionModel
}

/** The ONE copy line for the recommendation — chooser surfaces paint it
 *  verbatim (words only; layout belongs to the surface). Deliberately terse:
 *  the narrowest consuming slot is ~46 columns, and the observation date on
 *  a static fact must survive it (law 4 — a clipped date is no date). */
export function providerFrontierLine(route: CallModelRoute): string | undefined {
  const fact = providerFrontierFact(route)
  if (!fact) return undefined
  return `frontier: ${fact.displayName}${fact.observedAt ? ` · ${fact.observedAt}` : ''}`
}

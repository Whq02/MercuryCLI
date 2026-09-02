// =============================================================================
// MERCURY NATIVE CORE T16 — the model capability edge.
// -----------------------------------------------------------------------------
// ONE module owns the model→capability mapping: model identity · context
// capabilities · streaming/thinking features · tool support · structured
// output · media support · usage accounting · beta-header emission. Every
// decision body descends 1:1 from the pre-T16 homes (utils/betas.ts,
// utils/thinking.ts, utils/effort.ts, utils/context.ts — those modules now
// re-export their capability surface from here and keep only policy/state).
// Behavior is pinned check-by-check by
// scripts/core-runtime/prove-provider-contract.ts — the beta tables per
// model×env (the opus-4-8→opus-4-6 canonical quirk included) are an external
// contract; a table change lands only with the contract law updated in the
// same cut.
//
// Transport reality: Mercury speaks to the first-party Anthropic API,
// directly or through an ANTHROPIC_BASE_URL proxy — ./providers.ts owns the
// base-URL predicate. The third-party gateway estate is retired;
// nothing here branches on a transport, and core turn/tool/compaction/UI
// code reads THESE functions (or the resolved record) rather than making
// transport checks of its own.
// =============================================================================
// biome-ignore-all assist/source/organizeImports: sections mirror the record categories
import memoize from 'lodash-es/memoize.js'
import {
  checkFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/featureGates.js'
import { flagEnabled } from 'src/substrate/flagRegistry.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../../bootstrap/state.js'
import {
  CODING_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  SERVER_SIDE_FALLBACK_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
} from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import { getCanonicalName } from './model.js'
import { getModelCapability } from './modelCapabilities.js'
import { AUGUR_BETA_HEADER, isAugurHeader } from './augur.js'
import { isCarrierShapedId } from '../../services/providers/idSpaces.js'
// PURE zero-import module — last-observed GPT window facts.
import {
  gptDisplayPin,
  hasGptServedWindowSuffix,
  parseGptModelId,
} from '../../services/providers/openai/gptPins.js'
import {
  liveGptContextWindow,
  liveGptContextCeiling,
  liveGptDefaultEffort,
  liveGptEffortCatalogue,
} from '../../services/providers/openai/openaiCatalogue.js'
// PURE zero-import module — the documented GLM effort vocabulary,
// the SAME table the zai wire sends from.
import {
  glmEffortsFor,
  isGlmModelId,
} from '../../services/providers/zai/glmPins.js'
// PURE zero-import modules — the Kimi/DeepSeek
// documented vocabularies + dated window pins, the SAME tables their wires
// send from; and the pure routing law (permission neutrality below).
import {
  isKimiModelId,
  kimiDisplayPin,
  KIMI_EFFORTS,
  KIMI_EFFORT_MODELS,
} from '../../services/providers/moonshot/kimiPins.js'
import {
  deepseekDisplayPin,
  DEEPSEEK_EFFORTS,
  isDeepseekModelId,
} from '../../services/providers/deepseek/deepseekPins.js'
// PURE zero-import module — the Hugging Face id grammar (the live catalogue
// and the local discovery snapshot are read lazily below, never at load).
import { isHuggingfaceModelId } from '../../services/providers/huggingface/huggingfacePins.js'
import { classifyModelRoute, declaredRouteOf } from '../../services/providers/routeLaw.js'
import { isFirstPartyAnthropicBaseUrl } from './providers.js'
import { getInitialSettings } from '../settings/settings.js'

// =============================================================================
// SAMPLING — the temperature switch (model identity, provider-independent)
// =============================================================================

/**
 * Claude 5-family models (generation ≥ 5: claude-sonnet-5, claude-fable-5, …)
 * DEPRECATED the `temperature` sampling knob — the API 400s on the param's
 * PRESENCE ("`temperature` is deprecated for this model"; measured live
 * on claude-sonnet-5 via the auto-mode classifier, which sent
 * temperature:0). Every temperature-sending seam gates on this so an
 * unsupported-model request never carries the param; older families are
 * unchanged (the main loop already only sends it when thinking is disabled).
 * Generation parses from the modern id shape `claude-<family>-<gen>…`; legacy
 * ids (`claude-3-7-sonnet…`) don't match the shape and stay supported.
 *
 * NOT just the 5-family: Opus 4.7+ ALSO rejects sampling params (removed at
 * 4.7). Same-day bench forensics (PM): the classifier side query
 * sent temperature to claude-opus-4-8 → 400 → every classified action on an
 * opus-4-8 session read "temporarily unavailable" and auto mode was write-dead
 * on opus sessions — run #3's fix caught only major ≥ 5, and run #4's live
 * test was a sonnet seat, so the opus classifier path went unexercised.
 * Still supported: Opus ≤4.6, Sonnet ≤4.6, Haiku 4.5, all 3.x. The minor
 * capture is 1-2 digits with a non-digit boundary so dated snapshot ids
 * ('claude-opus-4-20250514') read minor 0, not the date.
 */
export function modelSupportsTemperature(model: string): boolean {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model)
  if (!m) return true
  const family = m[1]!
  const major = parseInt(m[2]!, 10)
  const minor = m[3] !== undefined ? parseInt(m[3], 10) : 0
  if (major >= 5) return false
  if (family === 'opus' && major === 4 && minor >= 7) return false
  return true
}

// =============================================================================
// THINKING — streaming/thinking feature switches
// =============================================================================

// Interleaved thinking: every Claude 4+ family takes it; only the 3.x line
// predates it.
export function modelSupportsISP(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

// The thinking switch proper — same edge as modelSupportsISP, kept as its
// own named accessor because the two capabilities are separate API facts
// that happen to share a boundary today. CAUTION: this arm is model-
// quality-load-bearing — a model that should think but doesn't silently
// degrades on every turn; move the boundary only against documented
// support.
export function modelSupportsThinking(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

// Maintenance: a model joins this allowlist by hand once it ships adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  // The current-generation rows FIRST: Sonnet 5 / Opus 5 are
  // adaptive-thinking-ONLY — a manual budget_tokens 400s on them — and the
  // legacy family exclusion below would wrongly reject claude-sonnet-5 on
  // its bare 'sonnet' substring, sending the removed enabled+budget_tokens
  // shape and 400ing every default turn. Same ordering as the effort caps.
  if (canonical.includes('sonnet-5') || canonical.includes('opus-5')) {
    return true
  }
  // The frontier family (Fable 5 / 5.1, the Mythos mirrors): adaptive
  // thinking is the ONLY mode — always on, and both `disabled` and a manual
  // budget return 400 (the Fable 5.1 migration guide, fetched 2026-09-01).
  if (canonical.includes('fable-5') || canonical.includes('mythos-5')) {
    return true
  }
  // The known-family allowlist: 4.6 variants take adaptive thinking.
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  // Every OTHER recognized legacy family does not (the 4-6 allowlist above
  // already claimed its variants before this family-substring exclusion).
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // UNKNOWN id: default TRUE, deliberately — models newer than this table
  // are trained ON adaptive thinking, and a false default would silently
  // degrade every response they give. Narrow only against documented
  // support; this default is model-quality protection, not optimism.
  return true
}

/**
 * Thinking is ALWAYS ON for the frontier family (Fable 5 / 5.1 and the
 * Mythos mirrors): `thinking: {type: 'disabled'}` and a manual budget both
 * return 400 (the thinking page and the Fable 5.1 migration guide, fetched
 * 2026-09-01). A wire builder that wants "no thinking" on such a model OMITS
 * the parameter — adaptive runs, and lower effort is the spend lever.
 */
export function modelThinkingAlwaysOn(model: string): boolean {
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return canonical.includes('fable-5') || canonical.includes('mythos-5')
}

/**
 * Forced tool choice (`any` / `tool`): Claude Fable 5.1 (and the Mythos 5.1
 * mirror, which folds onto its canonical) return a 400 —
 *   tool_choice: type "tool" and "any" are not supported for this model.
 * `auto` and `none` are unchanged there; every other model keeps the forced
 * modes (Fable 5 included).
 */
export function modelSupportsForcedToolChoice(model: string): boolean {
  if (isCarrierShapedId(model)) return true
  return getCanonicalName(model) !== 'claude-fable-5-1'
}

/**
 * The ONE tool-choice fold every Anthropic wire builder applies: a forced
 * choice on a model that rejects it becomes `auto` (the prompt still names
 * the tool — the docs' own replacement) instead of buying a 400. Pure: the
 * input returns unchanged everywhere else.
 */
export function foldToolChoiceForModel<T extends { type: string }>(
  model: string,
  toolChoice: T | undefined,
): T | { type: 'auto' } | undefined {
  if (toolChoice === undefined) return undefined
  if (toolChoice.type !== 'any' && toolChoice.type !== 'tool') return toolChoice
  if (modelSupportsForcedToolChoice(model)) return toolChoice
  return { type: 'auto' }
}

// =============================================================================
// CONTEXT MANAGEMENT · STRUCTURED OUTPUTS · AUTO MODE — feature switches
// =============================================================================

// Context management: Claude 4+ — the same 3.x boundary as thinking.
export function modelSupportsContextManagement(model: string): boolean {
  return !getCanonicalName(model).includes('claude-3-')
}

// Maintenance: hand-extend this id list when a non-catalog model gains structured outputs.
export function modelSupportsStructuredOutputs(model: string): boolean {
  // Only the Anthropic lane's codec carries output_format / the structured-
  // outputs beta: the Responses bridge and the shared chat-completions
  // codec send neither, so a Claude slug behind a carrier (openrouter/
  // anthropic/claude-opus-5) must read false — the substring join below
  // would promise schema-shaped answers the wire cannot request.
  if (declaredRouteOf(model) !== 'anthropic') return false
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-opus-5') ||
    // Live-verified: a schema-forced json_schema plan on
    // claude-fable-5 came back schema-shaped and validator-clean.
    canonical.includes('claude-fable-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}

// Maintenance: auto mode requires the model to handle the prompt-injection probes — verify that before widening this gate.
export function modelSupportsAutoMode(model: string): boolean {
  // PROVIDER NEUTRALITY (the skip-perms
  // inequality's site): permission behaviour never keys on the provider.
  // Every engine-lane main model (gpt/glm/kimi/deepseek/compat) gets flow on
  // the same terms as the home lane. The classifier chain
  // (yoloClassifier.getClassifierModelChain) prefers the Anthropic tier
  // whenever that lane is usable — the safety envelope is unchanged there —
  // and classifies on the session's own family over the provider-routed
  // transport when no Anthropic lane can take work.
  if (declaredRouteOf(model) !== 'anthropic') return true
  // Fork un-gate: auto mode is functional in Mercury. Mercury runs
  // firstParty Opus 4.8 (canonical claude-opus-4-6), which already matches the
  // external allowlist below, so this is the only change needed for the gate.
  {
    const m = getCanonicalName(model)
    // The gate override: mercury_auto_mode_config.allowModels force-enables
    // listed models past the allowlist below. An exact id entry matches
    // only that id; a canonical-name entry matches its whole family.
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowModels?: string[]
    }>('mercury_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        am => am.toLowerCase() === rawLower || am.toLowerCase() === m,
      )
    ) {
      return true
    }

    // The allowlist proper. Fable 5 (and Mythos, which folds to the fable
    // canonical) is a DELIBERATE Mercury extension (frontier policy,
    //): the frontier-operator policy makes it the fresh-session
    // foreground default on the eligible Max-20x path, and without this
    // line every such session would silently lose auto mode
    // (permissionSetup disables it when the model fails this gate).
    return (
      /^claude-(opus|sonnet)-4-6/.test(m) ||
      m === 'claude-fable-5' ||
      // Claude Fable 5.1 — the same family, its own canonical.
      m === 'claude-fable-5-1'
    )
  }
}

// =============================================================================
// EFFORT — the per-family effort capability tables
// =============================================================================

// ── GPT effort truth (vocabulary states
//) ────────────────────────────────────────────────────────────────
// gpt-* ids resolve effort capability from the LIVE per-model catalogue — the
// SAME vocabulary resolveGptReasoningProfile sends from — so DISPLAY truth
// equals DISPATCH truth (the statusbar would otherwise clamp 'max'→'high' on Sol via
// the Anthropic-only tables below while the wire honored 'max').
//
// keeps the FOUR vocabulary states distinct (the old accessor
// collapsed known-empty into unavailable, so the banked fallback masqueraded
// over an explicitly effort-less model while the wire omitted the key):
//   · live       — a stated NON-EMPTY vocabulary: capability = membership;
//   · known-empty — a stated EMPTY vocabulary: effort is NOT selectable
//                   (chrome hidden, wire omits — both sides agree);
//   · unstated   — live-listed, vocabulary not stated (bare row): controls
//                   offer the full Mercury ladder, the wire omits (nothing to
//                   verify against), the applied display claims 'default';
//   · unavailable — catalogue unfetched/unreachable: same treatment as
//                   unstated (full offering · wire omits · 'default').
export type GptEffortVocabularyView =
  | { state: 'not-gpt' }
  | { state: 'live'; vocabulary: readonly string[]; defaultEffort?: string }
  | { state: 'known-empty'; defaultEffort?: string }
  | { state: 'unstated'; defaultEffort?: string }
  | { state: 'unavailable' }

export function gptEffortVocabularyView(model: string): GptEffortVocabularyView {
  const identity = parseGptModelId(model)
  if (!identity) return { state: 'not-gpt' }
  const catalogue = liveGptEffortCatalogue(identity.canonicalId)
  if (!catalogue) return { state: 'unavailable' }
  if (catalogue.vocabulary.length > 0) {
    return {
      state: 'live',
      vocabulary: catalogue.vocabulary,
      ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
    }
  }
  if (catalogue.stated) {
    return {
      state: 'known-empty',
      ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
    }
  }
  return {
    state: 'unstated',
    ...(catalogue.defaultEffort ? { defaultEffort: catalogue.defaultEffort } : {}),
  }
}

// ── THE ONE per-model effort vocabulary owner ───────────────────────────────
// Every question about a model's effort dial — does it take one, which
// tiers, which ceiling, whether the dial is its reasoning dial — is answered
// HERE, per provider, from the same pins and live rows the wire builders
// send from. The resolution owner (utils/effort.ts) steps a request through
// this vocabulary exactly as the builders do, and the three capability
// predicates below are projections of it — one table, never a second copy
// (a second copy is the display/dispatch-divergence class). Kinds:
//   · ladder   — the first-party effort families (the Claude API effort
//                docs: Fable 5 / 5.1, Sonnet 5, Opus 5, Opus 4.7 / 4.8 take
//                the five tiers; Opus 4.5 / 4.6 and Sonnet 4.6 take max but
//                not xhigh) and the unknown-id default — a model newer than
//                this table takes effort, withholding it would quietly cap
//                it (low · medium · high until its ceiling is documented);
//   · provider — a per-model vocabulary the provider stated or documents:
//                a GPT live row, a GLM id (glmPins, PER MODEL — glm-5.3
//                speaks low|high|max, glm-5.2 the seven-level set; the union
//                would claim xhigh on 5.3), Kimi K3, DeepSeek, a Gemini
//                thinking row, an OpenRouter row, a local server kind
//                (Ollama / LM Studio state a thinking capability per model,
//                vLLM / llama.cpp accept the knob for any model);
//   · offered  — a GPT id whose live vocabulary is unstated or whose
//                catalogue is unreachable: the full ladder is OFFERED, the
//                wire omits the key and the label says 'default' — dispatch
//                re-validates live and names adjustments (the old per-
//                generation split here restated a dated observation as a
//                rule; offering is not a claim, the wire is);
//   · none     — no effort control: the wire sends no dial and no surface
//                offers one — a GPT row stating an EMPTY vocabulary (the
//                live truth), an undocumented GLM or Kimi id, Hugging Face
//                (the router documents reasoning_effort as provider- and
//                model-dependent with no per-model vocabulary), an
//                OpenRouter or Gemini row stating none, the operator-named
//                compat slot (no documented vocabulary to verify against),
//                LM Studio and unknown-kind local servers, a carrier-shaped
//                id (the vendor row is the identity — never the first-party
//                tables by substring), the legacy first-party families
//                (Haiku, earlier Sonnets and Opuses).
// `thinkingGated` marks the lanes whose effort dial IS their reasoning dial
// — DeepSeek's thinking object, OpenRouter's reasoning object, Gemini's
// reasoning_effort: a session with thinking off sends no dial there and the
// surfaces say the provider default applies — the one stated rule across
// the request builders (FN-018 rank 15); a knob independent of thinking
// (Moonshot's and GLM's top-level reasoning_effort, the local servers') is
// sent regardless.
export type EffortVocabularyView =
  | { kind: 'ladder'; source: 'first-party' | 'unknown-id'; vocabulary: readonly EffortLevel[] }
  | {
      kind: 'provider'
      source: 'gpt-live' | 'glm' | 'kimi' | 'deepseek' | 'gemini' | 'openrouter' | 'local'
      vocabulary: readonly string[]
      defaultEffort?: string
      thinkingGated: boolean
    }
  | { kind: 'offered'; source: 'gpt-unstated' | 'gpt-unavailable'; defaultEffort?: string }
  | {
      kind: 'none'
      source:
        | 'gpt-known-empty'
        | 'glm'
        | 'kimi'
        | 'huggingface'
        | 'openrouter'
        | 'gemini'
        | 'compat'
        | 'local'
        | 'carrier'
        | 'first-party-legacy'
      defaultEffort?: string
    }

const FIRST_PARTY_FULL_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const FIRST_PARTY_LADDER_TO_MAX: readonly EffortLevel[] = ['low', 'medium', 'high', 'max']
const UNKNOWN_ID_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high']

export function effortVocabularyFor(model: string): EffortVocabularyView {
  // GPT: the LIVE per-model catalogue, four states kept distinct (the old
  // accessor collapsed known-empty into unavailable, so the banked fallback
  // masqueraded over an explicitly effort-less model while the wire omitted
  // the key).
  const gpt = gptEffortVocabularyView(model)
  switch (gpt.state) {
    case 'live':
      return {
        kind: 'provider',
        source: 'gpt-live',
        vocabulary: gpt.vocabulary,
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
        thinkingGated: false,
      }
    case 'known-empty':
      return {
        kind: 'none',
        source: 'gpt-known-empty',
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
      }
    case 'unstated':
      return {
        kind: 'offered',
        source: 'gpt-unstated',
        ...(gpt.defaultEffort !== undefined ? { defaultEffort: gpt.defaultEffort } : {}),
      }
    case 'unavailable':
      return { kind: 'offered', source: 'gpt-unavailable' }
    case 'not-gpt':
      break
  }
  if (isGlmModelId(model)) {
    const vocabulary = glmEffortsFor(model)
    return vocabulary
      ? { kind: 'provider', source: 'glm', vocabulary: [...vocabulary], thinkingGated: false }
      : { kind: 'none', source: 'glm' }
  }
  if (isKimiModelId(model)) {
    return KIMI_EFFORT_MODELS.has(model.trim().toLowerCase())
      ? { kind: 'provider', source: 'kimi', vocabulary: [...KIMI_EFFORTS], thinkingGated: false }
      : { kind: 'none', source: 'kimi' }
  }
  if (isDeepseekModelId(model)) {
    return { kind: 'provider', source: 'deepseek', vocabulary: [...DEEPSEEK_EFFORTS], thinkingGated: true }
  }
  if (isHuggingfaceModelId(model)) return { kind: 'none', source: 'huggingface' }
  const route = declaredRouteOf(model)
  if (route === 'openrouter') {
    // The LIVE row's stated reasoning vocabulary is the dial (the wire sends
    // `reasoning.effort` from the same list — buildOpenrouterExtras); a row
    // stating none, an unlisted slug or an unfetched catalogue offers none.
    const { openrouterEffortVocabularyFor } =
      require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
    const vocabulary = openrouterEffortVocabularyFor(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'openrouter', vocabulary, thinkingGated: true }
      : { kind: 'none', source: 'openrouter' }
  }
  if (route === 'gemini') {
    // The live row's `thinking` statement decides; the documented ladder
    // (low · medium · high) is what the wire sends (buildGeminiExtras).
    const { geminiEffortVocabularyFor } =
      require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
    const vocabulary = geminiEffortVocabularyFor(model)
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'gemini', vocabulary, thinkingGated: true }
      : { kind: 'none', source: 'gemini' }
  }
  if (route === 'openai-compat') return { kind: 'none', source: 'compat' }
  if (model.trim().toLowerCase().startsWith('local/')) {
    const { localRecordFor } =
      require('../../services/providers/local/localCatalogue.js') as typeof import('../../services/providers/local/localCatalogue.js')
    const { localModelAcceptsEffort } =
      require('../../services/providers/local/localCallModel.js') as typeof import('../../services/providers/local/localCallModel.js')
    const { LOCAL_SERVER_EFFORTS } =
      require('../../services/providers/openaicompat/compatWire.js') as typeof import('../../services/providers/openaicompat/compatWire.js')
    const record = localRecordFor(model)
    const vocabulary = record && localModelAcceptsEffort(record) ? LOCAL_SERVER_EFFORTS[record.server] : []
    return vocabulary.length > 0
      ? { kind: 'provider', source: 'local', vocabulary, thinkingGated: false }
      : { kind: 'none', source: 'local' }
  }
  if (isCarrierShapedId(model)) return { kind: 'none', source: 'carrier' }
  const m = model.toLowerCase()
  // The documented first-party effort families. Every row is explicit: the
  // 4.7/4.8 rows were once missing and the family fallthrough silently
  // disabled effort — xhigh included — on live Opus defaults.
  if (
    m.includes('sonnet-5') ||
    m.includes('opus-5') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('fable') ||
    m.includes('mythos')
  ) {
    return { kind: 'ladder', source: 'first-party', vocabulary: FIRST_PARTY_FULL_LADDER }
  }
  if (m.includes('opus-4-5') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return { kind: 'ladder', source: 'first-party', vocabulary: FIRST_PARTY_LADDER_TO_MAX }
  }
  // Any other recognized legacy family: no effort parameter.
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return { kind: 'none', source: 'first-party-legacy' }
  }
  // UNKNOWN id: effort ON — model-quality-sensitive; narrow this only
  // against documented support.
  return { kind: 'ladder', source: 'unknown-id', vocabulary: UNKNOWN_ID_LADDER }
}

/** Does the owner's view offer `level`? The offered kind answers yes for
 *  every ladder word (the full ladder is offered while live truth is
 *  unknown; the wire re-validates). */
function vocabularyOffers(view: EffortVocabularyView, level: EffortLevel): boolean {
  switch (view.kind) {
    case 'none':
      return false
    case 'offered':
      return true
    case 'ladder':
    case 'provider':
      return (view.vocabulary as readonly string[]).includes(level)
  }
}

/**
 * The Mercury-ladder default for a gpt id: the live catalogue's default
 * reasoning level when it names a Mercury level ('low' for Sol — live truth
 *), undefined otherwise (callers keep their own fallback). Keeps
 * getDisplayedEffortLevel/resolveAppliedEffort agreeing with what the wire's
 * 'model-default' profile actually sends when no effort is set.
 */
export function gptModelDefaultEffort(model: string): EffortLevel | undefined {
  const live = gptModelDefaultEffortRaw(model)
  return live === 'low' || live === 'medium' || live === 'high' || live === 'xhigh' || live === 'max'
    ? live
    : undefined
}

/** The RAW live default reasoning level for a gpt id — may sit OUTSIDE the
 * Mercury ladder ('minimal', 'ultra', …). the wire's
 *  'model-default' profile sends this exact tier, so the display label must
 *  be able to name it truthfully instead of falling back to a ladder guess. */
export function gptModelDefaultEffortRaw(model: string): string | undefined {
  const identity = parseGptModelId(model)
  if (!identity) return undefined
  return liveGptDefaultEffort(identity.canonicalId)
}

// The three capability predicates are PROJECTIONS of the one vocabulary
// owner above — a model takes the effort parameter iff it has a dial, and
// 'max' / 'xhigh' are served iff its vocabulary carries the word (the
// offered kind says yes to both: the full ladder is offered while live
// truth is unknown, and the wire re-validates). Model-quality-sensitive:
// the family rows live in effortVocabularyFor, against documented support.
export function modelSupportsEffort(model: string): boolean {
  return effortVocabularyFor(model).kind !== 'none'
}

export function modelSupportsMaxEffort(model: string): boolean {
  return vocabularyOffers(effortVocabularyFor(model), 'max')
}

export function modelSupportsXHighEffort(model: string): boolean {
  return vocabularyOffers(effortVocabularyFor(model), 'xhigh')
}

/**
 * The deepest effort tier this model accepts. 'high' for models with no
 * max/xhigh support — configureEffortParams drops the param entirely when
 * modelSupportsEffort() is false, so 'high' is also the safe no-param answer.
 */
export function getMaxSupportedEffortLevel(model: string): EffortLevel {
  if (modelSupportsMaxEffort(model)) return 'max'
  if (modelSupportsXHighEffort(model)) return 'xhigh'
  return 'high'
}

// =============================================================================
// CONTEXT WINDOW · OUTPUT MAX — token-window truth per model
// -----------------------------------------------------------------------------
// The hand tables in this section are LAST-OBSERVED provider facts for the
// shipped model families, not eternal truths: providers move windows, caps
// and defaults between fetches of this file's history. Before trusting or
// extending a row, verify against the provider's current documentation (or
// the live catalogue where one exists — the GPT lane's is wired below).
// =============================================================================

// The conservative context-window fallback: what an id gets when no
// catalogue, pin, capability, beta, or experiment claims otherwise. Mercury
// policy (compact early on unknowns), not a provider fact.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Output-token fallbacks for ids outside every table below.
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

/**
 * The 1M kill-switch: an org-side environment veto over every 1M-context
 * path (compliance deployments pin it). External spelling — a boundary
 * contract, decoded only here.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_DISABLE_1M_CONTEXT)
}

/** The explicit [1m]-suffixed id form — the client-side 1M opt-in. */
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// Maintenance: adjust this pattern when a model outside the catalog ships 1M context.
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // A carrier-shaped id (qualified namespace or bare vendor slug — any
  // '/') has no Mercury-side 1M opt-in: the vendor's slug IS the identity,
  // and the canonical-fold substring below must never light the toggle on a
  // carrier row that contains a first-party family word (the live
  // OpenRouter 400 class — [1m] dressing composed into a vendor slug).
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    // Fable 5 / Mythos 5 default to 1M context.
    canonical.includes('fable-5')
  )
}

// ── the ONE typed context resolution ─────

export type ContextRequestedMode = 'default' | 'maximum'

/** How (or whether) a window above the served default would be activated.
 *  'none' — nothing above the default was requested. 'unavailable' — a
 *  higher window was requested but NO provider-verified activation path
 *  exists; the CX-09/CX-13 provider-contract capture must name one before
 *  any activation mechanism can be claimed (a stated maximum may be an
 *  entitlement ceiling, not a usable window). */
export type ContextActivation =
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

/** The one context resolution (CX-10): budgeting and the outgoing request
 *  both derive from `effectiveWindow` — getContextWindowForModel IS this
 *  object's effective figure, so every consumer rides the same resolution
 *  by construction. Static pins never silently override live provider truth
 *  (source ordering below); compact thresholds derive downstream at the
 *  compact owner from this same figure (CX-06). */
export interface ContextResolution {
  model: string
  /** The account source's live catalogue window, when fetched. */
  catalogueCurrent?: number
  /** The source's stated `max_context_window` ceiling — DISPLAY-grade fact,
   *  never a budget (a ceiling the server does not default to would overrun). */
  catalogueMaximum?: number
  /** The static pinned window for this id, when one exists. */
  staticDefault?: number
  requestedMode: ContextRequestedMode
  activation: ContextActivation
  /** The window budgeting AND the request derive from — the served truth. */
  effectiveWindow: number
  source:
    | 'suffix-1m'
    | 'live-current'
    | 'static-pin'
    | 'capability'
    | 'beta-header'
    | 'experiment'
    | 'fallback'
  /** The model's own output reserve (display-grade; the compact owner's
   *  summary reserve derives its own figure from the same capabilities). */
  outputReserve: number
  fallbackReason?: string
}

/** Engine-pin id normalization: lowercase, trimmed, [1m]-family annotations
 *  detached (they are Mercury dressing, never engine identity). */
function normalizeForEnginePins(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]/g, '')
}

export function resolveContextWindow(
  model: string,
  betas?: string[],
  requestedMode: ContextRequestedMode = 'default',
): ContextResolution {
  const finish = (
    r: Omit<ContextResolution, 'model' | 'requestedMode' | 'activation' | 'outputReserve'> & {
      activation?: ContextActivation
      fallbackReason?: string
    },
  ): ContextResolution => {
    let activation: ContextActivation = r.activation ?? { kind: 'none' }
    let fallbackReason = r.fallbackReason
    if (requestedMode === 'maximum' && activation.kind === 'none') {
      // CX-11: activation is never inferred from a stated maximum alone —
      // until the provider-contract capture names a verified mechanism, a
      // maximum request resolves honestly as unavailable and the effective
      // window stays the served default (the CX-04 shape: fall back + say why).
      activation = {
        kind: 'unavailable',
        reason:
          'no provider-verified activation path — the CX-09/CX-13 provider-contract capture must land first',
      }
      fallbackReason = fallbackReason ?? 'maximum requested; no verified activation path'
    }
    return {
      model,
      requestedMode,
      activation,
      outputReserve: getModelMaxOutputTokens(model).default,
      ...r,
      fallbackReason,
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection.
  // CX-14: NOT an activation path for GPT engine ids — the suffix carries no
  // provider-verified mechanism there, so a suffixed GPT id resolves as its
  // base id with the activation honestly unavailable (never a lying 1M budget).
  // The same law covers carrier-shaped ids (qualified namespaces and bare
  // vendor slugs alike): no vendor mechanism backs Mercury's suffix there,
  // so a legacy-persisted dressed id budgets as its base id instead of a
  // lying 1M window.
  if (has1mContext(model)) {
    if (isCarrierShapedId(model)) {
      const base = resolveContextWindow(model.replace(/\[1m\]/i, ''), betas, requestedMode)
      return {
        ...base,
        model,
        activation: {
          kind: 'unavailable',
          reason: '[1m] is not a provider-verified activation path on a carrier-shaped id',
        },
        fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
      }
    }
    const gptBase = model.replace(/\[1m\]/i, '')
    if (!parseGptModelId(gptBase)) {
      return finish({ effectiveWindow: 1_000_000, source: 'suffix-1m' })
    }
    const base = resolveContextWindow(gptBase, betas, requestedMode)
    return {
      ...base,
      model,
      activation: {
        kind: 'unavailable',
        reason: '[1m] is not a provider-verified activation path for GPT engine ids (CX-14)',
      },
      fallbackReason: 'unverified [1m] suffix ignored; resolved as the base id',
    }
  }

  // Carrier rows (OpenRouter · Gemini): the window is what the LIVE row
  // states — context_length / inputTokenLimit — resolved BEFORE any first-
  // party substring can join a Claude or GPT slug behind the carrier onto
  // a table that never served it (the class where every OpenRouter row
  // budgeted the Anthropic default, and a 32k row ran unbudgeted into a
  // provider 400 while a 1M row compacted at 200k). A row stating no
  // window, an unlisted slug, or an unfetched catalogue keeps the
  // conservative default — labelled, never invented.
  const carrierRoute = declaredRouteOf(model)
  if (carrierRoute === 'openrouter' || carrierRoute === 'gemini') {
    const stated =
      carrierRoute === 'openrouter'
        ? (
            require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
          ).openrouterContextWindowFor(normalizeForEnginePins(model))
        : (
            require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
          ).geminiContextWindowFor(normalizeForEnginePins(model))
    if (stated) {
      if (stated.window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: stated.source,
          staticDefault: stated.window,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({ effectiveWindow: stated.window, source: stated.source, staticDefault: stated.window })
    }
    return finish({
      effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      source: 'fallback',
      fallbackReason: `the ${carrierRoute === 'openrouter' ? 'OpenRouter' : 'Gemini'} catalogue states no context length for this model (or is not fetched yet) — conservative default`,
    })
  }

  // First-party natively-1M rows: the ratified static pins for the
  // current-generation ids (last-observed provider facts — the same
  // contract as the engine-lane pins below), capped only by the
  // kill-switch. A carrier-shaped id (a qualified namespace or a bare
  // vendor slug) never reaches this pin by substring — its window is its
  // own source's row ('openrouter/anthropic/claude-opus-5' budgets what
  // the OpenRouter catalogue states, 'local/opus-5-quant' what the server
  // states), the same guard modelSupports1M applies.
  const firstPartyCanonical = getCanonicalName(model)
  if (
    !isCarrierShapedId(model) &&
    (firstPartyCanonical.includes('sonnet-5') ||
      firstPartyCanonical.includes('opus-5') ||
      // Claude Fable 5.1: 1M is the default AND the maximum on the bare id
      // (the context-windows page, fetched 2026-09-01: no beta header on
      // any 1M model) — no [1m] rider, no context-1m header. Fable 5's
      // rider path is unchanged (its own canonical never reaches here).
      firstPartyCanonical === 'claude-fable-5-1')
  ) {
    if (is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: 1_000_000,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: 1_000_000,
      source: 'static-pin',
      staticDefault: 1_000_000,
    })
  }

  // GPT engine ids: SOURCE truth first — the active account
  // source's live catalogue window when fetched; else the last-observed
  // pinned window (gptPins.ts, each pin dated). Windows are source-specific
  // and move with the provider: the same id has served a smaller default on
  // a subscription than its model page stated (observed —
  // an illustration, not a law). The live row is the derivation; never
  // restate a remembered number.
  //
    // item C): when the account source states a `max_context_window` ABOVE its
  // served default, that ceiling IS the account's usable window — the old
  // conservative default-only budget (compact-early) clamped a declared
  // larger plan (an 872k declaration, observed) down to the
  // served default. The ceiling is the source's own declaration for THIS
  // account, never a pin (a flat row keeps the served default exactly as
  // before).
  //
  // Provider parity: the window is a CHOICE
  // between the two windows the account genuinely offers. The `[served]`
  // annotation on the persisted id — the same id-borne persistence the
  // Anthropic 1M toggle uses — opts the session DOWN onto the served default;
  // a bare id keeps the item C ceiling. The choice is honored HERE, at the
  // one resolver every consumer reads (budget, warnings, /context, picker
  // column), never as a picker-label special case.
  //
  // The 1M kill-switch caps >200K either way. An unpinned unknown gpt id
  // falls through to the conservative default below (the zai precedent).
  const gptServedChoice = hasGptServedWindowSuffix(model)
  const gptLive = liveGptContextWindow(model)
  const gptPin = gptDisplayPin(model)
  if (gptLive && gptLive >= 16_000) {
    const gptCeiling = liveGptContextCeiling(model)
    const gptWindow =
      !gptServedChoice && gptCeiling !== undefined && gptCeiling > gptLive ? gptCeiling : gptLive
    const shared = {
      catalogueCurrent: gptLive,
      catalogueMaximum: gptCeiling,
      ...(gptPin?.contextWindow !== undefined ? { staticDefault: gptPin.contextWindow } : {}),
    }
    if (gptWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'live-current',
        ...shared,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({ effectiveWindow: gptWindow, source: 'live-current', ...shared })
  }
  if (gptPin?.contextWindow !== undefined) {
    if (gptPin.contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: gptPin.contextWindow,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: gptPin.contextWindow,
      source: 'static-pin',
      staticDefault: gptPin.contextWindow,
    })
  }

  // Hugging Face ids: the LIVE router catalogue's stated width first (the
  // named provider's, else the widest live provider's), then the dated pin
  // — a 1M-context model budgets at 1M, never at the conservative default;
  // an unlisted, unpinned slug falls through. Kill-switch clamped.
  if (isHuggingfaceModelId(model)) {
    const { huggingfaceContextWindowFor } =
      require('../../services/providers/huggingface/huggingfaceCatalogue.js') as typeof import('../../services/providers/huggingface/huggingfaceCatalogue.js')
    const stated = huggingfaceContextWindowFor(normalizeForEnginePins(model))
    if (stated) {
      if (stated.window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: stated.source,
          staticDefault: stated.window,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({ effectiveWindow: stated.window, source: stated.source, staticDefault: stated.window })
    }
  }

  // Local ids: the server's stated window (served instance > Modelfile >
  // Ollama's documented default > the model's trained max) — a server that
  // states nothing falls through to the conservative default, labelled.
  if (model.trim().toLowerCase().startsWith('local/')) {
    const { localRecordFor, localContextSourceWords } =
      require('../../services/providers/local/localCatalogue.js') as typeof import('../../services/providers/local/localCatalogue.js')
    const record = localRecordFor(normalizeForEnginePins(model))
    if (record?.contextWindow) {
      const window = record.contextWindow.tokens
      const note = `local server context: ${localContextSourceWords(record.contextWindow.source)}`
      if (window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
        return finish({
          effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
          source: 'live-current',
          staticDefault: window,
          fallbackReason: 'clamped by the 1M kill-switch',
        })
      }
      return finish({
        effectiveWindow: window,
        source: 'live-current',
        staticDefault: window,
        ...(record.contextWindow.source === 'served' ? {} : { fallbackReason: note }),
      })
    }
    return finish({
      effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      source: 'fallback',
      fallbackReason: record
        ? 'the local server states no context length for this model — conservative default'
        : 'local model not discovered yet — conservative default until a probe answers',
    })
  }

  // Engine-lane pinned windows: the dated
  // last-observed pins for glm/kimi/deepseek ids — the same static-pin rung
  // the GPT lane rides, kill-switch clamped. This also closes the recorded
  // The gap where glm ids always budgeted the conservative unknown-
  // model default (compact-early on a documented-1M model). A pin-less
  // engine id (the compat slot, unpinned family members) still falls through
  // to the conservative default below — absent beats invented.
  const enginePinnedWindow = (() => {
    const id = normalizeForEnginePins(model)
    if (isGlmModelId(id)) {
      const { GLM_STATIC_CATALOGUE } =
        require('../router/providers/zai.js') as typeof import('../router/providers/zai.js')
      return GLM_STATIC_CATALOGUE.find(e => e.id === id)?.contextWindow
    }
    if (isKimiModelId(id)) return kimiDisplayPin(id)?.contextWindow
    if (isDeepseekModelId(id)) return deepseekDisplayPin(id)?.contextWindow
    return undefined
  })()
  if (enginePinnedWindow !== undefined) {
    if (enginePinnedWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'static-pin',
        staticDefault: enginePinnedWindow,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: enginePinnedWindow,
      source: 'static-pin',
      staticDefault: enginePinnedWindow,
    })
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return finish({
        effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'capability',
        staticDefault: cap.max_input_tokens,
        fallbackReason: 'clamped by the 1M kill-switch',
      })
    }
    return finish({
      effectiveWindow: cap.max_input_tokens,
      source: 'capability',
      staticDefault: cap.max_input_tokens,
    })
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return finish({ effectiveWindow: 1_000_000, source: 'beta-header' })
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return finish({ effectiveWindow: 1_000_000, source: 'experiment' })
  }

  return finish({
    effectiveWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
    source: 'fallback',
    fallbackReason: 'no catalogue, pin, capability, beta, or experiment matched',
  })
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // CX-10: the number every budget/request consumer reads IS the resolution's
  // effective window — one object, one truth.
  return resolveContextWindow(model, betas).effectiveWindow
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // The experiment covers exactly Sonnet 4.6 WITHOUT an explicit [1m]
  // suffix — a suffixed id already opted in on its own.
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * The output-token pair for a model: the default the harness requests and
 * the upper limit the operator may raise it to.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  // GPT pins (provider parity): a pinned official output max
  // resolves through THIS consumer exactly like an Anthropic catalog entry —
  // display/budget truth only (the Responses wire deliberately sends no
  // max_output_tokens). A pin without a recorded output fact falls through
  // to the conservative default below, never an invented number.
  const gptPinOut = gptDisplayPin(model)?.outputMax
  if (gptPinOut !== undefined && gptPinOut >= 4_096) {
    return { default: Math.min(64_000, gptPinOut), upperLimit: gptPinOut }
  }

  // Carrier rows: the LIVE row's stated ceiling (OpenRouter's top_provider
  // .max_completion_tokens · Gemini's outputTokenLimit) — the compaction
  // request and the budget read it. A row stating none keeps the
  // conservative default; a carrier-shaped id never joins the first-party
  // output table below by substring.
  const outputRoute = declaredRouteOf(model)
  if (outputRoute === 'openrouter' || outputRoute === 'gemini') {
    const statedOut =
      outputRoute === 'openrouter'
        ? (
            require('../../services/providers/openrouter/openrouterCatalogue.js') as typeof import('../../services/providers/openrouter/openrouterCatalogue.js')
          ).openrouterMaxCompletionTokensFor(normalizeForEnginePins(model))
        : (
            require('../../services/providers/gemini/geminiCatalogue.js') as typeof import('../../services/providers/gemini/geminiCatalogue.js')
          ).geminiOutputTokenLimitFor(normalizeForEnginePins(model))
    if (statedOut !== undefined && statedOut >= 1_024) {
      return { default: Math.min(MAX_OUTPUT_TOKENS_DEFAULT, statedOut), upperLimit: statedOut }
    }
  }

  const m = isCarrierShapedId(model) ? '' : getCanonicalName(model)

  if (m.includes('fable-5')) {
    // Fable 5 / Mythos 5: 128K max output.
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-5') || m.includes('opus-5')) {
    // Sonnet 5 / Opus 5: 128K max output.
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * The manual thinking-budget ceiling: strictly below the output ceiling (a
 * budget equal to max output is an API reject). Legacy-model territory —
 * adaptive-thinking models take no budget_tokens at all.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}

// =============================================================================
// TOOL SEARCH — beta header
// =============================================================================

/** The tool search beta header (advanced-tool-use-2025-11-20). */
export function getToolSearchBetaHeader(): string {
  return TOOL_SEARCH_BETA_HEADER_1P
}

// =============================================================================
// BETA EMISSION — the exact header sets per model×env
// =============================================================================

/**
 * The SDK beta allowlist: the only betas an API-key SDK caller may inject
 * through options. Everything else is refused with a named warning.
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/** Split a beta list into the allowed and the refused. */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * The SDK-beta gate: subscribers get none (custom betas are an API-key
 * affordance), refused entries warn BY NAME, and undefined means nothing
 * survived — every drop is spoken, never silent.
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isClaudeAISubscriber()) {
    // biome-ignore lint/suspicious/noConsole: the refusal must reach the caller's console
    console.warn(
      'Warning: Custom betas are only available for API key users. Ignoring provided betas.',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: the named-drop warning must reach the caller's console
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

/**
 * Whether experimental betas may be emitted. CONSTANT FALSE in this build —
 * the isEnvTruthy('1') literal is the baked experimental-betas fold (the
 * production API contract; see BUILD-NOTES). The fold is load-bearing and prover-pinned:
 * un-baking it is a deliberate build-policy change, never a cleanup.
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return !isEnvTruthy('1')
}

/** Global-scope prompt caching — the same baked fold (constant false). */
export function shouldUseGlobalCacheScope(): boolean {
  return !isEnvTruthy('1')
}

// NUL separator for memo keys — no model id or env value contains U+0000.
const KEY_SEP = String.fromCharCode(0)

/**
 * The env inputs the beta emission reads, folded into the memo keys so an
 * env flip resolves FRESH. Pre-T16 the key was the model id alone — the
 * contract prover characterized the stale-list quirk (an env flip served
 * the previous headers until clearBetasCaches); the T16 resolve-once
 * doctrine keys the memo on everything the resolution reads.
 * Auth/subscriber flips (the OAUTH header input) still route through
 * clearBetasCaches() — auth.ts and /logout already call it on those flips.
 */
function betasEnvFingerprint(): string {
  return [
    process.env.DISABLE_INTERLEAVED_THINKING ?? '',
    process.env.MERCURY_DISABLE_1M_CONTEXT ?? '',
    process.env.ANTHROPIC_BETAS ?? '',
  ].join(KEY_SEP)
}

const betasMemoKey = (model: string): string =>
  model + KEY_SEP + betasEnvFingerprint()

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  // The agentic header rides every non-Haiku model; Haiku earns it only on
  // agentic queries (getMergedBetas tops it up there) — its non-agentic
  // calls (compaction, classifiers, token estimation) go without.
  if (!isHaiku) {
    betaHeaders.push(CODING_20250219_BETA_HEADER)

  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Interactive sessions skip the API-side thinking summarizer: the summary
  // only ever feeds the ctrl+o transcript view, the API sends
  // redacted_thinking blocks instead, and the renderer already stubs those.
  // Headless/SDK keeps summaries (callers iterate thinking content), and
  // settings.json showThinkingSummaries opts interactive back in.
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // Connector-text summarization — DORMANT (the && false fold below): a
  // server-side beta where the API buffers assistant text between tool
  // calls and returns a restorable summary (the thinking-block mechanism).
  // The backend gates it on its own side regardless; the tri-state env
  // (USE_CONNECTOR_TEXT_SUMMARIZATION: 1 forces on, 0 forces off, unset
  // defers to the feature gate) only matters if the fold is ever lifted.
  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    false &&
    includeFirstPartyOnlyBetas &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('mercury_connector_text_summarization', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  // Context-management beta: thinking preservation carries it; the API-side
  // tool-clearing arm is folded off (the && false) — Mercury does its own
  // context management.
  const antOptedIntoToolClearing =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) &&
    false

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (antOptedIntoToolClearing || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }

  // Augur header variant — rides only when the augur_header gate is active
  // (MERCURY_AUGUR / model pin / client-data flag), only through the
  // experimental-betas channel.
  //
  // EMPIRICAL NOTE (recorded request/response capture against the
  // real firstParty API): AUGUR_BETA_HEADER ('pewter-owl-2026-04-01') is not a
  // beta value the live API recognizes. Emitting it on the wire (even in
  // isolation, with global cache scope OFF and no other experimental betas)
  // returns a hard 400:
  //   "Unexpected value(s) `pewter-owl-2026-04-01` for the `anthropic-beta` header."
  // So this variant CANNOT be wire-live until the accepted header string is
  // known. The includeFirstPartyOnlyBetas gate (the baked experimental-betas
  // fold) keeps it suppressed by default,
  // which is correct — leave it gated. The gate+plumbing are sound; only the
  // literal is unconfirmed.
  if (includeFirstPartyOnlyBetas && isAugurHeader()) {
    betaHeaders.push(AUGUR_BETA_HEADER)
  }
  // Strict tool use rides its feature gate AND the experimental-betas
  // channel. The double gate is deliberate: the kill switch strips
  // schema.strict from tool BODIES at api.ts's choke point, but this HEADER
  // once escaped that switch — and proxies forwarding to non-first-party
  // backends 400 on it.
  const strictToolsEnabled =
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_tool_pear')
  // (Strict and token-efficient-tools are mutually exclusive on the API
  // side — strict wins by design. The pre-T16 body also computed a
  // `tokenEfficientToolsEnabled` value it never read — dead residue of a
  // DCE'd block, dropped in the T16 move; recorded in
  // a recorded contract report.)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Caching-scope header: harmless without a scope field in the body, so it
  // rides whenever the experimental-betas channel is open.
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // ANTHROPIC_BETAS is the operator's explicit escape hatch — comma-split
  // and honored verbatim, for any model.
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
}, betasMemoKey)

// Today a plain alias of getAllModelBetas, kept as its own memoized export
// deliberately: the pair is the stable seam between "everything the model
// emits" and "what rides as HEADERS" — the partition that once told them
// apart retired with the gateway estate, and any future split lands here
// without a consumer sweep.
export const getModelBetas = memoize((model: string): string[] => {
  return getAllModelBetas(model)
}, betasMemoKey)

/**
 * The final beta merge: the model's own emission plus the SDK-provided
 * betas from bootstrap state (already vetted by filterAllowedSdkBetas —
 * subscriber refusal and allowlist warnings happened there).
 *
 * isAgenticQuery guarantees the agentic header set. Non-Haiku models carry
 * it from getAllModelBetas() already; Haiku omits it there because its
 * NON-agentic calls (compaction, classifiers, token estimation) don't want
 * it — so an agentic Haiku query tops it up here.
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CODING_20250219_BETA_HEADER)) {
      baseBetas.push(CODING_20250219_BETA_HEADER)
    }

  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // Dedup on merge; the vetting already happened upstream.
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}

// =============================================================================
// REFUSAL FALLBACK — the opt-in server-side fallback (never a silent substitute)
// =============================================================================

/**
 * The models the refusals page names as running the safety classifiers
 * with a server-side fallback: Claude Fable 5.1, Claude Fable 5 and Claude
 * Opus 5 (fetched 2026-09-01). The permitted targets for Fable 5.1 are Opus
 * 4.8 and Opus 5; `fallbacks: 'default'` lets Anthropic pick per refusal
 * category, so Mercury maintains no target list.
 */
export function modelSupportsServerSideFallback(model: string): boolean {
  if (isCarrierShapedId(model)) return false
  const canonical = getCanonicalName(model)
  return (
    canonical === 'claude-fable-5-1' ||
    canonical === 'claude-fable-5' ||
    canonical === 'claude-opus-5'
  )
}

/** MERCURY_REFUSAL_FALLBACK=1 — the opt-in gate, read LIVE on every call
 *  through the registry's gate reader (authority-toggle honesty); unset or
 *  any other value ⇒ byte-identical requests. */
export function refusalFallbackEnabled(): boolean {
  return flagEnabled('MERCURY_REFUSAL_FALLBACK')
}

/**
 * The ONE owner of the request additions the opt-in arms: the beta header
 * and `fallbacks: 'default'`, only on a model that takes them. null ⇒ the
 * request is byte-identical to the flag-off wire. The stream stamps the
 * SERVING model on every minted assistant message and names it on the
 * byline (streamCore noteServedModel) — a substitute is never silent.
 */
export function refusalFallbackRequest(
  model: string,
): { beta: string; fallbacks: 'default' } | null {
  if (!refusalFallbackEnabled()) return null
  if (!modelSupportsServerSideFallback(model)) return null
  return { beta: SERVER_SIDE_FALLBACK_BETA_HEADER, fallbacks: 'default' }
}

// =============================================================================
// MODEL IDENTITY — knowledge cutoff (moved from constants/prompts.ts, T16)
// =============================================================================

// Maintenance: every model needs its knowledge-cutoff date recorded here.
export function getModelKnowledgeCutoff(modelId: string): string | null {
  // Carrier-shaped ids (a qualified namespace or a bare vendor slug) carry
  // the VENDOR's identity: no first-party cutoff below may answer for them
  // — an absent env-block line beats a borrowed one.
  if (isCarrierShapedId(modelId)) return null
  // Opus 5: live-verified May 2026. Sonnet 5 deliberately has NO arm (no
  // verified cutoff — an absent env-block line beats a fabricated one).
  if (modelId.includes('claude-opus-5')) {
    return 'May 2026'
  }
  // Fork models match on the RAW id, ahead of the canonical fold —
  // firstPartyNameToCanonical (model.ts) folds claude-opus-4-8 into
  // claude-opus-4-6, which would mis-answer 'May 2025'.
  if (modelId.includes('claude-opus-4-8')) {
    return 'January 2026'
  }
  // Claude Fable 5.1 / Mythos 5.1: the models overview states Jun 2026 as
  // the reliable knowledge cutoff (fetched 2026-09-01). Checked BEFORE the
  // fable-5 substring arm below, which would otherwise swallow the id.
  if (modelId.includes('claude-fable-5-1') || modelId.includes('claude-mythos-5-1')) {
    return 'June 2026'
  }
  // Fable 5 / Mythos 5 share the cutoff the live harness env block states
  // for claude-fable-5. Sonnet 5 has NO arm on purpose (no verified cutoff
  // — an absent line beats a fabricated one).
  if (modelId.includes('claude-fable-5') || modelId.includes('claude-mythos-5')) {
    return 'January 2026'
  }
  const canonical = getCanonicalName(modelId)
  if (canonical.includes('claude-sonnet-4-6')) {
    return 'August 2025'
  } else if (canonical.includes('claude-opus-4-6')) {
    return 'May 2025'
  } else if (canonical.includes('claude-opus-4-5')) {
    return 'May 2025'
  } else if (canonical.includes('claude-haiku-4')) {
    return 'February 2025'
  } else if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4')
  ) {
    return 'January 2025'
  }
  return null
}

// =============================================================================
// MEDIA — document/image delivery (moved from utils/pdfUtils.ts, T16;
// route-derived per the tool-compat pass)
// =============================================================================

/**
 * Whether PDF `document` content blocks REACH this model. Two facts compose:
 * the wire must carry document blocks at all — only the Anthropic lane's
 * codec does (the OpenAI Responses bridge and the shared chat-completions
 * codec both degrade non-text tool-result parts to placeholders) — and on
 * that lane only Haiku 3 predates the support (its callers ride the
 * page-extraction fallback instead). Route truth comes from the routing
 * law, never a brand-string sniff; the tool-equality prover pins this
 * record against the codecs' actual behaviour.
 */
export function modelSupportsPDF(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  return !model.toLowerCase().includes('claude-3-haiku')
}

/**
 * Whether `image` content blocks (tool results and pasted screenshots)
 * REACH this model: the Anthropic lane carries them natively; the OpenAI
 * Responses bridge maps them to `input_image` parts (per-model modality is
 * then the live catalogue's call — unsupported models degrade to a named
 * `[image]` placeholder at that edge); every chat-completions lane's codec
 * degrades them to the same named placeholder. Lane truth, not model
 * marketing: a multimodal model behind a text-only codec still reads false.
 */
export function modelReceivesImageBlocks(model: string): boolean {
  // A wire-SHAPE fact, not an identity fact: block support is the
  // TRANSPORT's. A stranger's only possible ride is the Anthropic-
  // compatible home transport (the earned gateway), whose codec carries
  // blocks — so 'unrecognised' answers true; absence answers false.
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'unrecognised') return true
  if (verdict.kind === 'absence') return false
  return verdict.route === 'anthropic' || verdict.route === 'openai'
}

// =============================================================================
// TOOL SUPPORT — availability gates (moved from their tools/consumers, T16)
// =============================================================================

/**
 * A session on a NON-first-party base URL sits behind a proxy whose
 * tool_reference support is unknown — the block form must not be assumed
 * there. This uncertainty selects the wire FORM (the
 * deferralWire owner's gateway evidence ladder: operator assertion, probe
 * verdict, else text) and never switches deferral off.
 */
export function toolSearchPassthroughUncertain(): boolean {
  return !isFirstPartyAnthropicBaseUrl()
}

// =============================================================================
// STREAMING FEATURES — fine-grained tool streaming (moved from utils/api.ts)
// =============================================================================

/**
 * Fine-grained tool streaming via the per-tool API field. Without FGTS, the
 * API buffers entire tool input parameters before sending input_json_delta
 * events, causing multi-minute hangs on large tool inputs (a P0 bench:
 * a ~45KB Write = 275s of dead wire, 2.0× wall vs the buffered path at equal
 * model+effort). Gated to direct api.anthropic.com — proxies (LiteLLM etc.)
 * reject the field with 400. The 2025-05-14 beta header is GA'd; the
 * per-tool field is the only current control.
 *
 * Mercury: no remote rollout flag arrives here — the gate is the registered
 * default-on MERCURY_FGTS row alone. (The external
 * CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING boundary decode this block
 * once described is retired: no read of that spelling exists anywhere in
 * src — recut here so the sentence stops
 * describing a dead decode.) Both beta carves ride the same precondition —
 * a first-party base URL (proxies 400 the beta shapes).
 */
export function fineGrainedToolStreamingEnabled(): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) {
    return false
  }
  return flagEnabled('MERCURY_FGTS')
}

/**
 * Tool deferral (ToolSearch + a name-only announcement) on EVERY route —
 * the registered MERCURY_TOOL_DEFER gate alone, no base-URL term.
 * The baked DISABLE_EXPERIMENTAL_BETAS fold forced getToolSearchMode() to
 * 'standard', inlining every deferrable tool schema into every request
 * (~111KB measured — the single largest prefix component; a P0 bench:
 * ~94K-token prefix vs ~22K with deferral); the first carve re-opened the
 * ladder on the first-party host only, which left nine of ten routed
 * families and every gateway inlining the whole catalogue (the
 * wire measurement: 73–74 schemas / ~198 KB per request against 18 / ~50 KB
 * first-party). Deferral is a Mercury-side context-assembly decision; the
 * WIRE FORM it rides in is the deferralWire owner's per-route capability —
 * the beta block form where the endpoint carries it (first-party by
 * contract, a gateway by probe evidence), the client-side text form
 * everywhere else. The api.ts strip choke point and the Anthropic lane's
 * header read toolReferenceWireAccepted there, so a text-form wire never
 * sees defer_loading or the advanced-tool-use header. MERCURY_TOOL_DEFER=0
 * kills it — byte-identical pre-carve requests on every route. The
 * MERCURY_TOOL_SEARCH value ladder decodes one rung below, in
 * getToolSearchMode() (false ⇒ standard, auto/auto:N ⇒ tst-auto).
 */
export function toolDeferralEnabled(): boolean {
  return flagEnabled('MERCURY_TOOL_DEFER')
}

// =============================================================================
// ADVISOR — model support tables (moved from utils/advisor.ts, T16)
// =============================================================================

// Maintenance: models able to CALL the advisor tool are listed here.
// The main-loop side of the advisor pairing.
export function modelSupportsAdvisor(model: string): boolean {
  // The advisor pairing is an Anthropic-wire feature; a carrier or compat
  // spelling of a 4.6 slug rides a codec that never carries it.
  if (declaredRouteOf(model) !== 'anthropic') return false
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    false
  )
}

// Maintenance: models able to SERVE as the advisor are listed here.
export function isValidAdvisorModel(model: string): boolean {
  if (declaredRouteOf(model) !== 'anthropic') return false
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    false
  )
}

// =============================================================================
// THE CAPABILITY RECORD — the resolve-once neutral view
// =============================================================================

/**
 * The capability record: every model/env-derived decision the harness
 * consumes, resolved ONCE per (model, env) through the same pinned
 * functions above and frozen. Consumers that want a coherent snapshot
 * (tool availability gates, projections, spawn-captured profiles) read
 * THIS instead of making transport checks; consumers on a hot single
 * predicate may call the function directly — both live in this one edge
 * module.
 *
 * Deliberately NOT memoized: the constituents carry their own env-keyed
 * memos where hot (beta emission), and the non-env inputs (subscriber/auth
 * state, feature-gate snapshots, clientDataCache) must keep their
 * live/clear-on-flip semantics — a record-level cache would re-create the
 * staleness class this cut removed.
 */
export type ModelCapabilityRecord = Readonly<{
  /** The id the record was resolved for (raw, as passed). */
  model: string
  /** The canonical family name (the opus-4-8→opus-4-6 fold rides here). */
  canonical: string
  identity: Readonly<{
    isHaiku: boolean
    knowledgeCutoff: string | null
  }>
  context: Readonly<{
    window: number
    supports1m: boolean
    outputDefault: number
    outputMax: number
    maxThinkingTokens: number
  }>
  thinking: Readonly<{
    supported: boolean
    adaptive: boolean
    interleaved: boolean
  }>
  sampling: Readonly<{ temperature: boolean }>
  effort: Readonly<{
    supported: boolean
    max: boolean
    xhigh: boolean
    ceiling: EffortLevel
  }>
  tools: Readonly<{
    structuredOutputs: boolean
    contextManagement: boolean
    autoMode: boolean
    toolSearchBetaHeader: string
    advisor: boolean
  }>
  media: Readonly<{ pdf: boolean; images: boolean }>
  betas: Readonly<{
    all: readonly string[]
    headers: readonly string[]
  }>
}>

export function resolveModelCapabilities(model: string): ModelCapabilityRecord {
  const canonical = getCanonicalName(model)
  const outputTokens = getModelMaxOutputTokens(model)
  return Object.freeze({
    model,
    canonical,
    identity: Object.freeze({
      isHaiku: canonical.includes('haiku'),
      knowledgeCutoff: getModelKnowledgeCutoff(model),
    }),
    context: Object.freeze({
      window: getContextWindowForModel(model),
      supports1m: modelSupports1M(model),
      outputDefault: outputTokens.default,
      outputMax: outputTokens.upperLimit,
      maxThinkingTokens: getMaxThinkingTokensForModel(model),
    }),
    thinking: Object.freeze({
      supported: modelSupportsThinking(model),
      adaptive: modelSupportsAdaptiveThinking(model),
      interleaved: modelSupportsISP(model),
    }),
    sampling: Object.freeze({ temperature: modelSupportsTemperature(model) }),
    effort: Object.freeze({
      supported: modelSupportsEffort(model),
      max: modelSupportsMaxEffort(model),
      xhigh: modelSupportsXHighEffort(model),
      ceiling: getMaxSupportedEffortLevel(model),
    }),
    tools: Object.freeze({
      structuredOutputs: modelSupportsStructuredOutputs(model),
      contextManagement: modelSupportsContextManagement(model),
      autoMode: modelSupportsAutoMode(model),
      toolSearchBetaHeader: getToolSearchBetaHeader(),
      advisor: modelSupportsAdvisor(model),
    }),
    media: Object.freeze({
      pdf: modelSupportsPDF(model),
      images: modelReceivesImageBlocks(model),
    }),
    betas: Object.freeze({
      all: Object.freeze([...getAllModelBetas(model)]),
      headers: Object.freeze([...getModelBetas(model)]),
    }),
  })
}

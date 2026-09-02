// ============================================================================
//  workerModels.ts — the WORKER-role projection of the ONE canonical
//  callable-model owner (the law: New Session must
//  consume the same provider-neutral projection the Coordinator does —
//  never a separate hand table).
//
//  The projection is composeCoordinatorModelRegistry's source
//  verbatim — every REAL /model row this account offers, canonical ids —
//  carrying ONE availability per dispatch arm (display ≡ dispatch per arm):
//
//    · the SESSION arm — a session's runner is the whole product, so the
//      dispatchable set for a session is PURE PRODUCT CAPABILITY: every
//      family the account holds a credential for dispatches, the economy
//      tier included — the picker's per-row catalogue state stays a
//      display fact (a transiently-unfetched catalogue never blocks an
//      admission; the engine speaks the provider's own truth per call).
//      A family with NO credential refuses typed ('no-credential:<family>')
//      with the one action that fixes it riding the refusal;
//    · the CREW arm — the same capability minus the economy tier: every
//      credentialed family's frontier rows run crew seats (a crew teammate
//      is the same product child a session runs — no family is favoured);
//      economy-tier rows are REFUSED typed ('worker-policy:frontier-only'
//      — the standing never-Haiku law for autonomous crew, spoken as a
//      visible refusal).
//
//  THE NEUTRAL SEAT (the operator's law — no family is favoured): a seat
//  nobody named a model for lands on the operator's own default, else on
//  the NEUTRAL default — the most recent sign-in's provider, its newest
//  usable row (computedDefault, the one owner of that decision) — never on
//  a family the account does not hold; a family WORD ('openai',
//  'anthropic', …) names that family's newest signed-in row; and a
//  credential refusal names the family that IS signed in as the way out,
//  never only the one refused. The coordinator's launches, the crew spawn
//  and the workflow executor all resolve through here.
//
//  REFUSALS ARE TYPED AND CARRY THEIR ACTION: every refusal names its true
//  class ('no-credential:<family>' · 'unknown-model' · the reserved
//  'withdrawn-at-provider' / 'not-runnable:<why>' for signals the wire
//  speaks today) plus ONE machine-readable action line — a coordinator or
//  operator reading the error relays the real fix ("/logins <family>",
//  "did you mean <id>?") and never invents a reason.
//
//  The dispatch admissions validate against THIS registry, each naming its
//  arm (one composition, two projections). An id in an ENGINE family's own
//  namespace that the picker has not listed yet still dispatches when the
//  family is credentialed — capability, not catalogue; the wire adjudicates
//  the exact id. Legacy crew keys fold to canonical ids at the boundary.
// ============================================================================

import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { NO_SIGN_IN_ROW, type LaneRowVerdict } from '../../utils/model/computedDefault.js'
import { canonicalCoordinatorModelId } from './coordinatorModels.js'

export type WorkerModelRefusal =
  | 'worker-policy:frontier-only'
  | `no-credential:${string}`
  /** The account-less family's miss (local): the backing server is gone —
   *  a credential class would borrow a family this one never had. */
  | `unreachable:${string}`
  | 'withdrawn-at-provider'
  | `not-runnable:${string}`

/** The two dispatch kinds the registry projects: a SESSION (the operator's
 *  own durable chat — its runner is the whole product) and a CREW seat (the
 *  bounded autonomous crew). Every validation and every display names its
 *  arm — display ≡ dispatch per arm. */
export type WorkerDispatchArm = 'session' | 'crew'

/** One arm's verdict on one row: available, or refused with the typed
 *  reason, the plain-words detail, and the ONE action that fixes it. */
export type WorkerArmAvailabilityV1 =
  | { availability: 'available' }
  | { availability: 'refused'; refusal: WorkerModelRefusal; detail?: string; action?: string }

export interface WorkerModelEntryV1 {
  /** The canonical model id (aliases resolved, [1m] folded). */
  modelId: string
  displayName: string
  /** The SESSION arm — what the product itself runs with this account. */
  session: WorkerArmAvailabilityV1
  /** The CREW arm — the bounded crew's narrower vocabulary today. */
  crew: WorkerArmAvailabilityV1
  /** The ratified daemon-worker effort convention (rows the session arm
   *  dispatches; the dispatch default is 'high' either way). */
  effort?: 'high'
  /** THE OPERATOR'S OWN DEFAULT — the model their /model setting resolves
   *  to. The unset-seed default is THIS row when it is dispatchable, so a
   *  launch nobody named a model for lands where the operator already
   *  chose, never on a pricier or tighter-pool family. */
  isOperatorDefault?: true
  /** THE NEUTRAL DEFAULT — the most recent sign-in's provider, its newest
   *  usable row (computedDefault). The seed falls to THIS row when the
   *  operator's own pick is refused (a /model pin on a family that lost
   *  its credential), never to the catalogue's first listed row of some
   *  family the operator never chose. */
  isNeutralDefault?: true
}

export interface WorkerModelRegistryV1 {
  schema: 1
  entries: WorkerModelEntryV1[]
}

/** The three legacy crew keys (durable records only ever held these). They
 *  fold through the LIVE alias resolver — the future-model catalog owns
 *  their canonical targets; a hand table here can drift from it (the
 *  F-review catch: kill-switch/3P environments resolve differently). */
const WORKER_MODEL_LEGACY_KEY_NAMES = new Set(['opus', 'sonnet', 'fable', 'fable51'])

const FRONTIER_FAMILY = /^claude-(opus|sonnet|fable)-/
const ECONOMY_FAMILY = /^claude-haiku|^claude-\d+-haiku|haiku/i

/** The family words /logins pre-focuses (login.tsx's parseFamilyFocus —
 *  the route ids it accepts verbatim); the two families with no sign-in
 *  leg name their connect home instead (providerUsage's own why-not
 *  spellings). The refusal's action line never names a command or a word
 *  the product does not have. */
const LOGINS_FAMILY_WORDS = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'])
export function loginsActionFor(family: string): string {
  if (LOGINS_FAMILY_WORDS.has(family)) return `ask the operator to run /logins ${family}`
  if (family === 'openai-compat') return 'ask the operator to set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY, or /router key compat)'
  if (family === 'local') return 'ask the operator to start a local server, or set MERCURY_LOCAL_BASE_URL'
  return 'ask the operator to run /logins'
}

/** The family words a seat may name instead of a model id: every family
 *  the presence owner enumerates (the ids /logins pre-focuses, plus the
 *  two connect-only families). A word resolves to that family's newest
 *  usable row for THIS account; a family with no usable sign-in keeps its
 *  own credential refusal, naming its door and the way out. */
const SEAT_FAMILY_WORDS = new Set([...LOGINS_FAMILY_WORDS, 'openai-compat', 'local'])
export function isSeatFamilyWord(word: string): boolean {
  return SEAT_FAMILY_WORDS.has(word)
}

/** One signed-in family's seat choice: its newest usable row. */
export interface SeatFamilyChoiceV1 {
  family: string
  /** The model-setting string the row resolves to (what a seat runs). */
  setting: string
  /** The row's display words. */
  row: string
}

/** THE NEUTRAL SEAT DEFAULT — the most recent sign-in's provider, its
 *  newest usable row (computedDefault: the ONE owner of that decision);
 *  null with no usable sign-in anywhere. Sync (the deferred require — the
 *  model.ts idiom) so the workflow executor and the daemon's crew spawn
 *  ask it without a composition of their own. */
export function neutralSeatDefault(): SeatFamilyChoiceV1 | null {
  try {
    const { computedDefault } =
      require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
    const decision = computedDefault()
    if (decision.source === 'keyless' || decision.provider === null) return null
    return { family: decision.provider, setting: decision.setting, row: decision.row }
  } catch {
    return null
  }
}

/** Every signed-in family with a usable row, most recent sign-in first —
 *  the roster a crew spawn or a workflow offers: one choice per family,
 *  never a favoured table. */
export function seatFamilyChoices(): SeatFamilyChoiceV1[] {
  try {
    const { computedDefault } =
      require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
    const out: SeatFamilyChoiceV1[] = []
    for (const considered of computedDefault().considered) {
      if (!considered.verdict.usable) continue
      const verdict = considered.verdict as Extract<LaneRowVerdict, { usable: true }>
      out.push({ family: considered.family, setting: verdict.setting, row: verdict.row })
    }
    return out
  } catch {
    return []
  }
}

/** A family word's seat: its newest usable row, or undefined when the
 *  family holds no usable sign-in. */
export function familySeatSetting(family: string): string | undefined {
  return seatFamilyChoices().find(c => c.family === family)?.setting
}

/** The credential refusal's action: the refused family's own door AND the
 *  way out through a family that IS signed in — never only the one refused
 *  (a refusal that names only /logins anthropic on an account signed in
 *  elsewhere sends the operator to a family they never chose). */
export function noCredentialAction(family: string): string {
  const door = loginsActionFor(family)
  const other = seatFamilyChoices().find(c => c.family !== family)
  if (other === undefined) return door
  let name = other.family
  try {
    const { providerDisplayName } = require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    name = providerDisplayName(other.family)
  } catch {
    /* the family id stands */
  }
  return `${door} — or ${name} is signed in: leave the model out for its newest row (${other.row}), or name '${other.family}' to pick that family`
}

/**
 * The drift an UNNAMED launch can hit: the operator's recorded default
 * provider (config.defaultProvider — the first login, or /defaultprovider)
 * holds no credential any more, so the built-in default fell back to the
 * frontier lane (the rung's honest fallback) — and that lane may hold none
 * either. A refusal that then says only "run /logins anthropic" sends the
 * operator to a family they never chose. The note names the family they
 * DID choose and its own fix; pure over the presences so a prover feeds
 * fixtures. Empty when the refusal is not a credential refusal, when no
 * default provider is recorded, or when the recorded one still holds its
 * credential (then the launch never fell through it).
 */
export function defaultProviderDriftNote(
  refusal: WorkerModelRefusal,
  configuredProvider: string | undefined,
  credentialed: (family: string) => boolean,
): { detail: string; action: string } | undefined {
  if (!refusal.startsWith('no-credential:')) return undefined
  const fellTo = refusal.slice('no-credential:'.length)
  if (configuredProvider === undefined || configuredProvider === fellTo) return undefined
  if (credentialed(configuredProvider)) return undefined
  const { providerDisplayName } = require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
  return {
    detail: `the operator's default provider is ${providerDisplayName(configuredProvider)}, which holds no credential on this account any more, so the unnamed launch fell to the ${fellTo} family — which holds none either`,
    action: `${loginsActionFor(configuredProvider)} (their default provider), or /defaultprovider picks another`,
  }
}

/**
 * THE OPERATOR'S RULED SENTENCE (sighted on their Windows box:
 * a signed-out scratch home's New Session refused with "…or to run /logins
 * anthropic — the anthropic family holds no credential on this account").
 * A fresh box — no default provider recorded, no credential in ANY family —
 * is the COMMON case, not the drift case: the built-in default falls to
 * the frontier lane by remainder and the refusal then named that one
 * family's /logins word as if the operator had chosen it. The refusal for
 * that home assumes no family and no knowledge of which door is which: it
 * names BOTH account doors and no vendor.
 */
export const NO_ACCOUNT_REFUSAL = 'no-credential:any' satisfies WorkerModelRefusal
export const NO_ACCOUNT_DETAIL = 'no provider is signed in on this account'
export const NO_ACCOUNT_ACTION = '/logins to choose an account, or /router key <provider> to connect an API key'

/** Pure over the facts: the refusal an UNNAMED launch gets on a home with
 *  no recorded default provider and no credential in any family. A recorded
 *  default is the drift note's case below (it names the family the operator
 *  chose); a NAMED model keeps its own family's refusal; any credentialed
 *  family means the launch lands there instead (defaultWorkerModelId's
 *  first-available rung), so this never fires beside a working lane. */
export function noAccountRefusal(
  refusal: WorkerModelRefusal,
  configuredProvider: string | undefined,
  anyCredentialed: boolean,
): { reason: typeof NO_ACCOUNT_REFUSAL; detail: string; action: string } | undefined {
  if (!refusal.startsWith('no-credential:')) return undefined
  if (configuredProvider !== undefined) return undefined
  if (anyCredentialed) return undefined
  return { reason: NO_ACCOUNT_REFUSAL, detail: NO_ACCOUNT_DETAIL, action: NO_ACCOUNT_ACTION }
}

/** The per-family credential facts, read ONCE per composition from the one
 *  presence owner (providerUsage — existence, never validity). */
type CredentialReads = ReadonlyMap<string, boolean>
async function readCredentialPresences(): Promise<CredentialReads> {
  const { providerFamilyPresences } = await import('../providers/providerUsage.js')
  const map = new Map<string, boolean>()
  for (const presence of providerFamilyPresences()) {
    map.set(presence.id, presence.credentialed)
  }
  return map
}

/** The unrecognised refusal's action line: a few lawful spellings DERIVED
 *  from the catalogue fold (AGENTDIALS C2 — never a hardcoded family
 *  list; the same derivation the normalizer resolves through, so the
 *  refusal teaches exactly what would have worked). Deferred require —
 *  this is a sync seam inside async composers (the model.ts idiom). */
function unrecognisedRefusalAction(): string {
  const plain = 'pick a listed row from the model picker'
  try {
    const { catalogueSpellingExamples } =
      require('../../utils/model/modelSpellingFold.js') as typeof import('../../utils/model/modelSpellingFold.js')
    const examples = catalogueSpellingExamples(3)
    if (examples.length > 0) {
      return `${plain} — spellings like ${examples.map(e => `'${e}'`).join(', ')} resolve, display names and ids both`
    }
  } catch {
    /* the plain line stands */
  }
  return plain
}

/** ONE classifier for both arms — the loop, the operator-default join and
 *  the namespace-capability admit all compose through it, so no two doors
 *  can disagree about a family. The SESSION arm follows the family's
 *  credential (pure capability); the CREW arm speaks its own vocabulary. */
function composeArms(
  modelId: string,
  credentials: CredentialReads,
  route: string,
): { session: WorkerArmAvailabilityV1; crew: WorkerArmAvailabilityV1 } {
  if (route === 'unrecognised') {
    // No family declares the id: no credential door exists to point at —
    // the refusal names the fact, never a '/logins unrecognised' lie.
    const refused: WorkerArmAvailabilityV1 = {
      availability: 'refused',
      refusal: 'not-runnable:unrecognised',
      detail: `no provider family declares '${modelId}'`,
      action: unrecognisedRefusalAction(),
    }
    return { session: refused, crew: refused }
  }
  const credentialed = credentials.get(route) === true
  const session: WorkerArmAvailabilityV1 = credentialed
    ? { availability: 'available' }
    : route === 'local'
      ? {
          // The account-less family: presence is DISCOVERY — its miss is a
          // gone server, never a credential lack.
          availability: 'refused',
          refusal: 'unreachable:local',
          detail: 'no local server is discovered on this box',
          action: loginsActionFor(route),
        }
      : {
          availability: 'refused',
          refusal: `no-credential:${route}`,
          detail: `the ${route} family holds no credential on this account`,
          action: noCredentialAction(route),
        }
  if (ECONOMY_FAMILY.test(modelId)) {
    // The standing never-Haiku law holds for the AUTONOMOUS crew only — a
    // session runs whatever the account runs.
    return {
      session,
      crew: {
        availability: 'refused',
        refusal: 'worker-policy:frontier-only',
        detail: 'crew seats run the frontier rows',
        action: "pick a frontier row for the crew seat — a family word ('anthropic', 'openai', …) picks that family's newest signed-in row",
      },
    }
  }
  // Every other row — the first-party frontier AND the engine families
  // (GPT / Z.AI / OpenRouter / …) — runs a crew seat exactly as it runs a
  // session: a crew teammate is the same product child, so the family's
  // credential is the whole verdict and no family is favoured.
  return { session, crew: session }
}

export function foldLegacyWorkerModelKey(idOrKey: string): string {
  if (WORKER_MODEL_LEGACY_KEY_NAMES.has(idOrKey)) return parseUserSpecifiedModel(idOrKey)
  // A FAMILY WORD names that family's newest signed-in row (the neutral
  // seat law); a family with no usable sign-in keeps the word, and the
  // validator answers that family's own credential refusal.
  if (SEAT_FAMILY_WORDS.has(idOrKey)) return familySeatSetting(idOrKey) ?? idOrKey
  return idOrKey
}

export async function canonicalWorkerModelId(idOrKey: string): Promise<string> {
  return canonicalCoordinatorModelId(foldLegacyWorkerModelKey(idOrKey))
}

export async function composeWorkerModelRegistry(): Promise<WorkerModelRegistryV1> {
  const { getModelOptions } = await import('../../utils/model/modelOptions.js')
  const { declaredRouteOf } = await import('../providers/routeLaw.js')
  const credentials = await readCredentialPresences()
  const entries: WorkerModelEntryV1[] = []
  const seen = new Set<string>()
  // The operator's own default, canonicalized through the same resolver the
  // rows use — read ONCE here so the marking below and the seed default
  // cannot disagree about which row the operator chose. THE READ is the
  // operator's CHOSEN model — their /model setting (settings.model ·
  // ANTHROPIC_MODEL) resolved, else the built-in default: reading the
  // built-in default SETTING alone here marked the frontier row (or, with a
  // recorded lane, that lane's first catalogue row) as "the operator's
  // default" while their /model named another row on the same lane — an
  // unnamed launch never landed on the model they chose.
  let operatorDefaultId: string | undefined
  try {
    const { getMainLoopModel } = await import('../../utils/model/model.js')
    operatorDefaultId = await canonicalWorkerModelId(getMainLoopModel())
  } catch {
    /* an unreadable setting leaves the rows unmarked — the first available
       row is then the seed, visible on the chip like any other choice */
  }
  // THE NEUTRAL DEFAULT's row is marked the same way, read ONCE here: the
  // seed falls to it when the operator's own pick is refused, so an
  // unnamed launch lands on the most recent sign-in's newest usable row
  // and never on the first listed row of a family nobody chose.
  let neutralDefaultId: string | undefined
  const neutral = neutralSeatDefault()
  if (neutral !== null) {
    try {
      neutralDefaultId = await canonicalWorkerModelId(neutral.setting)
    } catch {
      /* unmarked — the first available row seeds, visibly */
    }
  }
  for (const o of getModelOptions()) {
    const v = typeof o.value === 'string' ? o.value : null
    // The same exclusions as the coordinator side: the Default row
    // (null) and mode sentinels (__…__) — through the owner's own sentinel
    // grammar (a bare ':' test also swallowed real vendor ids like
    // compat/llama3:8b).
    if (!v || v.startsWith('__')) continue
    const modelId = await canonicalWorkerModelId(v)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const displayName = typeof o.label === 'string' && o.label.length > 0 ? o.label : modelId
    const operatorMark = modelId === operatorDefaultId ? ({ isOperatorDefault: true } as const) : {}
    const neutralMark = modelId === neutralDefaultId ? ({ isNeutralDefault: true } as const) : {}
    const arms = composeArms(modelId, credentials, declaredRouteOf(modelId) ?? 'unrecognised')
    entries.push({
      modelId,
      displayName,
      ...arms,
      // The effort convention rides every row the session arm dispatches.
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      ...operatorMark,
      ...neutralMark,
    })
  }
  // The neutral default's row is a picker row by construction; should a
  // composition ever miss it, it joins as an explicit entry through the
  // same classifier (the operator-default seam below is the precedent).
  if (neutralDefaultId !== undefined && !seen.has(neutralDefaultId)) {
    const arms = composeArms(neutralDefaultId, credentials, declaredRouteOf(neutralDefaultId) ?? 'unrecognised')
    entries.unshift({
      modelId: neutralDefaultId,
      displayName: neutral?.row ?? neutralDefaultId,
      ...arms,
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      isNeutralDefault: true,
      ...(neutralDefaultId === operatorDefaultId ? ({ isOperatorDefault: true } as const) : {}),
    })
    seen.add(neutralDefaultId)
  }
  // Operator finding: on profiles where the operator's default exists ONLY
  // as the picker's null Default row, workers could never name it — the
  // row's RESOLVED model joins as an explicit entry (one seam: the
  // registry, never a picker fork), its arms composed by the SAME
  // classifier as every listed row.
  if (operatorDefaultId !== undefined && !seen.has(operatorDefaultId)) {
    const arms = composeArms(operatorDefaultId, credentials, declaredRouteOf(operatorDefaultId) ?? 'unrecognised')
    entries.unshift({
      modelId: operatorDefaultId,
      displayName: `${operatorDefaultId} · default`,
      ...arms,
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      isOperatorDefault: true,
    })
    seen.add(operatorDefaultId)
  }
  return { schema: 1, entries }
}

/**
 * The seed/dispatch DEFAULT for the named arm when nobody named a model:
 * THE OPERATOR'S OWN default row when this arm can dispatch it, else the
 * arm's first AVAILABLE row, else the first row's id whatever its
 * availability (typed-refused and VISIBLE — never a silent substitute).
 * Display and admission both derive the default from here, so an
 * un-dispatchable default cannot be advertised.
 *
 * THE LAUNCH-MODEL LAW: an unnamed launch lands on the operator's chosen
 * model. Never a silent upgrade to a pricier family or a tighter pool —
 * a seat that wants a different engine says so and the operator answers.
 */
export function defaultWorkerModelId(registry: WorkerModelRegistryV1, arm: WorkerDispatchArm): string {
  const operatorDefault = registry.entries.find(e => e.isOperatorDefault === true && e[arm].availability === 'available')
  if (operatorDefault !== undefined) return operatorDefault.modelId
  // THE NEUTRAL RUNG (the operator's law — no family is favoured): the most
  // recent sign-in's newest usable row, before any first-listed row of a
  // family the operator never chose.
  const neutralDefault = registry.entries.find(e => e.isNeutralDefault === true && e[arm].availability === 'available')
  if (neutralDefault !== undefined) return neutralDefault.modelId
  const firstAvailable = registry.entries.find(e => e[arm].availability === 'available')
  if (firstAvailable !== undefined) return firstAvailable.modelId
  // Nothing dispatches (a keyless home): the default is the operator's own
  // row all the same — the harness's keyless placeholder, the very id the
  // boot face's birth names — so the daemon recognises that launch as
  // UNNAMED (the default-choice law) and admits it keyless instead of
  // refusing a family nobody chose.
  const operatorRow = registry.entries.find(e => e.isOperatorDefault === true)
  if (operatorRow !== undefined) return operatorRow.modelId
  return registry.entries[0]?.modelId ?? foldLegacyWorkerModelKey('fable')
}

export type WorkerModelValidation =
  | {
      ok: true
      entry: WorkerModelEntryV1
      /** THE KEYLESS ADMISSION (the neutral-default ruling): an UNNAMED
       *  session launch on a home with no credential anywhere is born on
       *  the neutral placeholder with no family named — the cockpit paints
       *  and its composer's own not-logged-in gate names the logins door.
       *  Never a refusal that names one family. */
      keyless?: true
    }
  | {
      ok: false
      reason: 'unknown-model' | WorkerModelRefusal
      /** The plain-words truth behind the typed reason. */
      detail?: string
      /** The ONE action that fixes it — rides the door's error verbatim so
       *  whoever reads the refusal can relay the real remedy. */
      action?: string
    }

/** Validate one choice against ONE arm — every door names its dispatch
 *  kind, so a session is admitted by the product's own reach and a crew
 *  seat by the crew vocabulary, never each other's. */
export async function validateWorkerModelChoice(idOrKey: string | undefined, arm: WorkerDispatchArm): Promise<WorkerModelValidation> {
  // A FAMILY WORD with no usable sign-in answers that family's own
  // credential refusal (its door, and the way out through a family that
  // is signed in) — never an 'unrecognised' about the word itself.
  if (idOrKey !== undefined && SEAT_FAMILY_WORDS.has(idOrKey) && familySeatSetting(idOrKey) === undefined) {
    if (idOrKey === 'local') {
      return { ok: false, reason: 'unreachable:local', detail: 'no local server is discovered on this box', action: loginsActionFor(idOrKey) }
    }
    return {
      ok: false,
      reason: `no-credential:${idOrKey}`,
      detail: `the ${idOrKey} family holds no usable sign-in on this account`,
      action: noCredentialAction(idOrKey),
    }
  }
  const registry = await composeWorkerModelRegistry()
  const defaultId = await canonicalWorkerModelId(defaultWorkerModelId(registry, arm))
  const id = idOrKey === undefined ? defaultId : await canonicalWorkerModelId(idOrKey)
  // THE DEFAULT-CHOICE LAW (FC-097 — the operator's Windows sighting, TASK-018
  // wave 5): the boot face never sends an UNDEFINED model. The snapshot
  // resolves the registry default and the dispatch op carries it, so the
  // daemon can never resolve a divergent default of its own (display ≡
  // dispatch across processes) — which meant every New Session arrived here
  // NAMED, and the ruled no-account sentence below was unreachable from the
  // one surface the ruling was written about: the fresh box's first frame
  // painted "…ask the operator to run /logins anthropic — the anthropic
  // family holds no credential on this account (got "claude-…")". A launch
  // is unnamed when the operator chose nothing: no id at all, OR exactly
  // the id this same registry resolves as its default WHILE that default
  // dispatches. On a keyless home the seed is the operator's own refused
  // row (defaultWorkerModelId) and no snapshot spells it — every door
  // sends NOTHING there (bornSession drops the model) — so a spelled-out
  // Claude id is the operator's own pick and keeps its family's door; only
  // a launch with no id at all admits keyless. An operator's own pick (any
  // other id) keeps its own family's refusal.
  const defaultDispatches = registry.entries.find(e => e.modelId === defaultId)?.[arm].availability === 'available'
  const unnamed = idOrKey === undefined || (id === defaultId && defaultDispatches)
  let entry = registry.entries.find(e => e.modelId === id)
  if (!entry) {
    // Operator fix 3: spoken names resolve — "opus 5",
    // "Opus-5", "sonnet5" land on the one canonical row when EXACTLY one
    // matches; a genuine unknown speaks its true class below.
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const want = norm(String(idOrKey ?? ''))
    const candidates =
      want.length >= 4
        ? registry.entries.filter(e => {
            const nid = norm(e.modelId)
            return nid === want || nid === `claude${want}` || nid.endsWith(want)
          })
        : []
    if (candidates.length === 1) {
      entry = candidates[0]
    } else {
      const { declaredRouteOf } = await import('../providers/routeLaw.js')
      const route = declaredRouteOf(id)
      if (route === null) {
        // No family declares the id — not an engine namespace, not the home
        // catalogue: the honest refusal, never a borrowed lane's reason.
        return {
          ok: false,
          reason: 'not-runnable:unrecognised',
          detail: `no provider family declares '${id}'`,
          action: unrecognisedRefusalAction(),
        }
      }
      if (route !== 'anthropic') {
        // The id names an ENGINE family's own namespace: capability, not
        // catalogue. Credentialed ⇒ it dispatches (the wire adjudicates the
        // exact id); keyless ⇒ the true reason with the real fix.
        const credentials = await readCredentialPresences()
        if (credentials.get(route) === true) {
          const arms = composeArms(id, credentials, route)
          const synthesized: WorkerModelEntryV1 = {
            modelId: id,
            displayName: id,
            ...arms,
            ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
          }
          const verdict = synthesized[arm]
          if (verdict.availability !== 'available') {
            return {
              ok: false,
              reason: verdict.refusal,
              ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
              ...(verdict.action !== undefined ? { action: verdict.action } : {}),
            }
          }
          return { ok: true, entry: synthesized }
        }
        if (route === 'local') {
          return {
            ok: false,
            reason: 'unreachable:local',
            detail: 'no local server is discovered on this box',
            action: loginsActionFor(route),
          }
        }
        return {
          ok: false,
          reason: `no-credential:${route}`,
          detail: `the ${route} family holds no credential on this account`,
          action: noCredentialAction(route),
        }
      }
      const dispatchable = registry.entries
        .filter(e => e[arm].availability === 'available')
        .map(e => e.modelId)
        .slice(0, 8)
        .join(' · ')
      const nearest = candidates[0]?.modelId
      // The refusal reads as ONE sentence — what was said, why it does not
      // dispatch, the one fix (the coordinator pane paints exactly this
      // line; the roll-call of dispatchable ids rides only when no nearer
      // fix exists).
      return {
        ok: false,
        reason: 'unknown-model',
        detail: `'${String(idOrKey ?? '')}' is not an exact model id`,
        action:
          nearest !== undefined
            ? `did you mean ${nearest}?`
            : dispatchable !== ''
              ? `pick one of: ${dispatchable}`
              : 'no models are dispatchable on this account yet — /logins signs a provider in',
      }
    }
  }
  const verdict = entry[arm]
  if (verdict.availability !== 'available') {
    // An UNNAMED launch on a home with no default provider and no credential
    // anywhere: a SESSION is born keyless on the neutral placeholder — the
    // operator's own (or the door's) unnamed launch never refuses naming a
    // family nobody chose; the chat paints, and its composer's not-logged-in
    // gate names the logins door. A CREW seat, which cannot run keyless,
    // speaks the ruled two-door sentence instead — no family named.
    if (unnamed) {
      const noAccount = await unnamedLaunchNoAccount(verdict.refusal)
      if (noAccount !== undefined) {
        if (arm === 'session' && idOrKey === undefined) return { ok: true, entry: { ...entry, displayName: NO_SIGN_IN_ROW }, keyless: true }
        return { ok: false, ...noAccount }
      }
    }
    // An UNNAMED launch that fell through a dead default provider names the
    // family the operator chose, not only the frontier lane it fell to.
    const drift = unnamed ? await unnamedLaunchDrift(verdict.refusal) : undefined
    return {
      ok: false,
      reason: verdict.refusal,
      ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
      ...(verdict.action !== undefined ? { action: verdict.action } : {}),
      ...(drift ?? {}),
    }
  }
  return { ok: true, entry }
}

async function unnamedLaunchNoAccount(
  refusal: WorkerModelRefusal,
): Promise<{ reason: typeof NO_ACCOUNT_REFUSAL; detail: string; action: string } | undefined> {
  try {
    // The default provider is the computed default's (the provider of the
    // most recent sign-in) — null with no sign-in anywhere.
    const { computedDefault } = await import('../../utils/model/computedDefault.js')
    const credentials = await readCredentialPresences()
    const anyCredentialed = [...credentials.values()].some(present => present === true)
    return noAccountRefusal(refusal, computedDefault().provider ?? undefined, anyCredentialed)
  } catch {
    return undefined
  }
}

async function unnamedLaunchDrift(refusal: WorkerModelRefusal): Promise<{ detail: string; action: string } | undefined> {
  try {
    const { computedDefault } = await import('../../utils/model/computedDefault.js')
    const credentials = await readCredentialPresences()
    return defaultProviderDriftNote(refusal, computedDefault().provider ?? undefined, family => credentials.get(family) === true)
  } catch {
    return undefined
  }
}

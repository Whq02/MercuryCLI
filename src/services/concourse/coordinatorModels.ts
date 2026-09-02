// ============================================================================
//  services/concourse/coordinatorModels — the COMPOSED coordinator model
//  registry. NOTHING here owns model facts — every entry is a projection
//  from the owning resolvers:
//
//    Canonical surface   ── getModelOptions() (THE cross-surface model
//                           owner: the Fable pin, defaults, Opus, live
//                           future-catalog rows, the GPT lineup — a model
//                           callable in /model is Coordinator-eligible by
//                           default; no Concourse-only allowlist)
//    × family credential ── providerFamilyPresences() (the ONE enumeration
//                           /accounts, /config, /usage and the Minerva/
//                           Console sub-model slots read — each family's
//                           credential EXISTENCE from its own resolver;
//                           the OpenAI record is re-primed here so the
//                           read is live, never a 5-minute-old cache; the
//                           canonical surface's own Anthropic gate reads
//                           THIS enumeration too, threaded in, so its rows
//                           and these labels are one fact)
//    × receipt names     ── readQualificationReceipts() role='coordinator'
//                           (DISPLAY NAMES ONLY, for models the live
//                           catalogue no longer lists — the receipts never
//                           decide a label; see the verdict-word ruling)
//
//  THE RULING (operator,): every model is SELECTABLE and the
//  picker never blocks anyone. `availability` is a truthful LABEL on a
//  selectable row — a CREDENTIAL or CATALOGUE fact only. THE VERDICT-WORD
//  REMOVAL (operator-ruled, COORDKEYS): no qualification-verdict word
//  ("unqualified", "not yet qualified", "qualification expired") appears on
//  any model row or status line, any provider — the qualification-receipt
//  store gated nothing on these surfaces (every row was selectable and ran;
//  the wire decides), so the coordinator registry no longer reads it for
//  labels. The store itself stays: the mission policy selector reads
//  role='primary' receipts as a real gate, and /router status reports the
//  store's own census as diagnostics. The only place a pick fails is on
//  the wire, where the transport states its reason plainly. Labels are
//  computed at READ (gates re-read live).
// ============================================================================

/** The truthful label family. Every value is SELECTABLE. */
export type CoordinatorModelAvailability =
  /** Credential present and the catalogue offers it. */
  | 'ready'
  /** The family holds no credential — `detail` names the attach home
   *  ('/logins anthropic', '/logins zai', …); a turn on it fails on
   *  the wire until the operator signs in. */
  | 'not-signed-in'
  /** The canonical surface's own row refusal (a catalogue fact) —
   *  `detail` carries that surface's reason verbatim; the coordinator
   *  never re-derives provider availability. */
  | 'provider-unavailable'
  /** The configured id the catalogue no longer lists. */
  | 'not-in-catalogue'

export interface CoordinatorModelEntryV1 {
  modelId: string
  displayName: string
  /** The provider family, in the routing law's own vocabulary
   *  (routeLaw.ts) — every family speaks its registry name; no family is
   *  folded into another's label, and an id no family declares says the
   *  honest word 'unrecognised' rather than borrowing one. */
  source: import('../providers/routeLaw.js').CallModelRoute | 'unrecognised'
  availability: CoordinatorModelAvailability
  /** The label's own detail (see each availability value). */
  detail?: string
  /** The canonical surface's own identity/limits line (ModelOption
   *  .description, verbatim) — the preview-before-apply fact. */
  description?: string
}

export interface CoordinatorModelRegistryV1 {
  entries: CoordinatorModelEntryV1[]
  /** True when at least one row exists — every row is selectable, so a
   *  picker over an empty registry is the only inert picker. */
  selectable: boolean
}

/** Injectable reads for provers; production callers pass nothing. */
export interface CoordinatorRegistryReads {
  presences?: () => import('../providers/providerUsage.js').ProviderFamilyPresence[]
}

/** The ONE spelling of a row's label — the picker's row tail, the switch
 *  receipt's note and the rail chip all paint this. Empty for a ready row. */
export function coordinatorModelStatusLabel(
  entry: Pick<CoordinatorModelEntryV1, 'availability' | 'detail'>,
): string {
  switch (entry.availability) {
    case 'ready':
      return ''
    case 'not-signed-in':
      return `not signed in — ${entry.detail ?? '/logins'}`
    case 'provider-unavailable':
      return entry.detail ?? 'provider unavailable'
    case 'not-in-catalogue':
      return 'not in the current catalogue'
  }
}

/** The label's one-word state, for surfaces with no room for the detail
 *  (the rail chip, a narrow picker pane) — the picker's detail line and the
 *  switch receipt still spell the whole label. Empty for a ready row. */
export function coordinatorModelStatusWord(entry: Pick<CoordinatorModelEntryV1, 'availability'>): string {
  switch (entry.availability) {
    case 'ready':
      return ''
    case 'not-signed-in':
      return 'not signed in'
    case 'provider-unavailable':
      return 'unavailable'
    case 'not-in-catalogue':
      return 'not listed'
  }
}

/** ONE identity normalizer (the canonical-parity law, the /model
 *  ONE-MODEL-ONE-ROW fix applied at this owner): option values and stored
 *  choices resolve through the model tables' own alias resolver to the
 *  CANONICAL model id, with the [1m] context tag stripped — context-window
 *  selection is a call-time flavor, not a second model identity. Unknown
 *  ids (GPT engines, custom deployments) pass through unchanged. */
export async function canonicalCoordinatorModelId(value: string): Promise<string> {
  const { parseUserSpecifiedModel } = await import('../../utils/model/model.js')
  return parseUserSpecifiedModel(value).replace(/\[1m]$/, '')
}

export async function composeCoordinatorModelRegistry(
  reads: CoordinatorRegistryReads = {},
): Promise<CoordinatorModelRegistryV1> {
  const entries: CoordinatorModelEntryV1[] = []
  const seen = new Set<string>()

  const [{ getModelOptions }, { declaredRouteOf }] = await Promise.all([
    import('../../utils/model/modelOptions.js'),
    import('../providers/callModelRouter.js'),
  ])
  const [{ readQualificationReceipts }, { subModelConnectHome }] = await Promise.all([
    import('../providers/openai/qualificationStore.js'),
    import('../../utils/model/subModelSlots.js'),
  ])

  // ── the credential facts, per family, from the ONE presence enumeration.
  //    The OpenAI adapter answers from a TTL'd discovery record; the
  //    registry re-primes it (a sync env/file read) so a sign-in that
  //    happened a moment ago is the truth this read paints.
  const presences = await (async () => {
    if (reads.presences !== undefined) return reads.presences()
    const [{ primeOpenaiDiscovery }, { providerFamilyPresences }] = await Promise.all([
      import('../../utils/router/providerDiscovery.js'),
      import('../providers/providerUsage.js'),
    ])
    primeOpenaiDiscovery()
    return providerFamilyPresences()
  })()
  const credentialed = (route: string): boolean =>
    presences.find(p => (p.id as string) === route)?.credentialed ?? false
  const notSignedIn = (route: import('../providers/routeLaw.js').CallModelRoute | 'unrecognised') => {
    const home = subModelConnectHome(route)
    return { availability: 'not-signed-in' as const, detail: home.command ?? home.note }
  }

  // ── the receipt census: DISPLAY NAMES ONLY (the verdict-word ruling) —
  //    a receipt keeps a model the catalogue dropped visible under its
  //    remembered name; no receipt ever decides a row's label.
  const coordinatorReceipts = new Map<string, { displayName?: string }>()
  for (const wrapped of readQualificationReceipts()) {
    if (wrapped.receipt.role !== 'coordinator') continue
    coordinatorReceipts.set(wrapped.receipt.modelId, {
      ...(wrapped.receipt.displayName !== undefined ? { displayName: wrapped.receipt.displayName } : {}),
    })
  }
  // A GPT row the LANDED live catalogue disqualifies (not served, hidden,
  // effort catalogue undecodable) carries that catalogue's words; while the
  // catalogue is pending or unreachable the row is ready — a transient
  // fetch failure never paints a model as refused.
  const { getGptSeatAvailability } = await import('../providers/openai/openaiCatalogue.js')
  const gptCatalogueLanded = getGptSeatAvailability().state === 'ready'
  const gptEntry = (modelId: string, displayName: string, catalogueReason?: string): CoordinatorModelEntryV1 => {
    const base = { modelId, displayName, source: 'openai' as const }
    if (!credentialed('openai')) return { ...base, ...notSignedIn('openai') }
    if (gptCatalogueLanded && catalogueReason !== undefined) {
      return { ...base, availability: 'provider-unavailable', detail: catalogueReason }
    }
    return { ...base, availability: 'ready' }
  }

  // ── the canonical cross-surface projection: every REAL model row the
  //    normal /model surface offers this account, verbatim. Excluded: the
  //    Default row (null — a pinned coordinator needs one exact id), mode
  //    sentinels and action rows (__…__)
  //    (value carries ':').
  for (const o of getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') })) {
    const v = typeof o.value === 'string' ? o.value : null
    if (!v || v.startsWith('__')) continue
    // The entry speaks the CANONICAL id (aliases resolved, [1m] folded) —
    // 'fable[1m]' and 'claude-fable-5' are ONE row, and dispatch receives a
    // real model id, never a picker-value spelling.
    const modelId = await canonicalCoordinatorModelId(v)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const route = declaredRouteOf(modelId) ?? 'unrecognised'
    const description = o.description.length > 0 ? { description: o.description } : {}
    if (route === 'openai') {
      entries.push({ ...gptEntry(modelId, o.label, o.unavailable), ...description })
      continue
    }
    // Every other family: the credential fact leads (the actionable
    // truth), then the owning catalogue's own row refusal, then ready.
    const label: Pick<CoordinatorModelEntryV1, 'availability' | 'detail'> = !credentialed(route)
      ? notSignedIn(route)
      : o.unavailable !== undefined
        ? { availability: 'provider-unavailable', detail: o.unavailable }
        : { availability: 'ready' }
    entries.push({ modelId, displayName: o.label, source: route, ...label, ...description })
  }
  // Engines the canonical surface hasn't listed but a coordinator receipt
  // remembers (a model the live catalogue no longer offers) stay visible
  // through the same census — never silently dropped; the receipt's own
  // displayName paints when the catalogue has no row for the id.
  for (const [modelId, rec] of coordinatorReceipts) {
    if (seen.has(modelId)) continue
    seen.add(modelId)
    entries.push(gptEntry(modelId, rec.displayName ?? modelId))
  }
  // The engine BASELINE: on a home where the canonical surface lists no GPT
  // rows at all (no account, no receipts), the known engine offerings still
  // surface with their honest label — a bare boot never hides the class.
  // Display pins are display-only by contract: the label still resolves
  // through the credential/receipt census above.
  const { GPT_DISPLAY_PINS } = await import('../providers/openai/gptPins.js')
  for (const pin of GPT_DISPLAY_PINS) {
    if (seen.has(pin.id)) continue
    seen.add(pin.id)
    // No description: the canonical surface's model rows carry none (the
    // neutrality ruling), and the pin baseline speaks the same grammar.
    entries.push(gptEntry(pin.id, pin.displayName))
  }
  // The CONFIGURED assist model is visible on every home (the active chip's
  // id must be findable by the picker's own filter, whatever its state) — a
  // stored id the catalogue no longer lists paints 'not-in-catalogue'.
  const { getGlobalConfig } = await import('../../utils/config.js')
  const stored = getGlobalConfig().concourseCoordinator?.assistModel
  const configured = stored === undefined ? undefined : await canonicalCoordinatorModelId(stored)
  if (configured !== undefined && !seen.has(configured)) {
    seen.add(configured)
    const route = declaredRouteOf(configured) ?? 'unrecognised'
    if (route === 'openai') {
      entries.push(gptEntry(configured, (await import('../providers/openai/gptPins.js')).gptDisplayName(configured) ?? configured))
    } else {
      entries.push({
        modelId: configured,
        displayName: configured,
        source: route,
        availability: 'not-in-catalogue',
      })
    }
  }

  return { entries, selectable: entries.length > 0 }
}

// ── the safe-boundary switch ─────────────────────────────────────────────────

export interface CoordinatorSwitchReceiptV1 {
  target: 'assist-model' | 'mode' | 'effort'
  value: string
  outcome: 'applied' | 'no-change' | 'refused'
  /** The typed refusal — present iff refused: 'no-choice' / 'unknown-model'
   *  for a model, 'unknown-mode' for a mode, 'unknown-effort' for an
   *  effort (the refusal detail names the ladder). A refused switch leaves
   *  the config UNTOUCHED. A credential or qualification state never
   *  refuses a switch — it rides as `availability` + `detail` on the
   *  applied receipt (the ruling: the pick is the consent; the wire
   *  decides the turn). */
  reason?: string
  /** The chosen row's truthful label at switch time ('assist-model' only):
   *  present exactly when the row is not 'ready'. */
  availability?: CoordinatorModelAvailability
  /** The spelled label for a non-ready row (coordinatorModelStatusLabel). */
  detail?: string
  /** Held 'coordinator' permits at switch time — the boundary FACT, typed
   *  (provers assert this, never the prose sentence). */
  inFlightTurns: number
  /** The safe-boundary statement: the write touches ONLY the
   *  concourseCoordinator config — a coordinator turn in flight captured
   *  its model at resolve and finishes on it; the crew seat identity and
   *  conversation persist; managed sessions are never addressed. */
  boundary: string
}

/** The boundary truth, live: a held 'coordinator' governor permit means a
 *  turn is in flight RIGHT NOW — the receipt says so, typed AND spelled. */
async function coordinatorSwitchBoundary(): Promise<{ inFlightTurns: number; boundary: string }> {
  let inFlight = 0
  try {
    const governor = await import('../capacity/governor.js')
    inFlight = governor.heldPermits().filter(g => g.lane === 'coordinator').length
  } catch {
    inFlight = 0
  }
  return {
    inFlightTurns: inFlight,
    boundary:
      inFlight > 0
        ? 'applies from the next coordinator turn — the in-flight turn finishes on its current model; identity, conversation and managed sessions untouched'
        : 'applies from the next coordinator turn; identity, conversation and managed sessions untouched',
  }
}

async function emitSwitchReceipt(receipt: CoordinatorSwitchReceiptV1): Promise<void> {
  try {
    const feed = await import('./coordinatorReceipts.js')
    await feed.ingestCoordinatorSwitchReceipt(receipt)
  } catch {
    /* the feed is a projection — never blocks or fails the switch */
  }
}

/** Switch the assist model THROUGH the composed registry: any listed row
 *  applies, carrying its truthful label on the receipt; only an id the
 *  registry does not list is refused (typed), config untouched — never a
 *  silent account or model substitution. */
export async function switchCoordinatorAssistModel(modelId: string): Promise<CoordinatorSwitchReceiptV1> {
  const { inFlightTurns, boundary } = await coordinatorSwitchBoundary()
  const validated = await validateCoordinatorModelChoice(modelId)
  if (!validated.ok) {
    const receipt: CoordinatorSwitchReceiptV1 = {
      target: 'assist-model',
      value: modelId,
      outcome: 'refused',
      reason: validated.reason,
      inFlightTurns,
      boundary,
    }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  const label =
    validated.entry.availability === 'ready'
      ? {}
      : { availability: validated.entry.availability, detail: coordinatorModelStatusLabel(validated.entry) }
  const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
  if (getGlobalConfig().concourseCoordinator?.assistModel === modelId) {
    const receipt: CoordinatorSwitchReceiptV1 = { target: 'assist-model', value: modelId, outcome: 'no-change', ...label, inFlightTurns, boundary }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, assistModel: modelId } }))
  const receipt: CoordinatorSwitchReceiptV1 = { target: 'assist-model', value: modelId, outcome: 'applied', ...label, inFlightTurns, boundary }
  await emitSwitchReceipt(receipt)
  return receipt
}

/**
 * THE COORDINATOR EFFORT DIAL (operator-ruled): the e doorway in the
 * coordinator-model picker sets a PERSISTENT effort for the coordinator's
 * own model — the one dial the estate lacked (e on a session row keeps its
 * job untouched). The word resolves through the ONE effort normalizer
 * ('max effort', 'x high' are their tiers); junk refuses TYPED naming the
 * ladder, config untouched. The same safe boundary as the model switch: a
 * turn in flight finishes at its captured effort; the next resolve reads
 * the new value.
 */
export async function switchCoordinatorEffort(effortWord: string): Promise<CoordinatorSwitchReceiptV1> {
  const { inFlightTurns, boundary } = await coordinatorSwitchBoundary()
  const { normalizeEffortLevelString, EFFORT_LEVELS } = await import('../../utils/effort.js')
  const level = normalizeEffortLevelString(effortWord)
  if (level === undefined) {
    const receipt: CoordinatorSwitchReceiptV1 = {
      target: 'effort',
      value: effortWord,
      outcome: 'refused',
      reason: 'unknown-effort',
      detail: `'${effortWord}' is not on the ladder — the levels are ${EFFORT_LEVELS.join(' | ')}`,
      inFlightTurns,
      boundary,
    }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
  // The applied-truth clause for the coordinator's CURRENT model (its
  // validated assist model): the receipt names the tier that model runs
  // when it is not the pick, or that no dial is sent — never "effort set:
  // max" alone over a low|high|max model.
  const choice = await validateCoordinatorModelChoice(getGlobalConfig().concourseCoordinator?.assistModel)
  const detail = choice.ok ? coordinatorEffortDetail(choice.entry.modelId, level) : undefined
  if (getGlobalConfig().concourseCoordinator?.effort === level) {
    const receipt: CoordinatorSwitchReceiptV1 = {
      target: 'effort',
      value: level,
      outcome: 'no-change',
      ...(detail !== undefined ? { detail } : {}),
      inFlightTurns,
      boundary,
    }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, effort: level } }))
  const receipt: CoordinatorSwitchReceiptV1 = {
    target: 'effort',
    value: level,
    outcome: 'applied',
    ...(detail !== undefined ? { detail } : {}),
    inFlightTurns,
    boundary,
  }
  await emitSwitchReceipt(receipt)
  return receipt
}

/**
 * The applied-truth clause of an effort receipt, from the ONE effort owner,
 * resolved for the coordinator's own call — thinking disabled (coordinatorCall
 * sends thinking off), so a lane whose effort dial is its reasoning dial sends
 * no dial there. Undefined when the model runs the level exactly as asked.
 * Pure over the owner; the wire-truth prover drives it.
 */
export function coordinatorEffortDetail(model: string, level: import('../../utils/effort.js').EffortLevel): string | undefined {
  const { resolveEffortTruth, NO_EFFORT_CONTROL_LABEL } = require('../../utils/effort.js') as typeof import('../../utils/effort.js')
  const truth = resolveEffortTruth(model, level, { thinkingEnabled: false })
  if (!truth.supportsEffort) {
    return `${model}: ${NO_EFFORT_CONTROL_LABEL} — ${level} is saved and applies when the coordinator runs an effort-capable model`
  }
  if (truth.suppressedBy === 'thinking-off') {
    return `${model} sends no effort dial on the coordinator's thinking-off calls and runs its provider default — ${level} is saved, not sent`
  }
  if (truth.wire === undefined) {
    return `${model} runs its provider default (no live effort vocabulary to resolve against) — ${level} is saved`
  }
  if (truth.label !== level) {
    return `${model} runs ${truth.label}, the nearest tier in its effort vocabulary`
  }
  return undefined
}

/**
 * The coordinator effort's ONE reader: the coordinator's own dial (the e
 * doorway in the coordinator-model picker) when set, else the operator's
 * /effort choice — the SAME persisted level the chat's own turns read
 * (settings.effortLevel, what /effort and the model picker write) — so
 * the tier the operator dialled applies to the coordinator's calls too,
 * and the dial stays the more specific word where it exists. Both
 * validate at read through the same normalizer that wrote them: an
 * off-ladder stored spelling (a hand-edited file) reads as absent — the
 * next owner answers, else the model's own default resolution applies;
 * never a guess, never a silent substitute. The wire resolves the answer
 * through the one effort owner (the builders' resolveAppliedEffort:
 * step-down to the model's ladder, the thinking-off suppression).
 */
export function resolveCoordinatorEffort(): import('../../utils/effort.js').EffortLevel | undefined {
  const { getGlobalConfig } = require('../../utils/config.js') as typeof import('../../utils/config.js')
  const { normalizeEffortLevelString, getInitialEffortSetting } = require('../../utils/effort.js') as typeof import('../../utils/effort.js')
  const stored = getGlobalConfig().concourseCoordinator?.effort
  const dial = stored === undefined ? undefined : normalizeEffortLevelString(stored)
  if (dial !== undefined) return dial
  return getInitialEffortSetting()
}

const COORDINATOR_MODES = ['off', 'rules-only', 'agent-assisted'] as const

/** Switch the coordinator mode (closed vocabulary — anything else is a
 *  typed refusal, config untouched). Takes effect at the next resolve; the
 *  effective composition (mode × validated choice) stays the lane's law. */
export async function switchCoordinatorMode(
  mode: 'off' | 'rules-only' | 'agent-assisted',
): Promise<CoordinatorSwitchReceiptV1> {
  const { inFlightTurns, boundary } = await coordinatorSwitchBoundary()
  if (!COORDINATOR_MODES.includes(mode)) {
    const receipt: CoordinatorSwitchReceiptV1 = {
      target: 'mode',
      value: String(mode),
      outcome: 'refused',
      reason: 'unknown-mode',
      inFlightTurns,
      boundary,
    }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
  const current = getGlobalConfig().concourseCoordinator?.mode ?? 'rules-only'
  if (current === mode) {
    const receipt: CoordinatorSwitchReceiptV1 = { target: 'mode', value: mode, outcome: 'no-change', inFlightTurns, boundary }
    await emitSwitchReceipt(receipt)
    return receipt
  }
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { ...c.concourseCoordinator, mode } }))
  const receipt: CoordinatorSwitchReceiptV1 = { target: 'mode', value: mode, outcome: 'applied', inFlightTurns, boundary }
  await emitSwitchReceipt(receipt)
  return receipt
}

/** Validate a configured coordinator model against the LIVE composition —
 *  the config never overrides the registry. A choice validates when the
 *  registry LISTS it (its truthful label rides on the entry); only an
 *  absent choice or an id the registry does not list fails, typed. */
export async function validateCoordinatorModelChoice(
  modelId: string | undefined,
): Promise<
  | { ok: true; entry: CoordinatorModelEntryV1 }
  | { ok: false; reason: 'no-choice' | 'unknown-model' }
> {
  if (modelId === undefined || modelId === '') return { ok: false, reason: 'no-choice' }
  const registry = await composeCoordinatorModelRegistry()
  // Stored choices may carry alias spellings ('fable[1m]', 'opus') from
  // older configs — resolve through the SAME normalizer the registry ids
  // use, so one model validates under every lawful spelling.
  const wanted = await canonicalCoordinatorModelId(modelId)
  const entry = registry.entries.find(e => e.modelId === wanted)
  if (!entry) return { ok: false, reason: 'unknown-model' }
  return { ok: true, entry }
}

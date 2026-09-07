
export type CoordinatorModelAvailability =
  | 'ready'
  | 'not-signed-in'
  | 'provider-unavailable'
  | 'not-in-catalogue'

export interface CoordinatorModelEntryV1 {
  modelId: string
  displayName: string
  source: import('../providers/routeLaw.js').CallModelRoute | 'unrecognised'
  availability: CoordinatorModelAvailability
  detail?: string
  description?: string
}

export interface CoordinatorModelRegistryV1 {
  entries: CoordinatorModelEntryV1[]
  selectable: boolean
}

export interface CoordinatorRegistryReads {
  presences?: () => import('../providers/providerUsage.js').ProviderFamilyPresence[]
}

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

  const coordinatorReceipts = new Map<string, { displayName?: string }>()
  for (const wrapped of readQualificationReceipts()) {
    if (wrapped.receipt.role !== 'coordinator') continue
    coordinatorReceipts.set(wrapped.receipt.modelId, {
      ...(wrapped.receipt.displayName !== undefined ? { displayName: wrapped.receipt.displayName } : {}),
    })
  }
  if (credentialed('openai')) await (await import('../providers/catalogueOnDemand.js')).readCatalogueIfPending('openai')
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

  for (const o of getModelOptions({ anthropicCredentialed: () => credentialed('anthropic') })) {
    const v = typeof o.value === 'string' ? o.value : null
    if (!v || v.startsWith('__')) continue
    const modelId = await canonicalCoordinatorModelId(v)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const route = declaredRouteOf(modelId) ?? 'unrecognised'
    const description = o.description.length > 0 ? { description: o.description } : {}
    if (route === 'openai') {
      entries.push({ ...gptEntry(modelId, o.label, o.unavailable), ...description })
      continue
    }
    const label: Pick<CoordinatorModelEntryV1, 'availability' | 'detail'> = !credentialed(route)
      ? notSignedIn(route)
      : o.unavailable !== undefined
        ? { availability: 'provider-unavailable', detail: o.unavailable }
        : { availability: 'ready' }
    entries.push({ modelId, displayName: o.label, source: route, ...label, ...description })
  }
  for (const [modelId, rec] of coordinatorReceipts) {
    if (seen.has(modelId)) continue
    seen.add(modelId)
    entries.push(gptEntry(modelId, rec.displayName ?? modelId))
  }
  const { GPT_DISPLAY_PINS } = await import('../providers/openai/gptPins.js')
  for (const pin of GPT_DISPLAY_PINS) {
    if (seen.has(pin.id)) continue
    seen.add(pin.id)
    entries.push(gptEntry(pin.id, pin.displayName))
  }
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


export interface CoordinatorSwitchReceiptV1 {
  target: 'assist-model' | 'mode' | 'effort'
  value: string
  outcome: 'applied' | 'no-change' | 'refused'
  reason?: string
  availability?: CoordinatorModelAvailability
  detail?: string
  inFlightTurns: number
  boundary: string
}

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
  }
}

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

export function coordinatorEffortDetail(model: string, level: import('../../utils/effort.js').EffortLevel): string | undefined {
  const { resolveEffortTruth, NO_EFFORT_CONTROL_LABEL } = require('../../utils/effort.js') as typeof import('../../utils/effort.js')
  const truth = resolveEffortTruth(model, level, { thinkingEnabled: false })
  if (!truth.supportsEffort) {
    return `${model}: ${NO_EFFORT_CONTROL_LABEL} — ${level} is saved and applies when the coordinator runs an effort-capable model`
  }
  if (truth.suppressedBy === 'thinking-off') {
    return `${model} sends no effort dial on the coordinator's thinking-off calls and runs its provider default — ${level} is saved, not sent`
  }
  if (truth.flooredBy === 'thinking-off') {
    return `${model} sends ${truth.wire} on the coordinator's thinking-off calls (the lowest it serves) — ${level} is saved, not sent`
  }
  if (truth.wire === undefined) {
    return `${model} runs its provider default (no live effort vocabulary to resolve against) — ${level} is saved`
  }
  if (truth.label !== level) {
    return `${model} runs ${truth.label}, the nearest tier in its effort vocabulary`
  }
  return undefined
}

export function resolveCoordinatorEffort(): import('../../utils/effort.js').EffortLevel | undefined {
  const { getGlobalConfig } = require('../../utils/config.js') as typeof import('../../utils/config.js')
  const { normalizeEffortLevelString, getInitialEffortSetting } = require('../../utils/effort.js') as typeof import('../../utils/effort.js')
  const stored = getGlobalConfig().concourseCoordinator?.effort
  const dial = stored === undefined ? undefined : normalizeEffortLevelString(stored)
  if (dial !== undefined) return dial
  return getInitialEffortSetting()
}

const COORDINATOR_MODES = ['off', 'rules-only', 'agent-assisted'] as const

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

export async function validateCoordinatorModelChoice(
  modelId: string | undefined,
): Promise<
  | { ok: true; entry: CoordinatorModelEntryV1 }
  | { ok: false; reason: 'no-choice' | 'unknown-model' }
> {
  if (modelId === undefined || modelId === '') return { ok: false, reason: 'no-choice' }
  const registry = await composeCoordinatorModelRegistry()
  const wanted = await canonicalCoordinatorModelId(modelId)
  const entry = registry.entries.find(e => e.modelId === wanted)
  if (!entry) return { ok: false, reason: 'unknown-model' }
  return { ok: true, entry }
}

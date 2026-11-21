import { fmtCtx as fmtCtxWindow, type ModelChoice } from '../../../components/MercuryModelPicker.js'
import { getContextWindowForModel } from '../../../utils/context.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModel, renderModelName } from '../../../services/model/model.js'
import { providerFamilyOfSetting } from '../../../services/model/modelTransition.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../../services/engine-connector/focusedConnector.js'
import { ANTHROPIC_MODEL_GROUP, applyModelAllowlist, focusedOptionSupports1m, getModelOptions, isProviderActionRow, type ModelOption, OPENAI_MODEL_GROUP, parseKeyConnectValue, stripContext1m, withContext1m } from '../../../services/model/modelOptions.js'
import { OPENROUTER_MODEL_GROUP, getOpenrouterFullModelOptions } from '../../../services/providers/openrouter/openrouterCatalogue.js'
import { NOUS_MODEL_GROUP, getNousFullModelOptions } from '../../../services/providers/nous/nousCatalogue.js'
import { qualifiedIdSpaceOf } from '../../../services/providers/idSpaces.js'
import { anthropicDoors, anthropicListedModel, type AnthropicDoor } from '../../../services/providers/anthropic/anthropicCatalogue.js'
import { HUGGINGFACE_MODEL_GROUP, getHuggingfaceFullModelOptions } from '../../../services/providers/huggingface/huggingfaceCatalogue.js'
import { isLocalModelId, LOCAL_MODEL_GROUP, localRecordFor } from '../../../services/providers/local/localCatalogue.js'
import { onTensorFoldAct } from '../../tensorfold/tensorfold.js'
import type { TensorFoldAct } from '../../../components/tensorfold/tensorfoldRows.js'
import type { ModelTensorFold } from '../../../components/tensorfold/tensorfoldModelFacts.js'
import { parseGptModelId, withGptServedWindowSuffix } from '../../../utils/model/pins/gptPins.js'
import { liveGptContextCeiling } from '../../../services/providers/openai/openaiCatalogue.js'
import { slotSeatView, switchActiveSlot, type SwitchableFamily } from '../../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../../services/providers/slotSwitchReceipt.js'
import { configuredCompatEndpoints, isCompatEndpointCredentialed } from '../../../services/providers/openaicompat/compatAccounts.js'
import { cachedCompatCatalogue, compatCatalogueStatusWords, compatEndpointModelIds, compatEndpointPodTerminated, refreshCompatCatalogues } from '../../../services/providers/openaicompat/compatCatalogue.js'
import { orderPickerRows } from '../../../utils/model/modelPickerGroups.js'
import { readModelUseLedger, recordModelUse } from '../../../utils/model/modelUseLedger.js'
import { has1mContext } from '../../../utils/context.js'
import { familyOfModelGroup, groupOfFamily, anthropicDoorLabel } from './headings.js'
import { passedOver } from '../../../utils/passedOver.js'

const CATALOGUE_DOORS: Record<string, () => ModelOption[]> = {
  [OPENROUTER_MODEL_GROUP]: () => getOpenrouterFullModelOptions(),
  [HUGGINGFACE_MODEL_GROUP]: () => getHuggingfaceFullModelOptions(),
  [NOUS_MODEL_GROUP]: () => getNousFullModelOptions(),
}

function fmtCtx(windowSize: number, local = false): string {
  if (!windowSize) return ''
  return `${fmtCtxWindow(windowSize, local)} ctx`
}


export function resolveCurrentRowId(models: ModelChoice[], served: string): string {
  if (models.some(m => m.id === served)) return served
  const target = stripContext1m(parseUserSpecifiedModel(served))
  const rows = models.filter(m => !m.gated && !m.action)
  const resolvedOf = (id: string): string | null => {
    try {
      return parseUserSpecifiedModel(id)
    } catch (error) {
      passedOver(error)
      return null
    }
  }
  for (const exact of [true, false]) {
    for (const m of rows) {
      const resolved = resolvedOf(m.id)
      if (resolved === null || stripContext1m(resolved) !== target) continue
      if (exact && has1mContext(resolved) !== has1mContext(served)) continue
      return m.id
    }
  }
  return served
}

export const subscribeFocusedModelFeed = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
export function getFocusedModelKey(): string {
  const facts = getFocusedSessionConnector().modelFacts()
  return `${facts.effective}|${facts.setting ?? ''}|${facts.pendingSwitch ? (facts.pendingSwitch.setting ?? 'default') : ''}`
}

export function modelChoiceOf(opt: ModelOption, betas: string[] | undefined): ModelChoice {
  let ctx = ''
  let ctxBase = ''
  let ctx1m = ''
  if (isProviderActionRow(opt.value)) {
    const group = opt.group ?? ANTHROPIC_MODEL_GROUP
    return {
      id: opt.value,
      name: opt.label,
      tag: opt.description,
      ctx: '',
      group,
      action: true,
      ...(opt.catalogueDoor ? { expand: { group, family: opt.catalogueDoor.family, total: opt.catalogueDoor.total } } : {}),
    }
  }
  if (opt.unavailable !== undefined && parseGptModelId(opt.value)) {
    return { id: opt.value, name: opt.label, tag: opt.description, ctx: '', group: opt.group ?? ANTHROPIC_MODEL_GROUP, gated: true, gatedReason: opt.unavailable }
  }
  if (opt.liveUnknown === true || opt.statedContextWindow !== undefined || qualifiedIdSpaceOf(opt.value)?.qualifiedPrefix !== undefined) {
    return {
      id: opt.value,
      name: opt.label,
      tag: opt.description,
      ctx: opt.statedContextWindow !== undefined ? fmtCtx(opt.statedContextWindow, isLocalModelId(opt.value)) : '',
      group: opt.group ?? ANTHROPIC_MODEL_GROUP,
      ...(opt.unavailable ? { gated: true, gatedReason: opt.unavailable } : {}),
    }
  }
  try {
    const v = opt.value
    const shown =
      focusedOptionSupports1m(v) && !has1mContext(v)
        ? withContext1m(v)
        : v
    const windowProbe = has1mContext(shown)
      ? withContext1m(parseUserSpecifiedModel(stripContext1m(shown)))
      : parseUserSpecifiedModel(shown)
    ctx = fmtCtx(getContextWindowForModel(windowProbe, betas))
    if (focusedOptionSupports1m(v)) {
      const pairBase = parseUserSpecifiedModel(stripContext1m(v))
      ctxBase = fmtCtx(getContextWindowForModel(pairBase, betas))
      ctx1m = fmtCtx(getContextWindowForModel(withContext1m(pairBase), betas))
    }
    if (parseGptModelId(opt.value) && liveGptContextCeiling(opt.value) !== undefined) {
      ctxBase = fmtCtx(getContextWindowForModel(withGptServedWindowSuffix(opt.value), betas))
      ctx1m = fmtCtx(getContextWindowForModel(opt.value, betas))
    }
  } catch {
    ctx = ''
    ctxBase = ''
    ctx1m = ''
  }
  return {
    id: opt.value,
    name: opt.label,
    tag: opt.description,
    ctx,
    ...(ctxBase !== '' ? { ctxBase } : {}),
    ...(ctx1m !== '' ? { ctx1m } : {}),
    group: opt.group ?? ANTHROPIC_MODEL_GROUP,
    ...(opt.unavailable !== undefined ? { gated: true, gatedReason: opt.unavailable } : {}),
  }
}

export function expandRowsOf(group: string, betas: string[] | undefined): ModelChoice[] {
  return applyModelAllowlist(CATALOGUE_DOORS[group]?.() ?? []).map(opt => modelChoiceOf(opt, betas))
}

export function pickLabelOf(options: ModelOption[], id: string): string {
  return (
    options.find(o => o.value === id)?.label ??
    Object.values(CATALOGUE_DOORS)
      .flatMap(rows => rows())
      .find(o => o.value === id)?.label ??
    id
  )
}

export function slotSwitchOf(group: string, bump: () => void): string | null {
  const family: SwitchableFamily | null =
    group === ANTHROPIC_MODEL_GROUP ? 'anthropic' : group === OPENAI_MODEL_GROUP ? 'openai' : null
  if (family === null) return null
  if (slotSeatView(family).other === undefined) return null
  const outcome = switchActiveSlot(family)
  paintSlotSwitchReceipt(outcome)
  bump()
  return outcome.receipt
}

function anthropicDoorRows(models: ModelChoice[]): ModelChoice[] {
  const doors = anthropicDoors().filter(door => door.expired !== true)
  if (doors.length < 2) return models
  const active: AnthropicDoor = slotSeatView('anthropic').active === 'api-key' ? 'api-key' : 'subscription'
  const ordered = [...doors.filter(door => door.door === active), ...doors.filter(door => door.door !== active)]
  const labels = new Map(ordered.map(door => [door.door, anthropicDoorLabel(door.door)] as const))
  const out: ModelChoice[] = []
  const byDoor = new Map<AnthropicDoor, ModelChoice[]>(ordered.map(door => [door.door, []]))
  for (const model of models) {
    if (model.group !== ANTHROPIC_MODEL_GROUP || model.action || model.expand !== undefined) {
      out.push(model)
      continue
    }
    let resolved = model.id
    try {
      resolved = parseUserSpecifiedModel(stripContext1m(model.id))
    } catch {
      resolved = model.id
    }
    const listing = anthropicListedModel(resolved)
    const own = listing === undefined ? [] : ordered.filter(door => listing.doors.includes(door.label))
    for (const door of own.length > 0 ? own : ordered.slice(0, 1)) byDoor.get(door.door)!.push({ ...model, door: labels.get(door.door)! })
  }
  const first = out.findIndex(model => model.group === ANTHROPIC_MODEL_GROUP)
  const doorRows = ordered.flatMap(door => byDoor.get(door.door) ?? [])
  if (first < 0) return [...out, ...doorRows]
  return [...out.slice(0, first), ...doorRows, ...out.slice(first)]
}

export function seatGroupOf(models: ModelChoice[], currentRowId: string): string | undefined {
  const own = models.find(model => model.id === currentRowId)
  if (own !== undefined) return own.group
  const family = providerFamilyOfSetting(currentRowId)
  return family === 'unrecognised' ? undefined : groupOfFamily(family)
}

export function orderedModelChoices(models: ModelChoice[], currentRowId: string): ModelChoice[] {
  const uses = readModelUseLedger()
  return orderPickerRows(anthropicDoorRows(models), {
    ...(seatGroupOf(models, currentRowId) !== undefined ? { top: seatGroupOf(models, currentRowId) } : {}),
    recentAt: group => {
      const family = familyOfModelGroup(group)
      return family === undefined ? undefined : uses[family]?.at
    },
  })
}

export function servedByTensorFold(choice: Pick<ModelChoice, 'id' | 'group'>, podEndpoints: ReadonlySet<string>): boolean {
  const endpoint = /^(?:__mercury_connect__:)?compat\/([^/]+)(?:\/|$)/.exec(choice.id)?.[1]
  return (choice.group === LOCAL_MODEL_GROUP && localRecordFor(choice.id)?.server === 'tensorfold') || (endpoint !== undefined && podEndpoints.has(endpoint))
}

export function tensorFoldPodEndpoints(pods: readonly { id: string }[], endpoints: readonly { name: string; hostPodId?: string }[] = configuredCompatEndpoints()): ReadonlySet<string> {
  const ids = new Set(pods.map(pod => pod.id))
  return new Set(endpoints.filter(endpoint => endpoint.hostPodId !== undefined && ids.has(endpoint.hostPodId)).map(endpoint => endpoint.name))
}

export async function runModelTensorFoldAct(act: TensorFoldAct, tensorFold: ModelTensorFold, io: Parameters<typeof onTensorFoldAct>[2], doors: Parameters<typeof onTensorFoldAct>[3]): Promise<void> {
  const panel = await tensorFold.panel()
  if (act.kind !== 'serve' || panel.engine !== null) return onTensorFoldAct(act, panel, io, doors)
  await onTensorFoldAct({ kind: 'install' }, panel, io, doors)
  const installed = await tensorFold.read(true)
  if (installed.panel.engine !== null) await onTensorFoldAct(act, installed.panel, io, doors)
}

export function noteModelUse(setting: string, door?: string): void {
  const family = providerFamilyOfSetting(setting)
  if (family === 'unrecognised') return
  void recordModelUse(family, setting, door !== undefined ? { door } : {})
}

export function retryNamedCompatRow(id: string, setNotice: (words: string) => void): boolean {
  const lane = parseKeyConnectValue(id)
  if (!lane?.startsWith('compat/')) return false
  const name = lane.slice('compat/'.length)
  const endpoint = configuredCompatEndpoints().find(endpoint => endpoint.name === name)
  if (!endpoint) { setNotice(`Custom endpoint '${name}' is no longer registered — /llmhost connects it`); return true }
  if (!isCompatEndpointCredentialed(endpoint)) return false
  if (compatEndpointPodTerminated(endpoint)) { setNotice(compatCatalogueStatusWords(endpoint)); return true }
  setNotice(`${endpoint.label} — refreshing the model list…`)
  void refreshCompatCatalogues({ force: true, name }).then(() => {
    const models = compatEndpointModelIds(endpoint)
    setNotice(models.length && !cachedCompatCatalogue(endpoint)?.error ? `${endpoint.label} · ${models.length} models — pick one above` : compatCatalogueStatusWords(endpoint))
  }).catch(error => setNotice(`${endpoint.label} · could not refresh the model list: ${error instanceof Error ? error.message : String(error)}`))
  return true
}

function modelChoiceRowOf(options: ModelOption[], id: string): ModelOption | undefined {
  const wanted = normalizeModelStringForAPI(parseUserSpecifiedModel(id)).toLowerCase()
  return options.find(
    option =>
      typeof option.value === 'string' &&
      !option.value.startsWith('__') &&
      !isProviderActionRow(option.value) &&
      normalizeModelStringForAPI(parseUserSpecifiedModel(option.value)).toLowerCase() === wanted,
  )
}

export function modelChoiceLabel(id: string): string {
  const options = getModelOptions()
  const direct = pickLabelOf(options, id)
  if (direct !== id) return direct
  return modelChoiceRowOf(options, id)?.label ?? renderModelName(id)
}

export function modelChoiceRow(id: string): string {
  if (id === '') return id
  const options = getModelOptions()
  if (options.some(option => option.value === id)) return id
  return modelChoiceRowOf(options, id)?.value ?? id
}

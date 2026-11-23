
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { parseUserSpecifiedModel } from '../../models/catalogue/engineModel.js'
import { CHOOSE_A_MODEL_WORDS, NO_SIGN_IN_ROW, NO_USABLE_ROW, isChooseAModel, keylessReason, resetComputedDefaultMemo, type LaneRowVerdict } from '../../models/catalogue/computedDefault.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'

type WorkerModelRefusal =
  | `no-credential:${string}`
  | `unreachable:${string}`
  | 'withdrawn-at-provider'
  | `not-runnable:${string}`

type WorkerDispatchArm = 'session' | 'crew'

type WorkerArmAvailabilityV1 =
  | { availability: 'available' }
  | { availability: 'refused'; refusal: WorkerModelRefusal; detail?: string; action?: string }

export interface WorkerModelEntryV1 {
  modelId: string
  displayName: string
  session: WorkerArmAvailabilityV1
  crew: WorkerArmAvailabilityV1
  effort?: 'high'
  isOperatorDefault?: true
  isNeutralDefault?: true
}

interface WorkerModelRegistryV1 {
  schema: 1
  entries: WorkerModelEntryV1[]
}

interface WorkerRegistryReads {
  modelOptions?: () => Array<{ value: string; label: string }>
}

const WORKER_MODEL_LEGACY_KEY_NAMES = new Set(['opus', 'sonnet', 'fable', 'fable51'])

const LOGINS_FAMILY_WORDS = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'xai', 'meta', 'mistral', 'nous', 'zen', 'minimax', 'together', 'cohere', 'groq', 'orcarouter', 'melious', 'cerebras', 'fireworks', 'qwen'])
export function loginsActionFor(family: string, compatEndpoint?: string): string {
  if (LOGINS_FAMILY_WORDS.has(family)) return `ask the operator to run /logins ${family}`
  if (family === 'openai-compat') {
    if (compatEndpoint !== undefined) {
      const { compatKeyEnvName } = require('../../models/roads/openaicompat/compatAccounts.js') as typeof import('../../models/roads/openaicompat/compatAccounts.js')
      return `the endpoint '${compatEndpoint}' needs a key: /logins compat/${compatEndpoint} (or set ${compatKeyEnvName(compatEndpoint)})`
    }
    return 'ask the operator to start an OpenAI-compatible endpoint with /llmhost, or pick another model with /model'
  }
  if (family === 'local') return 'ask the operator to start a local server, or set MERCURY_LOCAL_BASE_URL'
  return 'ask the operator to run /logins'
}

const SEAT_FAMILY_WORDS = new Set([...LOGINS_FAMILY_WORDS, 'openai-compat', 'local'])

interface SeatFamilyChoiceV1 {
  family: string
  setting: string
  row: string
}

export function neutralSeatDefault(): SeatFamilyChoiceV1 | null {
  try {
    const { computedDefault } =
      require('../../models/catalogue/computedDefault.js') as typeof import('../../models/catalogue/computedDefault.js')
    const decision = computedDefault()
    if (decision.source === 'keyless' || decision.provider === null) return null
    return { family: decision.provider, setting: decision.setting, row: decision.row }
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function seatFamilyChoices(): SeatFamilyChoiceV1[] {
  try {
    const { computedDefault } =
      require('../../models/catalogue/computedDefault.js') as typeof import('../../models/catalogue/computedDefault.js')
    const out: SeatFamilyChoiceV1[] = []
    for (const considered of computedDefault().considered) {
      if (!considered.verdict.usable) continue
      const verdict = considered.verdict as Extract<LaneRowVerdict, { usable: true }>
      out.push({ family: considered.family, setting: verdict.setting, row: verdict.row })
    }
    return out
  } catch (error) {
    passedOver(error)
    return []
  }
}

function familySeatSetting(family: string): string | undefined {
  return seatFamilyChoices().find(c => c.family === family)?.setting
}

function noCredentialAction(family: string, compatEndpoint?: string): string {
  const door = loginsActionFor(family, compatEndpoint)
  const other = seatFamilyChoices().find(c => c.family !== family)
  if (other === undefined) return door
  let name = other.family
  try {
    const { providerDisplayName } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
    name = providerDisplayName(other.family)
  } catch (error) {
    passedOver(error)
  }
  return `${door} — or ${name} is signed in: leave the model out for its newest row (${other.row}), or name '${other.family}' to pick that family`
}

export function defaultProviderDriftNote(
  refusal: WorkerModelRefusal,
  configuredProvider: string | undefined,
  credentialed: (family: string) => boolean,
): { detail: string; action: string } | undefined {
  if (!refusal.startsWith('no-credential:')) return undefined
  const fellTo = refusal.slice('no-credential:'.length)
  if (configuredProvider === undefined || configuredProvider === fellTo) return undefined
  if (credentialed(configuredProvider)) return undefined
  const { providerDisplayName } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
  return {
    detail: `the operator's default provider is ${providerDisplayName(configuredProvider)}, which holds no credential on this account any more, so the unnamed launch fell to the ${fellTo} family — which holds none either`,
    action: `${loginsActionFor(configuredProvider)} (their default provider), or /defaultprovider picks another`,
  }
}

export const NO_ACCOUNT_REFUSAL = 'no-credential:any' satisfies WorkerModelRefusal
const NO_ACCOUNT_DETAIL = 'no provider is signed in on this account'
const NO_ACCOUNT_ACTION = '/logins to choose an account or connect an API key'

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

type CredentialReads = ReadonlyMap<string, boolean>
async function readCredentialPresences(): Promise<CredentialReads> {
  const { providerFamilyPresences } = await import('../../models/roads/providerUsage.js')
  const map = new Map<string, boolean>()
  for (const presence of providerFamilyPresences()) {
    map.set(presence.id, presence.credentialed)
  }
  return map
}

type CompatCredentialReader = ReturnType<typeof import('../../models/roads/openaicompat/compatAccounts.js').compatCredentialReader>
type CompatReaderResult =
  | { ok: true; reader: CompatCredentialReader }
  | { ok: false; detail: string }
const compatReaders = new WeakMap<CredentialReads, CompatReaderResult>()
function compatReaderFor(credentials?: CredentialReads): CompatReaderResult {
  const held = credentials !== undefined ? compatReaders.get(credentials) : undefined
  if (held !== undefined) return held
  let result: CompatReaderResult
  try {
    const reader = (require('../../models/roads/openaicompat/compatAccounts.js') as typeof import('../../models/roads/openaicompat/compatAccounts.js')).compatCredentialReader()
    result = { ok: true, reader }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logForDebugging(`[worker-models] compat credential read failed: ${detail}`)
    result = { ok: false, detail }
  }
  if (credentials !== undefined) compatReaders.set(credentials, result)
  return result
}

function unrecognisedRefusalAction(): string {
  const plain = 'pick a listed row from the model picker'
  try {
    const { catalogueSpellingExamples } =
      require('../../models/catalogue/modelSpellingFold.js') as typeof import('../../models/catalogue/modelSpellingFold.js')
    const examples = catalogueSpellingExamples(3)
    if (examples.length > 0) {
      return `${plain} — spellings like ${examples.map(e => `'${e}'`).join(', ')} resolve, display names and ids both`
    }
  } catch (error) {
    passedOver(error)
  }
  return plain
}

function composeArms(
  modelId: string,
  credentials: CredentialReads,
  route: string,
): { session: WorkerArmAvailabilityV1; crew: WorkerArmAvailabilityV1 } {
  if (isChooseAModel(modelId)) {
    const refused: WorkerArmAvailabilityV1 = { availability: 'refused', refusal: NO_ACCOUNT_REFUSAL, detail: NO_ACCOUNT_DETAIL, action: NO_ACCOUNT_ACTION }
    return { session: refused, crew: refused }
  }
  if (route === 'unrecognised') {
    const refused: WorkerArmAvailabilityV1 = {
      availability: 'refused',
      refusal: 'not-runnable:unrecognised',
      detail: `no provider family declares '${modelId}'`,
      action: unrecognisedRefusalAction(),
    }
    return { session: refused, crew: refused }
  }
  if (route === 'openai-compat') {
    let notice: string | undefined
    try {
      const { compatModelEndpoint } = require('../../models/roads/openaicompat/compatAccounts.js') as typeof import('../../models/roads/openaicompat/compatAccounts.js')
      const { boxEndpointNotice } = require('../../models/hosting/boxService.js') as typeof import('../../models/hosting/boxService.js')
      const endpoint = compatModelEndpoint(modelId)?.endpoint
      notice = endpoint && boxEndpointNotice(endpoint.name, endpoint.baseUrl)
    } catch (error) { passedOver(error) }
    if (notice) {
      const refused: WorkerArmAvailabilityV1 = { availability: 'refused', refusal: 'unreachable:box', detail: notice, action: '/llmhost → One of my computers' }
      return { session: refused, crew: refused }
    }
  }
  const compatResult = route === 'openai-compat' ? compatReaderFor(credentials) : undefined
  if (compatResult !== undefined && !compatResult.ok) {
    const refused: WorkerArmAvailabilityV1 = { availability: 'refused', refusal: 'not-runnable:compat-error', detail: compatResult.detail }
    return { session: refused, crew: refused }
  }
  const compat = compatResult?.reader
  const credentialed = compat !== undefined ? compat.credentialed(modelId) : credentials.get(route) === true
  const compatEndpoint = compat !== undefined && !credentialed ? compat.refusalEndpoint(modelId) : undefined
  const session: WorkerArmAvailabilityV1 = credentialed
    ? { availability: 'available' }
    : route === 'local'
      ? {
          availability: 'refused',
          refusal: 'unreachable:local',
          detail: 'no local server is discovered on this box',
          action: loginsActionFor(route),
        }
      : {
          availability: 'refused',
          refusal: `no-credential:${route}`,
          detail:
            compatEndpoint !== undefined
              ? `the endpoint '${compatEndpoint}' (${route} family) holds no credential on this account`
              : `the ${route} family holds no credential on this account`,
          action: noCredentialAction(route, compatEndpoint),
        }
  return { session, crew: session }
}

export function foldLegacyWorkerModelKey(idOrKey: string): string {
  if (WORKER_MODEL_LEGACY_KEY_NAMES.has(idOrKey)) return parseUserSpecifiedModel(idOrKey)
  if (SEAT_FAMILY_WORDS.has(idOrKey)) return familySeatSetting(idOrKey) ?? idOrKey
  return idOrKey
}

async function canonicalModelId(value: string): Promise<string> {
  return parseUserSpecifiedModel(value).replace(/\[1m]$/, '')
}

export async function canonicalWorkerModelId(idOrKey: string): Promise<string> {
  return canonicalModelId(foldLegacyWorkerModelKey(idOrKey))
}

export async function composeWorkerModelRegistry(reads: WorkerRegistryReads = {}): Promise<WorkerModelRegistryV1> {
  const { getModelOptions } = await import('../../models/catalogue/modelOptions.js')
  const { declaredRouteOf } = await import('../../models/roads/routeLaw.js')
  const options = reads.modelOptions !== undefined ? reads.modelOptions() : getModelOptions()
  const credentials = await readCredentialPresences()
  const entries: WorkerModelEntryV1[] = []
  const seen = new Set<string>()
  let operatorDefaultId: string | undefined
  try {
    const { getEngineModel } = await import('../../models/catalogue/engineModel.js')
    operatorDefaultId = await canonicalWorkerModelId(getEngineModel())
  } catch (error) {
    passedOver(error)
  }
  let neutralDefaultId: string | undefined
  const neutral = neutralSeatDefault()
  if (neutral !== null) {
    try {
      neutralDefaultId = await canonicalWorkerModelId(neutral.setting)
    } catch (error) {
      passedOver(error)
    }
  }
  for (const o of options) {
    const v = o.value
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
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      ...operatorMark,
      ...neutralMark,
    })
  }
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
  if (operatorDefaultId !== undefined && !seen.has(operatorDefaultId)) {
    const arms = composeArms(operatorDefaultId, credentials, declaredRouteOf(operatorDefaultId) ?? 'unrecognised')
    entries.unshift({
      modelId: operatorDefaultId,
      displayName: isChooseAModel(operatorDefaultId) ? CHOOSE_A_MODEL_WORDS : `${operatorDefaultId} · default`,
      ...arms,
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      isOperatorDefault: true,
    })
    seen.add(operatorDefaultId)
  }
  return { schema: 1, entries }
}

export function defaultWorkerModelId(registry: WorkerModelRegistryV1, arm: WorkerDispatchArm): string {
  const operatorDefault = registry.entries.find(e => e.isOperatorDefault === true && e[arm].availability === 'available')
  if (operatorDefault !== undefined) return operatorDefault.modelId
  const neutralDefault = registry.entries.find(e => e.isNeutralDefault === true && e[arm].availability === 'available')
  if (neutralDefault !== undefined) return neutralDefault.modelId
  const firstAvailable = registry.entries.find(e => e[arm].availability === 'available')
  if (firstAvailable !== undefined) return firstAvailable.modelId
  const operatorRow = registry.entries.find(e => e.isOperatorDefault === true)
  if (operatorRow !== undefined) return operatorRow.modelId
  return registry.entries[0]?.modelId ?? foldLegacyWorkerModelKey('fable')
}

type WorkerModelValidation =
  | {
      ok: true
      entry: WorkerModelEntryV1
      keyless?: true
      note?: string
    }
  | {
      ok: false
      reason: WorkerModelRefusal
      detail?: string
      action?: string
    }

async function admissionNamesKeyedFamily(idOrKey: string): Promise<string | null> {
  const { isKeyedCatalogueFamily } = await import('../../models/roads/catalogueOnDemand.js')
  if (isKeyedCatalogueFamily(idOrKey)) return idOrKey
  const { declaredRouteOf } = await import('../../models/roads/routeLaw.js')
  const route = declaredRouteOf(idOrKey)
  return route !== null && isKeyedCatalogueFamily(route) ? route : null
}

async function readLocalDiscoveryIfUnlisted(idOrKey: string): Promise<boolean> {
  const { declaredRouteOf } = await import('../../models/roads/routeLaw.js')
  if (idOrKey !== 'local' && declaredRouteOf(idOrKey) !== 'local') return false
  const { localRecordFor } = await import('../../models/roads/local/localCatalogue.js')
  const { getCachedLocalDiscovery, refreshLocalDiscovery } = await import('../../models/roads/local/localDiscovery.js')
  const listed = idOrKey === 'local' ? (getCachedLocalDiscovery()?.servers.some(server => server.models.length > 0) ?? false) : localRecordFor(idOrKey) !== undefined
  if (listed) return false
  const snapshot = await refreshLocalDiscovery({ force: true }).catch(passedOverAs(null))
  const { localProbeTargets } = await import('../../models/roads/local/localDiscovery.js')
  logForDebugging(`[local admission] ${idOrKey} unlisted → re-probed ${localProbeTargets().map(target => `${target.kind}=${target.root}`).join(', ') || 'no targets'} → ${snapshot === null ? 'the probe threw' : snapshot.servers.map(server => `${server.kind} ${server.root} (${server.models.length})`).join(', ') || 'no server answered'}`)
  return true
}

export async function validateWorkerModelChoice(
  idOrKey: string | undefined,
  arm: WorkerDispatchArm,
  reads: WorkerRegistryReads = {},
): Promise<WorkerModelValidation> {
  if (idOrKey !== undefined) {
    const family = await admissionNamesKeyedFamily(idOrKey)
    if (family !== null && (await (await import('../../models/roads/catalogueOnDemand.js')).readCatalogueIfPending(family))) {
      resetComputedDefaultMemo()
    }
    if (await readLocalDiscoveryIfUnlisted(idOrKey)) resetComputedDefaultMemo()
  }
  if (idOrKey !== undefined && SEAT_FAMILY_WORDS.has(idOrKey) && familySeatSetting(idOrKey) === undefined) {
    if (idOrKey === 'gemini') {
      const { getGeminiAvailability } = await import('../../models/roads/gemini/geminiCatalogue.js')
      const availability = getGeminiAvailability()
      if (availability.state === 'ready' || availability.why !== 'no-account') {
        const why = availability.state === 'ready' ? 'no-selectable-models' : availability.why
        return {
          ok: false,
          reason: `not-runnable:${why}`,
          detail: availability.state === 'ready'
            ? 'the live Gemini catalogue has no selectable model for this launch'
            : availability.reason,
          action: why === 'auth-invalid'
            ? loginsActionFor('gemini')
            : why === 'traffic-off'
              ? 'unset MERCURY_DISABLE_NONESSENTIAL_TRAFFIC, then retry /model'
              : why === 'catalogue-pending' || why === 'catalogue-error'
                ? 'retry the catalogue from /model, or /model <id> names a model directly'
                : 'choose another source through /logins gemini, or another family through /model',
        }
      }
    }
    if (idOrKey === 'local') {
      return { ok: false, reason: 'unreachable:local', detail: 'no local server is discovered on this box', action: loginsActionFor(idOrKey) }
    }
    if (idOrKey === 'openai-compat') {
      const compatResult = compatReaderFor()
      if (!compatResult.ok) {
        return { ok: false, reason: 'not-runnable:compat-error', detail: compatResult.detail }
      }
      return {
        ok: false,
        reason: `no-credential:${idOrKey}`,
        detail: `the ${idOrKey} family holds no usable sign-in on this account`,
        action: noCredentialAction(idOrKey, compatResult.reader.refusalEndpoint()),
      }
    }
    return {
      ok: false,
      reason: `no-credential:${idOrKey}`,
      detail: `the ${idOrKey} family holds no usable sign-in on this account`,
      action: noCredentialAction(idOrKey),
    }
  }
  const registry = await composeWorkerModelRegistry(reads)
  const defaultId = await canonicalWorkerModelId(defaultWorkerModelId(registry, arm))
  const id = idOrKey === undefined ? defaultId : await canonicalWorkerModelId(idOrKey)
  const defaultDispatches = registry.entries.find(e => e.modelId === defaultId)?.[arm].availability === 'available'
  const unnamed = idOrKey === undefined || (id === defaultId && defaultDispatches)
  let entry = registry.entries.find(e => e.modelId === id)
  if (!entry) {
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
      const { declaredRouteOf } = await import('../../models/roads/routeLaw.js')
      const route = declaredRouteOf(id)
      if (route === null) {
        return {
          ok: false,
          reason: 'not-runnable:unrecognised',
          detail: `no provider family declares '${id}'`,
          action: unrecognisedRefusalAction(),
        }
      }
      const { isModelAllowed } = await import('../../models/catalogue/modelAllowlist.js')
      if (!isModelAllowed(id)) {
        return {
          ok: false,
          reason: 'not-runnable:not-allowed',
          detail: `'${id}' is outside this organization's engine.roster`,
          action: unrecognisedRefusalAction(),
        }
      }
      const credentials = await readCredentialPresences()
      const arms = composeArms(id, credentials, route)
      const verdict = arms[arm]
      if (verdict.availability !== 'available') {
        return {
          ok: false,
          reason: verdict.refusal,
          ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
          ...(verdict.action !== undefined ? { action: verdict.action } : {}),
        }
      }
      const synthesized: WorkerModelEntryV1 = {
        modelId: id,
        displayName: id,
        ...arms,
        ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      }
      return { ok: true, entry: synthesized }
    }
  }
  const verdict = entry[arm]
  if (verdict.availability !== 'available') {
    if (unnamed) {
      const noAccount = await unnamedLaunchNoAccount(verdict.refusal)
      if (noAccount !== undefined) {
        if (arm === 'session' && idOrKey === undefined) return { ok: true, entry: { ...entry, displayName: NO_SIGN_IN_ROW }, keyless: true }
        return { ok: false, ...noAccount }
      }
      if (arm === 'session' && idOrKey === undefined) {
        const { computedDefault } = require('../../models/catalogue/computedDefault.js') as typeof import('../../models/catalogue/computedDefault.js')
        const decision = computedDefault()
        if (decision.source === 'keyless' && decision.considered.length > 0) {
          return { ok: true, entry: { ...entry, displayName: NO_USABLE_ROW }, keyless: true, note: `${NO_USABLE_ROW} — ${keylessReason(decision)}` }
        }
      }
    }
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
    const { computedDefault } = await import('../../models/catalogue/computedDefault.js')
    const credentials = await readCredentialPresences()
    const anyCredentialed = [...credentials.values()].some(present => present === true)
    return noAccountRefusal(refusal, computedDefault().provider ?? undefined, anyCredentialed)
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

async function unnamedLaunchDrift(refusal: WorkerModelRefusal): Promise<{ detail: string; action: string } | undefined> {
  try {
    const { computedDefault } = await import('../../models/catalogue/computedDefault.js')
    const credentials = await readCredentialPresences()
    return defaultProviderDriftNote(refusal, computedDefault().provider ?? undefined, family => credentials.get(family) === true)
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

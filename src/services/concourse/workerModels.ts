
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { canonicalCoordinatorModelId } from './coordinatorModels.js'

export type WorkerModelRefusal =
  | 'worker-policy:frontier-only'
  | 'not-integrated:worker-engine'
  | `no-credential:${string}`
  | `unreachable:${string}`
  | 'withdrawn-at-provider'
  | `not-runnable:${string}`

export type WorkerDispatchArm = 'session' | 'crew'

export type WorkerArmAvailabilityV1 =
  | { availability: 'available' }
  | { availability: 'refused'; refusal: WorkerModelRefusal; detail?: string; action?: string }

export interface WorkerModelEntryV1 {
  modelId: string
  displayName: string
  session: WorkerArmAvailabilityV1
  crew: WorkerArmAvailabilityV1
  effort?: 'high'
  isOperatorDefault?: true
}

export interface WorkerModelRegistryV1 {
  schema: 1
  entries: WorkerModelEntryV1[]
}

const WORKER_MODEL_LEGACY_KEY_NAMES = new Set(['opus', 'sonnet', 'fable', 'fable51'])

const FRONTIER_FAMILY = /^claude-(opus|sonnet|fable)-/
const ECONOMY_FAMILY = /^claude-haiku|^claude-\d+-haiku|haiku/i

const LOGINS_FAMILY_WORDS = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'])
export function loginsActionFor(family: string): string {
  if (LOGINS_FAMILY_WORDS.has(family)) return `ask the operator to run /logins ${family}`
  if (family === 'openai-compat') return 'ask the operator to set MERCURY_COMPAT_BASE_URL (and MERCURY_COMPAT_API_KEY, or /router key compat)'
  if (family === 'local') return 'ask the operator to start a local server, or set MERCURY_LOCAL_BASE_URL'
  return 'ask the operator to run /logins'
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
  const { providerDisplayName } = require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
  return {
    detail: `the operator's default provider is ${providerDisplayName(configuredProvider)}, which holds no credential on this account any more, so the unnamed launch fell to the ${fellTo} family — which holds none either`,
    action: `${loginsActionFor(configuredProvider)} (their default provider), or /defaultprovider picks another`,
  }
}

export const NO_ACCOUNT_REFUSAL = 'no-credential:any' satisfies WorkerModelRefusal
export const NO_ACCOUNT_DETAIL = 'no provider is signed in on this account'
export const NO_ACCOUNT_ACTION = '/logins to choose an account, or /router key <provider> to connect an API key'

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
  const { providerFamilyPresences } = await import('../providers/providerUsage.js')
  const map = new Map<string, boolean>()
  for (const presence of providerFamilyPresences()) {
    map.set(presence.id, presence.credentialed)
  }
  return map
}

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
  }
  return plain
}

function composeArms(
  modelId: string,
  credentials: CredentialReads,
  route: string,
): { session: WorkerArmAvailabilityV1; crew: WorkerArmAvailabilityV1 } {
  if (route === 'unrecognised') {
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
          availability: 'refused',
          refusal: 'unreachable:local',
          detail: 'no local server is discovered on this box',
          action: loginsActionFor(route),
        }
      : {
          availability: 'refused',
          refusal: `no-credential:${route}`,
          detail: `the ${route} family holds no credential on this account`,
          action: loginsActionFor(route),
        }
  if (ECONOMY_FAMILY.test(modelId)) {
    return {
      session,
      crew: {
        availability: 'refused',
        refusal: 'worker-policy:frontier-only',
        detail: 'crew seats run the frontier families',
        action: 'pick opus, sonnet or fable for a crew seat',
      },
    }
  }
  if (FRONTIER_FAMILY.test(modelId)) {
    return { session, crew: session }
  }
  return {
    session,
    crew: {
      availability: 'refused',
      refusal: 'not-integrated:worker-engine',
      detail: 'the crew runtimes run Anthropic frontier seats today',
      action: 'pick opus, sonnet or fable for a crew seat',
    },
  }
}

export function foldLegacyWorkerModelKey(idOrKey: string): string {
  return WORKER_MODEL_LEGACY_KEY_NAMES.has(idOrKey) ? parseUserSpecifiedModel(idOrKey) : idOrKey
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
  let operatorDefaultId: string | undefined
  try {
    const { getMainLoopModel } = await import('../../utils/model/model.js')
    operatorDefaultId = await canonicalWorkerModelId(getMainLoopModel())
  } catch {
  }
  for (const o of getModelOptions()) {
    const v = typeof o.value === 'string' ? o.value : null
    if (!v || v.startsWith('__')) continue
    const modelId = await canonicalWorkerModelId(v)
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const displayName = typeof o.label === 'string' && o.label.length > 0 ? o.label : modelId
    const operatorMark = modelId === operatorDefaultId ? ({ isOperatorDefault: true } as const) : {}
    const arms = composeArms(modelId, credentials, declaredRouteOf(modelId) ?? 'unrecognised')
    entries.push({
      modelId,
      displayName,
      ...arms,
      ...(arms.session.availability === 'available' ? ({ effort: 'high' } as const) : {}),
      ...operatorMark,
    })
  }
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

export function defaultWorkerModelId(registry: WorkerModelRegistryV1, arm: WorkerDispatchArm): string {
  const operatorDefault = registry.entries.find(e => e.isOperatorDefault === true && e[arm].availability === 'available')
  if (operatorDefault !== undefined) return operatorDefault.modelId
  const firstAvailable = registry.entries.find(e => e[arm].availability === 'available')
  if (firstAvailable !== undefined) return firstAvailable.modelId
  return registry.entries[0]?.modelId ?? foldLegacyWorkerModelKey('fable')
}

export type WorkerModelValidation =
  | { ok: true; entry: WorkerModelEntryV1 }
  | {
      ok: false
      reason: 'unknown-model' | WorkerModelRefusal
      detail?: string
      action?: string
    }

export async function validateWorkerModelChoice(idOrKey: string | undefined, arm: WorkerDispatchArm): Promise<WorkerModelValidation> {
  const registry = await composeWorkerModelRegistry()
  const defaultId = await canonicalWorkerModelId(defaultWorkerModelId(registry, arm))
  const id = idOrKey === undefined ? defaultId : await canonicalWorkerModelId(idOrKey)
  const unnamed = idOrKey === undefined || id === defaultId
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
      const { declaredRouteOf } = await import('../providers/routeLaw.js')
      const route = declaredRouteOf(id)
      if (route === null) {
        return {
          ok: false,
          reason: 'not-runnable:unrecognised',
          detail: `no provider family declares '${id}'`,
          action: unrecognisedRefusalAction(),
        }
      }
      if (route !== 'anthropic') {
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
          action: loginsActionFor(route),
        }
      }
      const dispatchable = registry.entries
        .filter(e => e[arm].availability === 'available')
        .map(e => e.modelId)
        .slice(0, 8)
        .join(' · ')
      const nearest = candidates[0]?.modelId
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
    if (unnamed) {
      const noAccount = await unnamedLaunchNoAccount(verdict.refusal)
      if (noAccount !== undefined) return { ok: false, ...noAccount }
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

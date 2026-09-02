import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  classifyModelRoute,
  COMPAT_MODEL_PREFIX,
  PROVIDER_ID_SPACES,
  qualifiedIdSpaceOf,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './idSpaces.js'

export {
  classifyModelRoute,
  COMPAT_MODEL_PREFIX,
  PROVIDER_ID_SPACES,
  isQualifiedProviderId,
  qualifiedIdSpaceOf,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './idSpaces.js'

const PROVIDER_DISPLAY_NAMES: Record<CallModelRoute, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'Z.AI',
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  'openai-compat': 'Custom endpoint',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  huggingface: 'Hugging Face',
  local: 'Local models',
}

export function providerDisplayName(route: string): string {
  return (PROVIDER_DISPLAY_NAMES as Record<string, string>)[route] ?? route
}

export function declaredRouteOf(
  model: string,
  env?: Record<string, string | undefined>,
): CallModelRoute | null {
  const verdict = classifyModelRoute(model, env)
  return verdict.kind === 'route' ? verdict.route : null
}

export function laneLabelForVerdict(
  verdict: ModelRouteVerdict,
  opts?: { rode?: boolean },
): string {
  switch (verdict.kind) {
    case 'route':
      return providerDisplayName(verdict.route)
    case 'unrecognised':
      return opts?.rode === true ? 'Gateway (Anthropic-compatible)' : 'Unrecognised'
    case 'absence':
      return 'unset'
  }
}

export function isCompatModelId(model: string): boolean {
  return normalizedRaw(model).startsWith(COMPAT_MODEL_PREFIX)
}

function normalizedRaw(model: string): string {
  return model.trim().toLowerCase()
}

export function stripCompatModelPrefix(model: string): string {
  const trimmed = model.trim()
  return trimmed.toLowerCase().startsWith(COMPAT_MODEL_PREFIX)
    ? trimmed.slice(COMPAT_MODEL_PREFIX.length)
    : trimmed
}

export function qualifiedWireId(model: string): string {
  const trimmed = model.trim()
  const lowered = trimmed.toLowerCase()
  for (const space of PROVIDER_ID_SPACES) {
    if (space.qualifiedPrefix && lowered.startsWith(space.qualifiedPrefix)) {
      return trimmed.slice(space.qualifiedPrefix.length)
    }
  }
  return trimmed
}


export type WireIdVerdict =
  | {
      ok: true
      wireId: string
      healed?: true
    }
  | {
      ok: false
      reason: string
    }

const MERCURY_ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export function canonicalWireModelId(model: string): WireIdVerdict {
  const trimmed = model.trim()
  const space = qualifiedIdSpaceOf(trimmed)
  if (space?.qualifiedPrefix === undefined) {
    const wireId = normalizeModelStringForAPI(trimmed)
    if (wireId.includes('/')) {
      return {
        ok: false,
        reason: `'${trimmed}' is not a dispatchable model id on this lane — bare-family ids carry no '/'. Carrier catalogue rows persist provider-qualified (openrouter/<vendor>/<model> · huggingface/<org>/<model> · compat/<id> · local/<name>); the /model picker lists the live catalogues.`,
      }
    }
    return wireId === trimmed ? { ok: true, wireId } : { ok: true, wireId, healed: true }
  }
  const inner = trimmed.slice(space.qualifiedPrefix.length)
  const stripped = inner.replace(MERCURY_ANNOTATION_RE, '')
  const healed = stripped !== inner
  if (stripped === '') {
    return { ok: false, reason: `'${trimmed}' names no model inside the ${space.route} namespace — the /model picker lists the live catalogue.` }
  }
  if (space.innerGrammar === 'segments-2') {
    if (/[[\]]/.test(stripped)) {
      return {
        ok: false,
        reason: `'${trimmed}' carries display dressing ('${stripped.match(/\[[^\]]*\]?/)?.[0] ?? '['}…') that is not part of any catalogue id — pick the row again from /model (ids persist as ${space.qualifiedPrefix}<vendor>/<model>).`,
      }
    }
    const segments = stripped.split('/')
    if (segments.length !== 2 || segments.some(s => s === '')) {
      return {
        ok: false,
        reason: `'${trimmed}' is not a dispatchable ${space.route} id — the catalogue's ids are exactly <vendor>/<model> under the ${space.qualifiedPrefix} namespace${segments.length > 2 ? ` and '${stripped}' composes a second vendor prefix onto an already carrier-shaped id` : ''}. The /model picker lists the live catalogue.`,
      }
    }
    return healed ? { ok: true, wireId: stripped, healed: true } : { ok: true, wireId: stripped }
  }
  if (stripped.toLowerCase().startsWith(space.qualifiedPrefix)) {
    return {
      ok: false,
      reason: `'${trimmed}' nests the ${space.qualifiedPrefix} namespace inside itself — a composed id was re-prefixed. Name the model once (${space.qualifiedPrefix}<id>).`,
    }
  }
  return healed ? { ok: true, wireId: stripped, healed: true } : { ok: true, wireId: stripped }
}

export function healListedCatalogueRowId(
  rowId: string,
  listed: ReadonlySet<string>,
): string | undefined {
  const raw = rowId.trim()
  const stripped = raw.replace(MERCURY_ANNOTATION_RE, '')
  if (stripped !== raw && listed.has(stripped)) return stripped
  const peeled = stripped.includes('/') ? stripped.slice(stripped.indexOf('/') + 1) : undefined
  if (peeled !== undefined && peeled !== raw && listed.has(peeled)) return peeled
  return undefined
}

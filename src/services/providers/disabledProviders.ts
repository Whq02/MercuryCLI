import { getInitialSettings } from '../../utils/settings/settings.js'
import { classifyModelRoute, PROVIDER_ID_SPACES, type CallModelRoute } from './idSpaces.js'
import { providerDisplayName } from './routeLaw.js'

const KNOWN_PROVIDERS: ReadonlySet<CallModelRoute> = new Set([
  'anthropic',
  ...PROVIDER_ID_SPACES.map(space => space.route),
])

export function normalizeDisabledProviderId(raw: string): CallModelRoute | undefined {
  const lowered = raw.trim().toLowerCase()
  if (!lowered) return undefined
  if (lowered === 'claude' || lowered === 'claudeai' || lowered === 'console') return 'anthropic'
  if (lowered === 'gpt') return 'openai'
  if (lowered === 'kimi') return 'moonshot'
  if (lowered === 'glm') return 'zai'
  if (lowered === 'grok') return 'xai'
  if (lowered === 'muse') return 'meta'
  if (lowered === 'compat') return 'openai-compat'
  if (KNOWN_PROVIDERS.has(lowered as CallModelRoute)) return lowered as CallModelRoute
  return undefined
}

export interface DisabledProvidersConfig {
  disabled: ReadonlySet<CallModelRoute>
  unknown: string[]
}

export function resolveDisabledProviders(): DisabledProvidersConfig {
  const raw = (getInitialSettings().engine as { disabledProviders?: unknown } | undefined)?.disabledProviders
  if (!Array.isArray(raw) || raw.length === 0) return { disabled: new Set(), unknown: [] }
  const disabled = new Set<CallModelRoute>()
  const unknown: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const normalized = normalizeDisabledProviderId(trimmed)
    if (normalized) disabled.add(normalized)
    else if (!unknown.includes(trimmed)) unknown.push(trimmed)
  }
  return { disabled, unknown }
}

export function isProviderDisabled(provider: string | null | undefined): boolean {
  if (!provider) return false
  const normalized = normalizeDisabledProviderId(provider)
  if (!normalized) return false
  return resolveDisabledProviders().disabled.has(normalized)
}

export function isModelFromDisabledProvider(model: string | null | undefined): boolean {
  if (!model || !model.trim()) return false
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'route') return isProviderDisabled(verdict.route)
  return false
}

export function disabledProvidersHealthSummary(): { status: 'info'; evidence: string } | undefined {
  const { disabled, unknown } = resolveDisabledProviders()
  if (disabled.size === 0 && unknown.length === 0) return undefined
  const parts: string[] = []
  if (disabled.size > 0) {
    const names = [...disabled].map(id => `${providerDisplayName(id)} (${id})`).join(', ')
    parts.push(`disabled in engine.disabledProviders: ${names} (rows omitted from /model and mercury://models; stored keys untouched; active sessions keep running)`)
  }
  if (unknown.length > 0) {
    parts.push(`unknown provider name(s) in engine.disabledProviders ignored: ${unknown.join(', ')}`)
  }
  return { status: 'info', evidence: parts.join(' · ') }
}

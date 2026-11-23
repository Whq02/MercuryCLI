import { flagEnv } from '../substrate/flagRegistry.js'
import { getGlobalConfig } from './config.js'
import { getSettingsForSource } from './settings.js'
import { CompatEndpointSchema, CompatProviderSchema, type CompatEndpointSettings } from './compatProvider.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'

export interface CompatEndpoint extends CompatEndpointSettings {
  name: string
  named: boolean
  baseUrl: string
  label: string
  models: string[]
}

function configBlock(): unknown {
  let block: unknown
  try {
    block = getGlobalConfig().compatProvider
  } catch (error) { passedOver(error) }
  for (const source of ['userSettings', 'flagSettings', 'policySettings'] as const) {
    const value = getSettingsForSource(source)?.compatProvider
    if (value !== undefined) block = value
  }
  return block ?? {}
}

export function configuredCompatEndpoints(env: NodeJS.ProcessEnv = hostEnv()): CompatEndpoint[] {
  const parsed = CompatProviderSchema().safeParse(configBlock())
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`compatProvider${issue?.path.length ? `.${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid endpoint settings'}`)
  }
  const block = parsed.data
  const named = !CompatEndpointSchema().safeParse(block).success
  const entries: Array<[string, CompatEndpointSettings]> = named
    ? Object.entries(block) as Array<[string, CompatEndpointSettings]>
    : [['default', block as CompatEndpointSettings]]
  if (named && !Object.hasOwn(block, 'default') && flagEnv('MERCURY_COMPAT_BASE_URL', env)?.trim()) entries.unshift(['default', {}])
  const endpoints: CompatEndpoint[] = []
  for (const [name, entry] of entries) {
    const baseUrl = (name === 'default' ? flagEnv('MERCURY_COMPAT_BASE_URL', env)?.trim() || entry.baseUrl?.trim() : entry.baseUrl?.trim())?.replace(/\/+$/, '')
    if (!baseUrl) continue
    const validated = CompatProviderSchema().safeParse({ baseUrl })
    if (!validated.success) throw new Error(`compatProvider.${name}.baseUrl: must be an http(s) URL without credentials, query or fragment`)
    const label = (name === 'default' ? flagEnv('MERCURY_COMPAT_LABEL', env)?.trim() : undefined) || entry.label?.trim() || (named ? name : 'Custom endpoint')
    const envModels = name === 'default' ? flagEnv('MERCURY_COMPAT_MODELS', env)?.trim() : undefined
    const models = envModels ? envModels.split(',').map(id => id.trim()).filter(Boolean) : (entry.models ?? []).map(id => id.trim()).filter(Boolean)
    endpoints.push({ ...entry, name, named, baseUrl, label, models })
  }
  return endpoints
}

import { getSecureStorage } from '../utils/secureStorage/index.js'
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js'
import type { ManifestNeeds, ManifestOption } from './manifest.js'
import { getExtensionDataDir } from './paths.js'

export type OptionValue = string | number | boolean | string[]
export type OptionValues = Record<string, OptionValue>

const ROOT_RE = /\$\{MERCURY_EXTENSION_ROOT\}/g
const DATA_RE = /\$\{MERCURY_EXTENSION_DATA\}/g
const OPTION_RE = /\$\{option\.([A-Za-z_][A-Za-z0-9_]*)\}/g

export function substituteRootAndData(text: string, root: string, id: string): string {
  const data = getExtensionDataDir(id)
  return text.replace(ROOT_RE, () => root).replace(DATA_RE, () => data)
}

export function substituteOptionsInCommand(text: string, values: OptionValues): string {
  return text.replace(OPTION_RE, (whole, key: string) => {
    const value = values[key]
    return value === undefined ? whole : String(value)
  })
}

export function substituteOptionsInContent(
  text: string,
  values: OptionValues,
  schema: NonNullable<ManifestNeeds['options']> | undefined,
): string {
  return text.replace(OPTION_RE, (whole, key: string) => {
    const declared = schema?.[key]
    if (declared?.sensitive) return `<option ${key}: set by the operator, not shown>`
    const value = values[key]
    return value === undefined ? whole : String(value)
  })
}

export const OPTION_ENV_PREFIX = 'MERCURY_EXTENSION_OPTION_'

export function optionEnvName(key: string): string {
  return `${OPTION_ENV_PREFIX}${key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`
}


type SecretsBlob = { extensionSecrets?: Record<string, Record<string, string>> }

export function loadOptionValues(id: string, schema: NonNullable<ManifestNeeds['options']> | undefined): OptionValues {
  const values: OptionValues = {}
  for (const [key, option] of Object.entries(schema ?? {})) {
    if (option.default !== undefined) values[key] = option.default as OptionValue
  }
  const fromSettings = getSettings_DEPRECATED().extensions?.options?.[id]
  if (fromSettings && typeof fromSettings === 'object') {
    for (const [key, value] of Object.entries(fromSettings)) {
      if (value !== undefined && value !== null) values[key] = value as OptionValue
    }
  }
  const secure = (getSecureStorage().read() ?? {}) as SecretsBlob
  const secrets = secure.extensionSecrets?.[id]
  if (secrets) for (const [key, value] of Object.entries(secrets)) values[key] = value
  return values
}

export function isOptionSet(id: string, schema: NonNullable<ManifestNeeds['options']> | undefined, key: string): boolean {
  const values = loadOptionValues(id, schema)
  const value = values[key]
  return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
}

export function saveOptionValues(
  id: string,
  schema: NonNullable<ManifestNeeds['options']> | undefined,
  values: OptionValues,
): { ok: true } | { ok: false; error: string } {
  const plain: Record<string, OptionValue> = {}
  const sensitive: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const declared: ManifestOption | undefined = schema?.[key]
    if (declared?.sensitive) sensitive[key] = String(value)
    else plain[key] = value
  }
  if (Object.keys(sensitive).length > 0) {
    const storage = getSecureStorage()
    const current = (storage.read() ?? {}) as SecretsBlob
    const all = { ...(current.extensionSecrets ?? {}) }
    all[id] = { ...(all[id] ?? {}), ...sensitive }
    const wrote = storage.update({ ...current, extensionSecrets: all })
    if (!wrote.success) return { ok: false, error: `secure store write failed for ${id}` }
  }
  if (Object.keys(plain).length > 0) {
    const existing = getSettings_DEPRECATED().extensions?.options?.[id] ?? {}
    const { error } = updateSettingsForSource('userSettings', {
      extensions: { options: { [id]: { ...existing, ...plain } } },
    } as never)
    if (error) return { ok: false, error: `settings write failed for ${id}: ${String(error)}` }
  }
  return { ok: true }
}

export function deleteOptionValues(id: string): void {
  const storage = getSecureStorage()
  const current = (storage.read() ?? {}) as SecretsBlob & Record<string, unknown>
  if (current.extensionSecrets && current.extensionSecrets[id] !== undefined) {
    const rest = { ...current.extensionSecrets }
    delete rest[id]
    const next: Record<string, unknown> = { ...current }
    if (Object.keys(rest).length > 0) next['extensionSecrets'] = rest
    else delete next['extensionSecrets']
    if (Object.keys(next).length === 0) storage.delete()
    else storage.update(next as SecretsBlob)
  }
  if (getSettings_DEPRECATED().extensions?.options?.[id] !== undefined) {
    updateSettingsForSource('userSettings', { extensions: { options: { [id]: undefined } } } as never)
  }
}

export function optionEnv(values: OptionValues): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) env[optionEnvName(key)] = Array.isArray(value) ? value.join(',') : String(value)
  return env
}

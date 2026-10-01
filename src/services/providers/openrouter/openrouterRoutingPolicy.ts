import type { SettingsJson } from '../../../utils/settings/types.js'

export function openrouterProviderObject(setting: SettingsJson['openrouterRouting'] = {}): Record<string, unknown> | undefined {
  const provider = {
    ...((setting.dataCollection ?? 'deny') === 'deny' ? { data_collection: 'deny' } : {}),
    ...((setting.requireParameters ?? true) ? { require_parameters: true } : {}),
    ...(setting.allowFallbacks === false ? { allow_fallbacks: false } : {}),
    ...(setting.zeroDataRetention === true ? { zdr: true } : {}),
  }
  return Object.keys(provider).length === 0 ? undefined : provider
}

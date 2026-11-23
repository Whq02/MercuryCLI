import { getGlobalConfig, isConfigReadingAllowed } from '../../platform/settings/config.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { MiniMaxVideoProvider, MINIMAX_VIDEO_MODEL, videoBaseUrl } from './minimax.js'
import { VideoProviderSettingsSchema, type VideoProviderConfig, type VideoProviderSettings } from '../video-shapes/types.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const VIDEO_SETUP = 'Video has no provider configured. First, /logins minimax stores an Open Platform pay-as-you-go API key. Then add videoProvider.<name> = { kind: "minimax" } to settings.'

function configuredVideoProviders(): VideoProviderSettings {
  const stored = getInitialSettings().videoProvider ?? (isConfigReadingAllowed() ? getGlobalConfig().videoProvider : undefined)
  return stored === undefined ? {} : VideoProviderSettingsSchema.parse(stored)
}

export function videoToolEnabled(): boolean {
  try {
    return Object.keys(configuredVideoProviders()).length > 0
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function videoProviderReadError(): string | null {
  try {
    configuredVideoProviders()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function videoProviderSelection(name?: string): { name: string; config: VideoProviderConfig; baseUrl: string; model: string } {
  const providers = configuredVideoProviders()
  const names = Object.keys(providers)
  if (names.length === 0) throw new Error(VIDEO_SETUP)
  const selected = name ?? (names.length === 1 ? names[0] : undefined)
  if (!selected) throw new Error(`Video needs provider: choose one of ${names.join(', ')}.`)
  const config = providers[selected]
  if (!config) throw new Error(`Video provider '${selected}' is not configured; choose one of ${names.join(', ')}.`)
  return { name: selected, config, baseUrl: videoBaseUrl(config.baseUrl), model: config.model ?? MINIMAX_VIDEO_MODEL }
}

export function createVideoProvider(selection: ReturnType<typeof videoProviderSelection>): MiniMaxVideoProvider {
  return new MiniMaxVideoProvider(selection.baseUrl)
}

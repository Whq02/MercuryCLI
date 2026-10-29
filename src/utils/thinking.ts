import { getInitialSettings } from './settings/settings.js'
import { flagEnv } from '../substrate/flagRegistry.js'


export { modelSupportsAdaptiveThinking, modelSupportsThinking } from './model/capabilities.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

export function shouldEnableThinkingByDefault(): boolean {
  const envValue = flagEnv('MERCURY_THINKING_BUDGET')
  if (envValue !== undefined && envValue !== '') {
    const parsed = parseInt(envValue, 10)
    return parsed > 0
  }
  if (getInitialSettings().engine?.reasoning === false) {
    return false
  }
  return true
}

let notedThinkingConfig: ThinkingConfig | undefined

export function noteSessionThinkingConfig(config: ThinkingConfig): void {
  notedThinkingConfig = config
}

export function sessionThinkingConfig(): ThinkingConfig {
  return notedThinkingConfig ?? (shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' })
}

export function sessionThinkingEnabled(): boolean {
  return sessionThinkingConfig().type !== 'disabled'
}

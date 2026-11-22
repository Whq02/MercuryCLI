import { getInitialSettings } from './settings/settings.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export { modelSupportsAdaptiveThinking, modelSupportsThinking } from './model/capabilities.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'disabled' }
  | { type: 'enabled'; budgetTokens: number }

export function shouldEnableThinkingByDefault(): boolean {
  const budget = flagEnv('MERCURY_THINKING_BUDGET')
  if (budget) return Number.parseInt(budget, 10) > 0
  return getInitialSettings().engine?.reasoning !== false
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

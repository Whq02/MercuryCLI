import { getInitialSettings } from './settings/settings.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export { modelSupportsAdaptiveThinking, modelSupportsThinking } from './model/capabilities.js'

export type ThinkingConfig = Unbuilt

export function shouldEnableThinkingByDefault(): boolean {
  return notBuilt('src/utils/thinking.ts:12')
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

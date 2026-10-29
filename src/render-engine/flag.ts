
import { flagEnabled } from '../substrate/flagRegistry.js'

export function renderEngineEnabled(): boolean {
  return flagEnabled('MERCURY_RENDER_ENGINE')
}

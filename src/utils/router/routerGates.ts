import { flagEnabled } from '../../substrate/flagRegistry.js'

export function routerEnabled(): boolean {
  return flagEnabled('MERCURY_ROUTER')
}

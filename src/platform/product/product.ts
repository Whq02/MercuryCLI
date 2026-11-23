import { passedOver } from '../errors/passedOver.js'

function resolveMercuryVersion(): string {
  if (typeof MACRO !== 'undefined' && MACRO.VERSION) return MACRO.VERSION
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch (error) {
    passedOver(error)
  }
  return '0.0.0-src'
}
export const MERCURY_VERSION: string = resolveMercuryVersion()

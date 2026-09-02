
function resolveMercuryVersion(): string {
  if (typeof MACRO !== 'undefined' && MACRO.VERSION) return MACRO.VERSION
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch {
  }
  return '0.0.0-src'
}
export const MERCURY_VERSION: string = resolveMercuryVersion()

export const versionBanner = `Mercury ${MERCURY_VERSION}`

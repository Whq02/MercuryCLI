// (The borrowed external-product URL constant was DELETED by OP-4,
// the operator overrode the recorded cohort-anonymity keep —
// Mercury-owned MCP connections now identify as Mercury with NO borrowed
// product URL. The Anthropic-API UA keep-at-leaf lives in utils/userAgent.ts.)

/**
 * Mercury's release version — THE product version. build.ts's MACRO_VERSION
 * carries this SAME
 * value as the build-time define, and prove-version-identity.ts pins the two
 * equal (plus the cli.tsx --version fast-path, which keeps a zero-import
 * inline copy on purpose).
 */
// The ONE version root is package.json: the build injects it as the
// MACRO.VERSION define (dist path — folds to a literal). SRC-RUN contexts
// (bun proofs / scripts importing src directly) have no define unless they
// set the stamp-sim global, and product.ts is imported near-universally —
// a bare module-scope MACRO read crashed 19 proof suites, so
// the src path falls back to reading package.json itself. Same value, one
// authority either way.
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
    // fall through to the honest src-run stub
  }
  return '0.0.0-src'
}
export const MERCURY_VERSION: string = resolveMercuryVersion()

/** The version banner shown by `--version` / commander's .version(). */
export const versionBanner = `Mercury ${MERCURY_VERSION}`

// Mercury Remote session URLs



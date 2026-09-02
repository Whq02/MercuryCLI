#!/usr/bin/env bun
// ============================================================================
//  scripts/build-identity/prove-version-identity.ts
//  PROOF: the SINGLE Mercury version identity. MACRO.VERSION (build.ts define) and MERCURY_VERSION (product.ts)
//  carry ONE value, and every surface renders it.
//
//   1. ONE ROOT — build.ts MACRO_VERSION === product.ts MERCURY_VERSION.
//   2. Banner — versionBanner = `Mercury ${MERCURY_VERSION}` (no engine tag).
//   3. cli.tsx fast-path — the zero-import inline copy renders
//      `Mercury ${MACRO.VERSION}` (same value by 1).
//   4. Home logo — displays MERCURY_VERSION.
//   5. Machine seams — systemInit mercury_version
//      stay MACRO.VERSION (protocol consumers read the app version there).
//   6. THE BOOTED IDENTITY: when
//      dist/mercury.mjs exists, actually RUN `node dist/mercury.mjs --version`
//      and assert the booted banner — never a bundle substring grep.
//
//  Run:  ~/.bun/bin/bun run scripts/build-identity/prove-version-identity.ts
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
let fail = 0
const ok = (label: string) => console.log(`  ✓ ${label}`)
const bad = (label: string) => {
  console.log(`  ✗ ${label}`)
  fail = 1
}

// --- 1. ONE ROOT: build define === product version ---------------------------
const product = readFileSync(join(root, 'src/constants/product.ts'), 'utf8')
// ONE ROOT: package.json's version is the single
// authority — build.ts reads it into the MACRO.VERSION define, product.ts
// re-exports the define. Prerelease tags (1.1.0-private.N) are legal.
const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkgVersion)) ok(`package.json version = ${pkgVersion} (the one root)`)
else bad(`package.json version '${pkgVersion}' is not semver`)
const mv = pkgVersion

if (product.includes('export const MERCURY_VERSION: string = resolveMercuryVersion()') && product.includes('return MACRO.VERSION'))
  ok('product.ts MERCURY_VERSION rides MACRO.VERSION with the src-run package.json fallback (no second literal)')
else bad('product.ts must re-export the define: MERCURY_VERSION: string = MACRO.VERSION')

const buildTs = readFileSync(join(root, 'build.ts'), 'utf8')
// Pin the SEAM, not the exact symbol shape: the version root is package.json,
// read once into PKG_JSON (widened the same read to carry
// engines.node for the manifest projection) and re-exported as MACRO_VERSION.
if (
  /const PKG_JSON = JSON\.parse\(readFileSync\('\.\/package\.json'/.test(buildTs) &&
  /const MACRO_VERSION = PKG_JSON\.version/.test(buildTs)
)
  ok('build.ts MACRO_VERSION reads package.json (via PKG_JSON) — one version root')
else bad('build.ts MACRO_VERSION must read package.json (the one root)')
if (!/-hermes/.test(pkgVersion))
  ok('the version carries no -hermes engine trim (first independent build)')
else bad('the version still carries the -hermes trim')

// --- 2. banner ---------------------------------------------------------------
if (product.includes('export const versionBanner = `Mercury ${MERCURY_VERSION}`'))
  ok('versionBanner is the single-version `Mercury ${MERCURY_VERSION}`')
else bad('versionBanner must be `Mercury ${MERCURY_VERSION}` (the engine tag is retired)')

// --- 3. cli.tsx fast-path ------------------------------------------------------
const cli = readFileSync(join(root, 'src/entrypoints/cli.tsx'), 'utf8')
if (cli.includes('console.log(`Mercury ${MACRO.VERSION}`)'))
  ok('cli.tsx --version fast-path renders `Mercury ${MACRO.VERSION}` (zero-import, same root)')
else bad('cli.tsx fast-path must render `Mercury ${MACRO.VERSION}`')

// --- 4. home logo shows the Mercury version ---------------------------------
const logo = readFileSync(join(root, 'src/utils/logoV2Utils.ts'), 'utf8')
if (/process\.env\.DEMO_VERSION \?\? MERCURY_VERSION/.test(logo))
  ok('home logo (getLogoDisplayData) displays MERCURY_VERSION')
else bad('logoV2Utils.ts getLogoDisplayData must fall back to MERCURY_VERSION')

// --- 5. machine seams stay on MACRO.VERSION ----------------------------------
const sysInit = readFileSync(join(root, 'src/utils/messages/systemInit.ts'), 'utf8')
if (sysInit.includes('mercury_version: MACRO.VERSION'))
  ok('SDK init mercury_version stays MACRO.VERSION (machine seam)')
else bad('systemInit.ts mercury_version must stay MACRO.VERSION')

// The insights export is Mercury's OWN shape (no external reader): its
// version field carries the product's spelling, never the compat key.
const insights = readFileSync(join(root, 'src/commands/insights.ts'), 'utf8')
if (/mercury_version:\s*string/.test(insights) && !insights.includes('claude_code_version'))
  ok('insights export metadata names mercury_version (the product spelling)')
else bad('src/commands/insights.ts must name its version field mercury_version')

// --- 6. THE BOOTED IDENTITY ---------------------------------------------------
const dist = join(root, 'dist/mercury.mjs')
if (existsSync(dist)) {
  try {
    const out = execFileSync('node', [dist, '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`BOOTED identity: \`node dist/mercury.mjs --version\` → "${out}"`)
    else bad(`booted --version printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`booting dist/mercury.mjs --version failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 6b. The SLOW-PATH booted identity: extra args force past the cli.tsx
  // fast-path into commander, where the historical 3-flag spec
  // '-v, -V, --version' silently dropped '--version' (commander keeps one
  // short + one long flag per spec) — "error: unknown option '--version'".
  // Fixed (machinery prune): '-v, --version' + hidden -V.
  try {
    const out = execFileSync('node', [dist, '--version', 'prove-slow-path'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`SLOW-PATH booted identity: \`--version <extra-arg>\` (commander) → "${out}"`)
    else bad(`slow-path --version printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`slow-path --version errored (the commander flag-spec bug?): ${e instanceof Error ? e.message : String(e)}`)
  }
} else {
  console.log('  – dist/mercury.mjs absent — skipping the booted check (source seams proven above)')
}

console.log(fail === 0 ? '\n✅ version-identity proof PASS' : '\n❌ version-identity proof FAIL')
process.exit(fail)

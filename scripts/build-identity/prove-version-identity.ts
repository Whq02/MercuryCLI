#!/usr/bin/env bun

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

const product = readFileSync(join(root, 'src/constants/product.ts'), 'utf8')
const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkgVersion)) ok(`package.json version = ${pkgVersion} (the one root)`)
else bad(`package.json version '${pkgVersion}' is not semver`)
const mv = pkgVersion

if (product.includes('export const MERCURY_VERSION: string = resolveMercuryVersion()') && product.includes('return MACRO.VERSION'))
  ok('product.ts MERCURY_VERSION rides MACRO.VERSION with the src-run package.json fallback (no second literal)')
else bad('product.ts must re-export the define: MERCURY_VERSION: string = MACRO.VERSION')

const buildTs = readFileSync(join(root, 'build.ts'), 'utf8')
if (
  /const PKG_JSON = JSON\.parse\(readFileSync\('\.\/package\.json'/.test(buildTs) &&
  /const MACRO_VERSION = PKG_JSON\.version/.test(buildTs)
)
  ok('build.ts MACRO_VERSION reads package.json (via PKG_JSON) — one version root')
else bad('build.ts MACRO_VERSION must read package.json (the one root)')
if (!/-hermes/.test(pkgVersion))
  ok('the version carries no -hermes engine trim (first independent build)')
else bad('the version still carries the -hermes trim')

if (product.includes('export const versionBanner = `Mercury ${MERCURY_VERSION}`'))
  ok('versionBanner is the single-version `Mercury ${MERCURY_VERSION}`')
else bad('versionBanner must be `Mercury ${MERCURY_VERSION}` (the engine tag is retired)')

const cli = readFileSync(join(root, 'src/entrypoints/cli.tsx'), 'utf8')
if (cli.includes('console.log(`Mercury ${MACRO.VERSION}`)'))
  ok('cli.tsx --version fast-path renders `Mercury ${MACRO.VERSION}` (zero-import, same root)')
else bad('cli.tsx fast-path must render `Mercury ${MACRO.VERSION}`')

const logo = readFileSync(join(root, 'src/utils/logoV2Utils.ts'), 'utf8')
if (/process\.env\.MERCURY_DEMO_VERSION \?\? MERCURY_VERSION/.test(logo))
  ok('home logo (getLogoDisplayData) displays MERCURY_VERSION')
else bad('logoV2Utils.ts getLogoDisplayData must fall back to MERCURY_VERSION')

const sysInit = readFileSync(join(root, 'src/utils/messages/systemInit.ts'), 'utf8')
if (sysInit.includes('mercury_version: MACRO.VERSION'))
  ok('SDK init mercury_version stays MACRO.VERSION (machine seam)')
else bad('systemInit.ts mercury_version must stay MACRO.VERSION')

const insights = readFileSync(join(root, 'src/commands/insights.ts'), 'utf8')
if (/mercury_version:\s*string/.test(insights) && !insights.includes('claude_code_version'))
  ok('insights export metadata names mercury_version (the product spelling)')
else bad('src/commands/insights.ts must name its version field mercury_version')

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

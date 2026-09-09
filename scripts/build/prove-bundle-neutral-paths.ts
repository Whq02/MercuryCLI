#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..', '..')
const OUT = resolve(ROOT, process.env.MERCURY_BUILD_OUTDIR ?? 'dist')
const BUNDLE = resolve(OUT, 'mercury.mjs')
const NEUTRAL_VENDOR = '/mercury/vendor/'
const SEAM = /__(filename|dirname)\s*=\s*"((?:[^"\\]|\\.)*)"/g
const HOME_MODULES = /(?:\/Users|\/home|[A-Za-z]:(?:\\\\|\/)Users)(?:\/|\\\\)[^"'\s\\/]+(?:\/|\\\\)[^"'\s]*?node_modules(?:\/|\\\\)/g

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('── the built bundle carries no path of the machine that built it ──')
console.log(`  bundle: ${BUNDLE}`)
check('dist/mercury.mjs present', existsSync(BUNDLE), 'run: bun run build.ts')
if (!existsSync(BUNDLE)) process.exit(1)

const text = readFileSync(BUNDLE, 'utf8')
const seams = [...text.matchAll(SEAM)].map((m) => ({ name: `__${m[1]}`, value: m[2] ?? '' }))
const describe = (s: { name: string; value: string }): string => `${s.name}="${s.value}"`

check(
  'bundled CommonJS modules mint at least one __filename literal (the seam the build rewrites is exercised)',
  seams.some((s) => s.name === '__filename'),
  'no __filename literal found: the bundler no longer mints the seam, so this check pins nothing',
)

const leaked = seams.filter((s) => !s.value.startsWith(NEUTRAL_VENDOR))
check(
  `every minted __filename/__dirname literal sits under ${NEUTRAL_VENDOR} (${seams.length} literal${seams.length === 1 ? '' : 's'})`,
  leaked.length === 0,
  leaked.map(describe).join('; '),
)

const malformed = seams.filter((s) => s.name === '__filename' && !/^\/mercury\/vendor\/[^/]+(?:\/[^/]+)*\.(?:c?js|mjs)$/.test(s.value))
check(
  'each __filename literal is still an absolute file path naming a JavaScript file (dirname and basename keep working)',
  malformed.length === 0,
  malformed.map(describe).join('; '),
)

const homeModules = [...text.matchAll(HOME_MODULES)].map((m) => m[0])
check(
  'no home-directory node_modules path survives anywhere in the bundle text',
  homeModules.length === 0,
  [...new Set(homeModules)].slice(0, 5).join('; '),
)

if (failures === 0) {
  console.log('✅ bundle neutral-path proof passes')
  process.exit(0)
}
console.log(`❌ bundle neutral-path proof FAILED (${failures})`)
process.exit(1)

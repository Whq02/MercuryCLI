
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAllReleaseNotes, getStoredChangelog } from '../../src/utils/releaseNotes.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { version: string }).version

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) fail = 1
}

console.log('============================================================')
console.log(' /health self-recognition — proof')
console.log('============================================================')


console.log('\n[1] release notes are bundled Mercury notes (no fetch, no disk cache)')
{
  const t0 = Date.now()
  const changelog = await getStoredChangelog()
  const elapsed = Date.now() - t0
  check(`getStoredChangelog() resolves instantly (${elapsed}ms < 400)`, elapsed < 400)
  check(
    `bundled changelog is Mercury's own (names Mercury, carries ## ${PACKAGE_VERSION})`,
    changelog.includes('Mercury') && changelog.includes(`## ${PACKAGE_VERSION}`),
  )
  const parsed = getAllReleaseNotes(changelog)
  check(
    'parseable: getAllReleaseNotes() yields ≥1 versioned section with notes',
    parsed.length >= 1 && (parsed[0]?.[1].length ?? 0) >= 1,
  )
}

console.log('\n[2] the compat-changelog fetch pipeline is REMOVED (structural)')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'releaseNotes.ts'),
    'utf8',
  )
  check('no axios import in releaseNotes.ts', !src.includes('axios'))
  check('no anthropics/claude-code URL', !src.includes('anthropics/claude-code'))
  check('no raw.githubusercontent fetch target', !src.includes('raw.githubusercontent'))
  check('the retired fetchAndStoreChangelog symbol is gone', !src.includes('fetchAndStoreChangelog'))
}

console.log('\n============================================================')
console.log(fail === 0 ? ' ✅ HEALTH-LOYALTY PROOF PASS' : ' ❌ HEALTH-LOYALTY PROOF FAILED')
console.log('============================================================')
process.exit(fail)

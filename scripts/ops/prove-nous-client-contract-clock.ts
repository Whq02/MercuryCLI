import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lt, valid } from 'semver'
import * as contract from '../../src/services/providers/nous/nousClientContract.ts'
import { expectedChangeDate, readLicenceParameters, todayIso } from '../release/releaseDocuments.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const DAY = 86_400_000
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const LICENCE = readFileSync(join(ROOT, 'LICENSE.md'), 'utf8')
const AS_OF: unknown = (contract as Record<string, unknown>).NOUS_CLIENT_CONTRACT_AS_OF
const RELEASE = contract.NOUS_CLIENT_CONTRACT_RELEASE
const TODAY = todayIso()
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && expectedChangeDate(value) !== null
}

function staleDate(releaseDate: string, asOf: string): string {
  return `the release day ${releaseDate} passed the Nous client-contract constant's date ${asOf} without a check: read the Portal agent's newest release and stamp NOUS_CLIENT_CONTRACT_AS_OF`
}

function assess(licence: string, version: string, release: unknown, asOf: unknown, today: string): { findings: string[]; info: string } {
  const findings: string[] = []
  const parameters = readLicenceParameters(licence)
  const checkedDate = isDate(asOf)
  if (typeof release !== 'string' || !/^\d+\.\d+\.\d+$/.test(release)) findings.push('NOUS_CLIENT_CONTRACT_RELEASE must be a three-part release')
  if (!checkedDate) findings.push('NOUS_CLIENT_CONTRACT_AS_OF must be a real ISO date (YYYY-MM-DD)')
  else if (asOf > today) findings.push(`NOUS_CLIENT_CONTRACT_AS_OF ${asOf} is after today (${today})`)
  if (!isDate(parameters.releaseDate)) findings.push('LICENSE.md must carry a real Version Release Date')
  if (!valid(version)) findings.push('package.json must carry a release version')
  const licenceVersion = typeof parameters.version === 'string' && parameters.version.startsWith('v') ? valid(parameters.version.slice(1)) : null
  if (!licenceVersion) findings.push('LICENSE.md must carry a Version tag')
  let info = ''
  if (parameters.version === `v${version}`) {
    if (checkedDate && isDate(parameters.releaseDate) && asOf < parameters.releaseDate) findings.push(staleDate(parameters.releaseDate, asOf))
    info = `release v${version}: Nous client contract ${String(release)} checked ${String(asOf)}, release day ${parameters.releaseDate}`
  } else if (licenceVersion && valid(version) && lt(licenceVersion, version)) {
    if (checkedDate) {
      const days = Math.floor((Date.parse(today) - Date.parse(asOf)) / DAY)
      info = `between releases: LICENSE.md names ${parameters.version}, package.json names ${version}; ${days} days since the Nous client-contract check (${asOf})`
    }
  } else if (licenceVersion && valid(version)) {
    findings.push(`LICENSE.md names ${parameters.version}, which is not older than package.json ${version}`)
  }
  return { findings, info }
}

function licenceFixture(version: string, releaseDate: string): string {
  return [`- **Version:** \`v${version}\``, `- **Version Release Date:** ${releaseDate} (published at https://example.invalid/releases/tag/v${version})`].join('\n')
}

console.log('Nous client-contract clock: a missing check date fails before a release can present an unchecked client')
const fixtureDate = '2000-02-28'
const afterDate = '2000-02-29'
const fixtureToday = '2000-03-01'
const laterRelease = licenceFixture(VERSION, afterDate)
const sameDayRelease = licenceFixture(VERSION, fixtureDate)
const stale = assess(laterRelease, VERSION, RELEASE, fixtureDate, fixtureToday)
check('a release after the check date reports the exact remedy', stale.findings.length === 1 && stale.findings[0] === staleDate(afterDate, fixtureDate), stale.findings.join(' | '))
check('a release on the check date passes', assess(sameDayRelease, VERSION, RELEASE, fixtureDate, fixtureToday).findings.length === 0)
check('a check after the release date passes', assess(sameDayRelease, VERSION, RELEASE, afterDate, fixtureToday).findings.length === 0)
check('a missing check date fails as it does on the undated constant', assess(sameDayRelease, VERSION, RELEASE, undefined, fixtureToday).findings.some(f => f.includes('NOUS_CLIENT_CONTRACT_AS_OF must be')))
for (const invalid of ['2001-02-29', '2000-02-30', '2000-2-28', '', 'latest']) {
  check(`an invalid check date is refused (${JSON.stringify(invalid)})`, assess(sameDayRelease, VERSION, RELEASE, invalid, fixtureToday).findings.some(f => f.includes('must be a real ISO date')))
}
check('a future check date is refused', assess(sameDayRelease, VERSION, RELEASE, '2000-03-02', fixtureToday).findings.some(f => f.includes('is after today')))
for (const invalid of ['0.21', '0.21.6-beta.1', '', undefined]) {
  check(`a non-three-part release is refused (${String(invalid)})`, assess(sameDayRelease, VERSION, invalid, fixtureDate, fixtureToday).findings.some(f => f.includes('must be a three-part release')))
}
const between = assess(licenceFixture('1.0.0-beta.9', afterDate), '1.0.0-beta.10', RELEASE, fixtureDate, fixtureToday)
check('an older licence is informational between releases, using version order rather than string order', between.findings.length === 0 && between.info.includes('2 days since'), between.info)
check('missing licence parameters cannot bypass the clock', assess('', VERSION, RELEASE, fixtureDate, fixtureToday).findings.length === 2)

const source = readFileSync(join(ROOT, 'src/services/providers/nous/nousClientContract.ts'), 'utf8')
for (const name of ['NOUS_PORTAL_CLIENT_ID', 'NOUS_PORTAL_SIGNIN_SCOPE', 'NOUS_CLIENT_CONTRACT_RELEASE', 'NOUS_CLIENT_CONTRACT_AS_OF']) {
  check(`${name} is declared in the one contract file`, new RegExp(`^export const ${name} = ['"][^'"\\r\\n]+['"]$`, 'm').test(source))
}
check('the describer carries the constant check date', isDate(AS_OF) && contract.presentedNousClient().asOf === AS_OF && contract.presentedNousClient().source === 'constant')
check('the ops suite runs the clock through the proof runner', readFileSync(join(ROOT, 'scripts/ops/run-all.sh'), 'utf8').includes('run_proof scripts/ops/prove-nous-client-contract-clock.ts'))
const tree = assess(LICENCE, VERSION, RELEASE, AS_OF, TODAY)
check('the tree has a checked Nous client contract for its release day', tree.findings.length === 0, tree.findings.join(' | '))
if (tree.info) console.log(tree.info)

console.log('Nous client-contract clock: a learned release presents with its own date; the constant stays the baseline the clock checks')
const LEARNED_AT = Date.parse('2000-03-01T12:00:00Z')
const patchOf = (delta: number): string => RELEASE.replace(/\d+$/, patch => String(Number(patch) + delta))
const learnedHomes: string[] = []
function describeWithLearned(release: string): ReturnType<typeof contract.presentedNousClient> {
  const home = mkdtempSync(join(tmpdir(), 'nous-client-contract-clock-'))
  learnedHomes.push(home)
  writeFileSync(join(home, contract.NOUS_CLIENT_CONTRACT_FILE), JSON.stringify({ learned: { clientId: 'learned-client', scope: 'inference:invoke', release, learnedAtMs: LEARNED_AT, from: 'https://example.invalid/source' }, version: 1 }))
  const pinned = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  try {
    return contract.presentedNousClient()
  } finally {
    if (pinned === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = pinned
  }
}
const learned = describeWithLearned(patchOf(9))
check('a learned release newer than the constant presents as learned, dated by its own learning', learned.release === patchOf(9) && learned.source === 'learned' && learned.clientId === 'learned-client' && learned.asOf === '2000-03-01', JSON.stringify(learned))
check('the constant and its check date are untouched while a learned release presents', contract.NOUS_CLIENT_CONTRACT_RELEASE === RELEASE && (contract as Record<string, unknown>).NOUS_CLIENT_CONTRACT_AS_OF === AS_OF)
check("the clock reads the constant's own check date, never the learned date the door presents", learned.asOf !== AS_OF && assess(LICENCE, VERSION, RELEASE, (contract as Record<string, unknown>).NOUS_CLIENT_CONTRACT_AS_OF, TODAY).findings.join(' | ') === tree.findings.join(' | '))
const staleLearned = describeWithLearned(patchOf(-1))
check('a learned release older than the constant never presents: the constant and its date do', staleLearned.release === RELEASE && staleLearned.source === 'constant' && staleLearned.clientId === contract.NOUS_PORTAL_CLIENT_ID && staleLearned.asOf === AS_OF, JSON.stringify(staleLearned))
for (const home of learnedHomes) rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? 'Nous client-contract clock: green' : `Nous client-contract clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

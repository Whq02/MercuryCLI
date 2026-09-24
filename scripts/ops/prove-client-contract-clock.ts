import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lt, valid } from 'semver'
import * as oauth from '../../src/constants/oauth.ts'
import { expectedChangeDate, readLicenceParameters, todayIso } from '../release/releaseDocuments.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const DAY = 86_400_000
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const LICENCE = readFileSync(join(ROOT, 'LICENSE.md'), 'utf8')
const AS_OF: unknown = (oauth as Record<string, unknown>).ANTHROPIC_CLIENT_CONTRACT_AS_OF
const CONTRACT = oauth.ANTHROPIC_CLIENT_CONTRACT_VERSION
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
  return `the release day ${releaseDate} passed the client-contract constant's date ${asOf} without a check: read the vendor CLI's version and stamp ANTHROPIC_CLIENT_CONTRACT_AS_OF`
}

function assess(licence: string, version: string, contract: unknown, asOf: unknown, today: string): { findings: string[]; info: string } {
  const findings: string[] = []
  const parameters = readLicenceParameters(licence)
  const checkedDate = isDate(asOf)
  if (typeof contract !== 'string' || !/^\d+\.\d+\.\d+$/.test(contract)) {
    findings.push('ANTHROPIC_CLIENT_CONTRACT_VERSION must be a three-part version')
  }
  if (!checkedDate) findings.push('ANTHROPIC_CLIENT_CONTRACT_AS_OF must be a real ISO date (YYYY-MM-DD)')
  else if (asOf > today) findings.push(`ANTHROPIC_CLIENT_CONTRACT_AS_OF ${asOf} is after today (${today})`)
  if (!isDate(parameters.releaseDate)) findings.push('LICENSE.md must carry a real Version Release Date')
  if (!valid(version)) findings.push('package.json must carry a release version')
  const licenceVersion = typeof parameters.version === 'string' && parameters.version.startsWith('v')
    ? valid(parameters.version.slice(1))
    : null
  if (!licenceVersion) findings.push('LICENSE.md must carry a Version tag')
  let info = ''
  if (parameters.version === `v${version}`) {
    if (checkedDate && isDate(parameters.releaseDate) && asOf < parameters.releaseDate) {
      findings.push(staleDate(parameters.releaseDate, asOf))
    }
    info = `release v${version}: contract ${String(contract)} checked ${String(asOf)}, release day ${parameters.releaseDate}`
  } else if (licenceVersion && valid(version) && lt(licenceVersion, version)) {
    if (checkedDate) {
      const days = Math.floor((Date.parse(today) - Date.parse(asOf)) / DAY)
      info = `between releases: LICENSE.md names ${parameters.version}, package.json names ${version}; ${days} days since the client-contract check (${asOf})`
    }
  } else if (licenceVersion && valid(version)) {
    findings.push(`LICENSE.md names ${parameters.version}, which is not older than package.json ${version}`)
  }
  return { findings, info }
}

function licenceFixture(version: string, releaseDate: string): string {
  return [
    `- **Version:** \`v${version}\``,
    `- **Version Release Date:** ${releaseDate} (published at https://example.invalid/releases/tag/v${version})`,
  ].join('\n')
}

console.log('Client-contract clock: a missing check date fails before a release can use an unchecked constant')
const fixtureDate = '2000-02-28'
const afterDate = '2000-02-29'
const fixtureToday = '2000-03-01'
const laterRelease = licenceFixture(VERSION, afterDate)
const sameDayRelease = licenceFixture(VERSION, fixtureDate)
const stale = assess(laterRelease, VERSION, CONTRACT, fixtureDate, fixtureToday)
check('a release after the check date reports the exact remedy', stale.findings.length === 1 && stale.findings[0] === `the release day ${afterDate} passed the client-contract constant's date ${fixtureDate} without a check: read the vendor CLI's version and stamp ANTHROPIC_CLIENT_CONTRACT_AS_OF`, stale.findings.join(' | '))
check('a release on the check date passes', assess(sameDayRelease, VERSION, CONTRACT, fixtureDate, fixtureToday).findings.length === 0)
check('a check after the release date passes', assess(sameDayRelease, VERSION, CONTRACT, afterDate, fixtureToday).findings.length === 0)
check('a missing check date fails as it does on the undated constant', assess(sameDayRelease, VERSION, CONTRACT, undefined, fixtureToday).findings.some(f => f.includes('ANTHROPIC_CLIENT_CONTRACT_AS_OF must be')))
for (const invalid of ['2001-02-29', '2000-02-30', '2000-2-28', '', 'latest']) {
  check(`an invalid check date is refused (${JSON.stringify(invalid)})`, assess(sameDayRelease, VERSION, CONTRACT, invalid, fixtureToday).findings.some(f => f.includes('must be a real ISO date')))
}
check('a future check date is refused', assess(sameDayRelease, VERSION, CONTRACT, '2000-03-02', fixtureToday).findings.some(f => f.includes('is after today')))
for (const invalid of ['2.1', '2.1.280-beta.1', '', undefined]) {
  check(`a non-three-part contract is refused (${String(invalid)})`, assess(sameDayRelease, VERSION, invalid, fixtureDate, fixtureToday).findings.some(f => f.includes('must be a three-part version')))
}
const between = assess(licenceFixture('1.0.0-beta.9', afterDate), '1.0.0-beta.10', CONTRACT, fixtureDate, fixtureToday)
check('an older licence is informational between releases, using version order rather than string order', between.findings.length === 0 && between.info.includes('2 days since'), between.info)
check('a licence newer than the package is not mistaken for a working tree', assess(licenceFixture('1.0.0-beta.10', afterDate), '1.0.0-beta.9', CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('not older than')))
check('missing licence parameters cannot bypass the clock', assess('', VERSION, CONTRACT, fixtureDate, fixtureToday).findings.length === 2)
check('an invalid release date is refused by the shared date grammar', assess(licenceFixture(VERSION, '2000-02-30'), VERSION, CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('real Version Release Date')))
check('an invalid package version cannot bypass the clock', assess(sameDayRelease, 'next', CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('package.json must carry')))

const source = readFileSync(join(ROOT, 'src/constants/oauth.ts'), 'utf8')
for (const name of ['ANTHROPIC_CLIENT_CONTRACT_VERSION', 'ANTHROPIC_CLIENT_CONTRACT_AS_OF']) {
  check(`${name} is declared in the one contract file`, new RegExp(`^export const ${name} = ['"][^'"\\r\\n]+['"]$`, 'm').test(source))
}
check('the describer carries the constant check date', isDate(AS_OF) && oauth.describeAnthropicClientContract().asOf === AS_OF)
check('the ops suite runs the clock through the proof runner', readFileSync(join(ROOT, 'scripts/ops/run-all.sh'), 'utf8').includes('run_proof scripts/ops/prove-client-contract-clock.ts'))
const tree = assess(LICENCE, VERSION, CONTRACT, AS_OF, TODAY)
check('the tree has a checked contract for its release day', tree.findings.length === 0, tree.findings.join(' | '))
if (tree.info) console.log(tree.info)
console.log(failures === 0 ? 'client-contract clock: green' : `client-contract clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lt, valid } from 'semver'
import * as contract from '../../src/services/providers/gemini/antigravityClientContract.ts'
import { latestReleaseNote, parseIsoDate, readReleaseNoteParameters } from '../release/notesFromChangelog.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const DAY = 86_400_000
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const NOTE = latestReleaseNote(ROOT)
const AS_OF: unknown = (contract as Record<string, unknown>).ANTIGRAVITY_CLIENT_CONTRACT_AS_OF
const CLIENT_VERSION = contract.ANTIGRAVITY_CLIENT_CONTRACT_VERSION
const TODAY = new Date().toISOString().slice(0, 10)
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && parseIsoDate(value) !== null
}

function staleDate(releaseDate: string, asOf: string): string {
  return `the release day ${releaseDate} passed the Antigravity client-contract constant's date ${asOf} without a check: read Antigravity's update manifest and stamp ANTIGRAVITY_CLIENT_CONTRACT_AS_OF`
}

function assess(note: string, version: string, clientVersion: unknown, asOf: unknown, today: string): { findings: string[]; info: string } {
  const findings: string[] = []
  const parameters = readReleaseNoteParameters(note)
  const checkedDate = isDate(asOf)
  if (typeof clientVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(clientVersion)) findings.push('ANTIGRAVITY_CLIENT_CONTRACT_VERSION must be a three-part version')
  if (!checkedDate) findings.push('ANTIGRAVITY_CLIENT_CONTRACT_AS_OF must be a real ISO date (YYYY-MM-DD)')
  else if (asOf > today) findings.push(`ANTIGRAVITY_CLIENT_CONTRACT_AS_OF ${asOf} is after today (${today})`)
  if (!isDate(parameters.releaseDate)) findings.push('the release note must carry a real publication date')
  if (!valid(version)) findings.push('package.json must carry a release version')
  const noteVersion = typeof parameters.version === 'string' && parameters.version.startsWith('v') ? valid(parameters.version.slice(1)) : null
  if (!noteVersion) findings.push('the release note must carry a version')
  let info = ''
  if (parameters.version === `v${version}`) {
    if (checkedDate && isDate(parameters.releaseDate) && asOf < parameters.releaseDate) findings.push(staleDate(parameters.releaseDate, asOf))
    info = `release v${version}: Antigravity client contract ${String(clientVersion)} checked ${String(asOf)}, release day ${parameters.releaseDate}`
  } else if (noteVersion && valid(version) && lt(noteVersion, version)) {
    if (checkedDate) {
      const days = Math.floor((Date.parse(today) - Date.parse(asOf)) / DAY)
      info = `between releases: the release note names ${parameters.version}, package.json names ${version}; ${days} days since the Antigravity client-contract check (${asOf})`
    }
  } else if (noteVersion && valid(version)) {
    findings.push(`the release note names ${parameters.version}, which is not older than package.json ${version}`)
  }
  return { findings, info }
}

function releaseFixture(version: string, releaseDate: string): string {
  return `# ${version} — published ${releaseDate}\n`
}

console.log('Antigravity client-contract clock: a missing check date fails before a release can present an unchecked client version')
const fixtureDate = '2000-02-28'
const afterDate = '2000-02-29'
const fixtureToday = '2000-03-01'
const laterRelease = releaseFixture(VERSION, afterDate)
const sameDayRelease = releaseFixture(VERSION, fixtureDate)
const stale = assess(laterRelease, VERSION, CLIENT_VERSION, fixtureDate, fixtureToday)
check('a release after the check date reports the exact remedy', stale.findings.length === 1 && stale.findings[0] === staleDate(afterDate, fixtureDate), stale.findings.join(' | '))
check('a release on the check date passes', assess(sameDayRelease, VERSION, CLIENT_VERSION, fixtureDate, fixtureToday).findings.length === 0)
check('a check after the release date passes', assess(sameDayRelease, VERSION, CLIENT_VERSION, afterDate, fixtureToday).findings.length === 0)
check('a missing check date fails as it does on the undated constant', assess(sameDayRelease, VERSION, CLIENT_VERSION, undefined, fixtureToday).findings.some(f => f.includes('ANTIGRAVITY_CLIENT_CONTRACT_AS_OF must be')))
for (const invalid of ['2001-02-29', '2000-02-30', '2000-2-28', '', 'latest']) {
  check(`an invalid check date is refused (${JSON.stringify(invalid)})`, assess(sameDayRelease, VERSION, CLIENT_VERSION, invalid, fixtureToday).findings.some(f => f.includes('must be a real ISO date')))
}
check('a future check date is refused', assess(sameDayRelease, VERSION, CLIENT_VERSION, '2000-03-02', fixtureToday).findings.some(f => f.includes('is after today')))
for (const invalid of ['2.23', '2.23.0-beta.1', '', undefined]) {
  check(`a non-three-part version is refused (${String(invalid)})`, assess(sameDayRelease, VERSION, invalid, fixtureDate, fixtureToday).findings.some(f => f.includes('must be a three-part version')))
}
const between = assess(releaseFixture('1.0.0-beta.9', afterDate), '1.0.0-beta.10', CLIENT_VERSION, fixtureDate, fixtureToday)
check('an older release note is informational between releases, using version order rather than string order', between.findings.length === 0 && between.info.includes('2 days since'), between.info)
check('a missing release-note heading cannot bypass the clock', assess('', VERSION, CLIENT_VERSION, fixtureDate, fixtureToday).findings.length === 2)

const source = readFileSync(join(ROOT, 'src/services/providers/gemini/antigravityClientContract.ts'), 'utf8')
for (const name of ['ANTIGRAVITY_OAUTH_CLIENT_ID', 'ANTIGRAVITY_OAUTH_CLIENT_SECRET', 'ANTIGRAVITY_CLIENT_CONTRACT_VERSION', 'ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST', 'ANTIGRAVITY_CLIENT_CONTRACT_AS_OF']) {
  check(`${name} is declared in the one contract file`, new RegExp(`^export const ${name} = ['"][^'"\\r\\n]+['"]$`, 'm').test(source))
}
check('the describer carries the constant check date', isDate(AS_OF) && contract.presentedAntigravityClient().asOf === AS_OF && contract.presentedAntigravityClient().source === 'constant')
check('the User-Agent is the Antigravity client\'s own, built from the presented version and the changelist', contract.antigravityUserAgent() === `antigravity/hub/${CLIENT_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST})`, contract.antigravityUserAgent())
check('the ops suite runs the clock through the proof runner', readFileSync(join(ROOT, 'scripts/ops/run-all.sh'), 'utf8').includes('run_proof scripts/ops/prove-antigravity-client-contract-clock.ts'))
const tree = assess(NOTE, VERSION, CLIENT_VERSION, AS_OF, TODAY)
check('the tree has a checked Antigravity client contract for its release day', tree.findings.length === 0, tree.findings.join(' | '))
if (tree.info) console.log(tree.info)

console.log('Antigravity client-contract clock: a learned version presents with its own date; the constant stays the baseline the clock checks')
const LEARNED_AT = Date.parse('2000-03-01T12:00:00Z')
const patchOf = (delta: number): string => CLIENT_VERSION.replace(/\d+$/, patch => String(Number(patch) + delta))
const learnedHomes: string[] = []
function describeWithLearned(version: string): ReturnType<typeof contract.presentedAntigravityClient> {
  const home = mkdtempSync(join(tmpdir(), 'antigravity-client-contract-clock-'))
  learnedHomes.push(home)
  writeFileSync(join(home, contract.ANTIGRAVITY_CLIENT_CONTRACT_FILE), JSON.stringify({ learned: { version, learnedAtMs: LEARNED_AT, from: 'https://example.invalid/manifest' }, version: 1 }))
  const pinned = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  try {
    return contract.presentedAntigravityClient()
  } finally {
    if (pinned === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = pinned
  }
}
const learned = describeWithLearned(patchOf(9))
check('a learned version newer than the constant presents as learned, dated by its own learning', learned.version === patchOf(9) && learned.source === 'learned' && learned.asOf === '2000-03-01', JSON.stringify(learned))
check('the learned version rides the User-Agent; the changelist stays the constant', contract.antigravityUserAgent(learned) === `antigravity/hub/${patchOf(9)} (aidev_client; os_type=darwin; arch=arm64; cl=${contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST})`)
check('the constant and its check date are untouched while a learned version presents', contract.ANTIGRAVITY_CLIENT_CONTRACT_VERSION === CLIENT_VERSION && (contract as Record<string, unknown>).ANTIGRAVITY_CLIENT_CONTRACT_AS_OF === AS_OF)
check("the clock reads the constant's own check date, never the learned date the door presents", learned.asOf !== AS_OF && assess(NOTE, VERSION, CLIENT_VERSION, (contract as Record<string, unknown>).ANTIGRAVITY_CLIENT_CONTRACT_AS_OF, TODAY).findings.join(' | ') === tree.findings.join(' | '))
const staleLearned = describeWithLearned(patchOf(-1))
check('a learned version older than the constant never presents: the constant and its date do', staleLearned.version === CLIENT_VERSION && staleLearned.source === 'constant' && staleLearned.asOf === AS_OF, JSON.stringify(staleLearned))
for (const home of learnedHomes) rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? 'Antigravity client-contract clock: green' : `Antigravity client-contract clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

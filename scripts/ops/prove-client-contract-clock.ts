import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lt, valid } from 'semver'
import * as oauth from '../../src/constants/oauth.ts'
import { latestReleaseNote, parseIsoDate, readReleaseNoteParameters } from '../release/notesFromChangelog.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const DAY = 86_400_000
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const NOTE = latestReleaseNote(ROOT)
const AS_OF: unknown = (oauth as Record<string, unknown>).ANTHROPIC_CLIENT_CONTRACT_AS_OF
const CONTRACT = oauth.ANTHROPIC_CLIENT_CONTRACT_VERSION
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
  return `the release day ${releaseDate} passed the client-contract constant's date ${asOf} without a check: read the vendor CLI's version and stamp ANTHROPIC_CLIENT_CONTRACT_AS_OF`
}

function assess(note: string, version: string, contract: unknown, asOf: unknown, today: string): { findings: string[]; info: string } {
  const findings: string[] = []
  const parameters = readReleaseNoteParameters(note)
  const checkedDate = isDate(asOf)
  if (typeof contract !== 'string' || !/^\d+\.\d+\.\d+$/.test(contract)) {
    findings.push('ANTHROPIC_CLIENT_CONTRACT_VERSION must be a three-part version')
  }
  if (!checkedDate) findings.push('ANTHROPIC_CLIENT_CONTRACT_AS_OF must be a real ISO date (YYYY-MM-DD)')
  else if (asOf > today) findings.push(`ANTHROPIC_CLIENT_CONTRACT_AS_OF ${asOf} is after today (${today})`)
  if (!isDate(parameters.releaseDate)) findings.push('the release note must carry a real publication date')
  if (!valid(version)) findings.push('package.json must carry a release version')
  const noteVersion = typeof parameters.version === 'string' && parameters.version.startsWith('v')
    ? valid(parameters.version.slice(1))
    : null
  if (!noteVersion) findings.push('the release note must carry a version')
  let info = ''
  if (parameters.version === `v${version}`) {
    if (checkedDate && isDate(parameters.releaseDate) && asOf < parameters.releaseDate) {
      findings.push(staleDate(parameters.releaseDate, asOf))
    }
    info = `release v${version}: contract ${String(contract)} checked ${String(asOf)}, release day ${parameters.releaseDate}`
  } else if (noteVersion && valid(version) && lt(noteVersion, version)) {
    if (checkedDate) {
      const days = Math.floor((Date.parse(today) - Date.parse(asOf)) / DAY)
      info = `between releases: the release note names ${parameters.version}, package.json names ${version}; ${days} days since the client-contract check (${asOf})`
    }
  } else if (noteVersion && valid(version)) {
    findings.push(`the release note names ${parameters.version}, which is not older than package.json ${version}`)
  }
  return { findings, info }
}

function releaseFixture(version: string, releaseDate: string): string {
  return `# ${version} — published ${releaseDate}\n`
}

console.log('Client-contract clock: a missing check date fails before a release can use an unchecked constant')
const fixtureDate = '2000-02-28'
const afterDate = '2000-02-29'
const fixtureToday = '2000-03-01'
const laterRelease = releaseFixture(VERSION, afterDate)
const sameDayRelease = releaseFixture(VERSION, fixtureDate)
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
const between = assess(releaseFixture('1.0.0-beta.9', afterDate), '1.0.0-beta.10', CONTRACT, fixtureDate, fixtureToday)
check('an older release note is informational between releases, using version order rather than string order', between.findings.length === 0 && between.info.includes('2 days since'), between.info)
check('a release note newer than the package is not mistaken for a working tree', assess(releaseFixture('1.0.0-beta.10', afterDate), '1.0.0-beta.9', CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('not older than')))
check('a missing release-note heading cannot bypass the clock', assess('', VERSION, CONTRACT, fixtureDate, fixtureToday).findings.length === 2)
check('an invalid publication date is refused by the shared date grammar', assess(releaseFixture(VERSION, '2000-02-30'), VERSION, CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('real publication date')))
check('an invalid package version cannot bypass the clock', assess(sameDayRelease, 'next', CONTRACT, fixtureDate, fixtureToday).findings.some(f => f.includes('package.json must carry')))

const noteRoot = mkdtempSync(join(tmpdir(), 'release-note-clock-'))
try {
  const notes = join(noteRoot, 'docs', 'releases')
  mkdirSync(notes, { recursive: true })
  check('no release note leaves the clock without a date', latestReleaseNote(noteRoot) === '')
  writeFileSync(join(notes, 'README.md'), '# Release index\n')
  writeFileSync(join(notes, '1.0.0-beta.9.md'), releaseFixture('1.0.0-beta.9', fixtureDate))
  writeFileSync(join(notes, '1.0.0-beta.10.md'), releaseFixture('1.0.0-beta.10', afterDate))
  writeFileSync(join(notes, '1.0.0-beta.11.md'), '# 1.0.0-beta.11 — queued\n')
  check('the latest published note is selected in version order, skipping the queued page and index', latestReleaseNote(noteRoot) === releaseFixture('1.0.0-beta.10', afterDate))
  writeFileSync(join(notes, '1.0.0-beta.11.md'), '# 1.0.0-beta.11 — ready for the tag\n')
  check('a page that is ready for the tag is skipped like the queued page (the release in flight has no published day yet)', latestReleaseNote(noteRoot) === releaseFixture('1.0.0-beta.10', afterDate))
  writeFileSync(join(notes, '1.0.0-beta.11.md'), releaseFixture('1.0.0-beta.11', fixtureToday))
  check('publishing the queued page advances the clock', latestReleaseNote(noteRoot) === releaseFixture('1.0.0-beta.11', fixtureToday))
  writeFileSync(join(notes, '1.0.0-beta.11.md'), releaseFixture('1.0.0-beta.10', afterDate))
  check('a heading version different from its file cannot fall back to an older release', latestReleaseNote(noteRoot) === '')
  writeFileSync(join(notes, '1.0.0-beta.11.md'), '# malformed\n' + releaseFixture('1.0.0-beta.11', fixtureToday))
  check('only the first heading supplies the release clock', latestReleaseNote(noteRoot) === '')
  const extractor = join(noteRoot, 'scripts', 'release', 'notesFromChangelog.mjs')
  mkdirSync(join(noteRoot, 'scripts', 'release'), { recursive: true })
  mkdirSync(join(noteRoot, 'src', 'constants'), { recursive: true })
  writeFileSync(extractor, readFileSync(join(ROOT, 'scripts/release/notesFromChangelog.mjs')))
  writeFileSync(join(noteRoot, 'src', 'constants', 'changelog.ts'), '## 1.0.0\n- Released\n')
  const extracted = spawnSync('node', [extractor, '1.0.0'], { encoding: 'utf8', timeout: 10_000 })
  check('release-note extraction still runs in a checkout without installed dependencies', extracted.status === 0 && extracted.stdout === '# Mercury 1.0.0\n\n- Released\n', extracted.stderr)
} finally {
  rmSync(noteRoot, { recursive: true, force: true })
}

const source = readFileSync(join(ROOT, 'src/constants/oauth.ts'), 'utf8')
for (const name of ['ANTHROPIC_CLIENT_CONTRACT_VERSION', 'ANTHROPIC_CLIENT_CONTRACT_AS_OF']) {
  check(`${name} is declared in the one contract file`, new RegExp(`^export const ${name} = ['"][^'"\\r\\n]+['"]$`, 'm').test(source))
}
check('the describer carries the constant check date', isDate(AS_OF) && oauth.describeAnthropicClientContract().asOf === AS_OF)
check('the ops suite runs the clock through the proof runner', readFileSync(join(ROOT, 'scripts/ops/run-all.sh'), 'utf8').includes('run_proof scripts/ops/prove-client-contract-clock.ts'))
const tree = assess(NOTE, VERSION, CONTRACT, AS_OF, TODAY)
check('the tree has a checked contract for its release day', tree.findings.length === 0, tree.findings.join(' | '))
if (tree.info) console.log(tree.info)

console.log('Client-contract clock: a learned number presents with its own date; the constant stays the baseline the clock checks')
const LEARNED_AT = Date.parse('2000-03-01T12:00:00Z')
const patchOf = (delta: number): string => CONTRACT.replace(/\d+$/, patch => String(Number(patch) + delta))
const learnedHomes: string[] = []
function describeWithLearned(version: string): ReturnType<typeof oauth.describeAnthropicClientContract> {
  const home = mkdtempSync(join(tmpdir(), 'client-contract-clock-'))
  learnedHomes.push(home)
  writeFileSync(join(home, 'client-contract.json'), JSON.stringify({ learned: { version, learnedAtMs: LEARNED_AT, from: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', by: 'heal' }, _v: 1 }))
  const pinned = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  try {
    return oauth.describeAnthropicClientContract()
  } finally {
    if (pinned === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = pinned
  }
}
const learnedOverride = process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
delete process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT
const learned = describeWithLearned(patchOf(9))
check('a learned number newer than the constant presents as learned, dated by its own learning', learned.presented === patchOf(9) && learned.source === 'learned' && learned.asOf === '2000-03-01', JSON.stringify(learned))
check('the constant and its check date are untouched while a learned number presents', oauth.ANTHROPIC_CLIENT_CONTRACT_VERSION === CONTRACT && (oauth as Record<string, unknown>).ANTHROPIC_CLIENT_CONTRACT_AS_OF === AS_OF)
check("the clock reads the constant's own check date, never the learned date the door presents", learned.asOf !== AS_OF && assess(NOTE, VERSION, CONTRACT, (oauth as Record<string, unknown>).ANTHROPIC_CLIENT_CONTRACT_AS_OF, TODAY).findings.join(' | ') === tree.findings.join(' | '))
const staleLearned = describeWithLearned(patchOf(-1))
check('a learned number older than the constant never presents: the constant and its date do', staleLearned.presented === CONTRACT && staleLearned.source === 'constant' && staleLearned.asOf === AS_OF, JSON.stringify(staleLearned))
if (learnedOverride !== undefined) process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = learnedOverride
for (const home of learnedHomes) rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? 'client-contract clock: green' : `client-contract clock: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)


;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const dist = path.join(repo, 'dist/mercury.mjs')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('prove-readme-roster — the README command table is the artifact truth')

if (!existsSync(dist)) {
  console.error('prove-readme-roster: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

const RUN_HOME = mkdtempSync(path.join(tmpdir(), 'mercury-verity-roster-'))
process.env.MERCURY_CONFIG_DIR = RUN_HOME
const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [repo]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)

type DumpSurface = {
  name: string
  displayName: string
  aliases: string[]
  categoryLabel: string
  enabled: boolean
  visibility: string
}
const out = path.join(RUN_HOME, 'surfaces.json')
const res = spawnSync('node', [dist], {
  encoding: 'utf-8',
  timeout: 60000,
  cwd: repo,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    NODE_ENV: 'test',
    ANTHROPIC_API_KEY: PROBE_KEY,
    MERCURY_SURFACE_DUMP: out,
  },
})
if (res.status !== 0 || !existsSync(out)) {
  check('artifact dump runs (MERCURY_SURFACE_DUMP)', false, `status ${res.status}: ${res.stderr?.slice(0, 200)}`)
  process.exit(1)
}
const doc = JSON.parse(readFileSync(out, 'utf8')) as { generatedBy: string; surfaces: DumpSurface[] }
check('dump document is the effectiveCatalogue projection', doc.generatedBy === 'effectiveCatalogue')
const surfaces = doc.surfaces

const enabledByName = new Map<string, boolean>()
for (const s of surfaces) {
  enabledByName.set(s.name, (enabledByName.get(s.name) ?? false) || s.enabled)
}
const eligible = surfaces.filter(s => s.visibility === 'normal' && enabledByName.get(s.name) === true)
const truthByDisplay = new Map<string, DumpSurface>()
for (const s of eligible) {
  if (!truthByDisplay.has(s.displayName)) truthByDisplay.set(s.displayName, s)
}
check('the artifact serves a real roster (>100 names)', truthByDisplay.size > 100, String(truthByDisplay.size))

const readme = readFileSync(path.join(repo, 'README.md'), 'utf8')
const tables = readme.match(/\| Domain \| Commands \|\n\|[ -|]+\|\n(?:\|.*\|\n)+/g) ?? []
check('README carries exactly one roster table', tables.length === 1, String(tables.length))
const table = tables[0] ?? ''

const readmeByDomain = new Map<string, string[]>()
for (const line of table.split('\n').slice(2)) {
  const m = line.match(/^\| (.+?) \| (.+?) \|$/)
  if (!m) continue
  readmeByDomain.set(m[1]!, [...m[2]!.matchAll(/`\/([a-z0-9-]+)`/g)].map(x => x[1]!))
}
const readmeNames = [...readmeByDomain.values()].flat()
check(
  'each name appears once in the table',
  new Set(readmeNames).size === readmeNames.length,
  readmeNames.filter((n, i) => readmeNames.indexOf(n) !== i).join(', '),
)

const readmeSet = new Set(readmeNames)
const unlisted = [...truthByDisplay.keys()].filter(n => !readmeSet.has(n)).sort()
const stale = [...readmeSet].filter(n => !truthByDisplay.has(n)).sort()
check('every servable command is listed (nothing ships unadvertised)', unlisted.length === 0, unlisted.join(', '))
check('every listed command is servable (nothing advertised is dead)', stale.length === 0, stale.join(', '))

const truthByLabel = new Map<string, Set<string>>()
for (const s of eligible) {
  const set = truthByLabel.get(s.categoryLabel) ?? new Set<string>()
  set.add(s.displayName)
  truthByLabel.set(s.categoryLabel, set)
}
for (const [label, names] of truthByLabel) {
  const listed = readmeByDomain.get(label)
  if (!listed) {
    check(`domain '${label}' has a README row`, false, `${names.size} names have nowhere to sit`)
    continue
  }
  const extra = [...names].filter(n => !listed.includes(n)).sort()
  const gone = listed.filter(n => !names.has(n)).sort()
  check(
    `domain '${label}' membership matches`,
    extra.length === 0 && gone.length === 0,
    [extra.length ? `missing: ${extra.join(', ')}` : '', gone.length ? `stale: ${gone.join(', ')}` : '']
      .filter(Boolean)
      .join(' | '),
  )
}
for (const label of readmeByDomain.keys()) {
  if (!truthByLabel.has(label)) {
    check(`README domain '${label}' exists in the catalogue`, false)
  }
}

{
  const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.js')
  const curated = COMMAND_DOMAINS.map(d => d.label).filter(label => readmeByDomain.has(label))
  check(
    'the table rows ride in COMMAND_DOMAINS order',
    JSON.stringify([...readmeByDomain.keys()]) === JSON.stringify(curated),
    `table: ${[...readmeByDomain.keys()].join(' · ')}`,
  )
}

rmSync(RUN_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-readme-roster: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-readme-roster: green')
process.exit(0)

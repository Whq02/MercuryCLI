
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

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

if (!existsSync(dist)) {
  console.error('prove-beta-journey-matrix: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

const RUN_HOME = mkdtempSync(path.join(tmpdir(), 'mercury-verity-journey-'))
process.env.MERCURY_CONFIG_DIR = RUN_HOME

const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'

function seedHome(): void {
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
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))
}
seedHome()


const childEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  NODE_ENV: 'test',
  ANTHROPIC_API_KEY: PROBE_KEY,
}

console.log('prove-beta-journey-matrix — the built artifact resolves its surfaces')

type DumpSurface = {
  name: string
  aliases: string[]
  kind: string
  category: string
  visibility: string
  enabled: boolean
  canonicalRoute: string
}
function dumpArtifact(extraEnv: Record<string, string> = {}): DumpSurface[] {
  const out = path.join(RUN_HOME, `dump-${Object.keys(extraEnv).length}.json`)
  const res = spawnSync('node', [dist], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(60000),
    cwd: repo,
    env: { ...childEnv, MERCURY_SURFACE_DUMP: out, ...extraEnv },
  })
  if (res.status !== 0 || !existsSync(out)) {
    check('artifact dump runs (MERCURY_SURFACE_DUMP)', false, `status ${res.status}: ${res.stderr?.slice(0, 200)}`)
    process.exit(1)
  }
  const doc = JSON.parse(readFileSync(out, 'utf8')) as { generatedBy: string; surfaces: DumpSurface[] }
  check('dump document is the effectiveCatalogue projection', doc.generatedBy === 'effectiveCatalogue')
  return doc.surfaces
}

const surfaces = dumpArtifact()
const byName = new Map(surfaces.map(s => [s.name, s]))

{
  const PURGED = ['mode', 'rooms', 'chronicle', 'tree', 'roster', 'queue', 'degraded', 'states', 'tiers', 'hud', 'parity', 'map', 'control', 'orch']
  const revenants = PURGED.filter(n => byName.has(n))
  check('the purged routes are ABSENT as command names', revenants.length === 0, revenants.join(', '))
  check("'rooms' is a /multiplayer alias in the artifact", byName.get('multiplayer')?.aliases.includes('rooms') === true)
  check("'chronicle' is a /memory alias in the artifact", byName.get('memory')?.aliases.includes('chronicle') === true)

  const LIVE = ['sessions', 'surfaces', 'teammates', 'memory', 'model', 'help', 'palette', 'status', 'usage', 'health', 'capabilities', 'tasks', 'workflows', 'agents', 'resume', 'diff']
  const missing = LIVE.filter(n => {
    const s = byName.get(n)
    return !s || !s.enabled || s.visibility !== 'normal'
  })
  check('the live estate is present + normal + enabled', missing.length === 0, missing.join(', '))
  const mpDoor = byName.get('multiplayer')
  check(
    "the /multiplayer door stays registered and RETIRED (present, not enabled — the retirement's honest answer)",
    mpDoor !== undefined && mpDoor.enabled === false,
    mpDoor === undefined ? 'absent' : `enabled=${mpDoor.enabled}`,
  )

  const showcase = byName.get('showcase')
  check('/showcase is dev-visibility + DISABLED unarmed', showcase?.visibility === 'dev' && showcase.enabled === false)

  const unclassified = surfaces.filter(
    s => !s.name || !s.kind || !s.category || !['normal', 'hidden', 'dev'].includes(s.visibility) || typeof s.enabled !== 'boolean',
  )
  check('every surface row is fully classified', unclassified.length === 0, unclassified.map(s => s.name).join(', '))

  const armed = dumpArtifact({ MERCURY_DEV_SURFACES: '1' })
  const armedShowcase = armed.find(s => s.name === 'showcase')
  check('MERCURY_DEV_SURFACES=1 arms /showcase in the artifact', armedShowcase?.enabled === true)

  console.log(`  ·  artifact surfaces: ${surfaces.length} (${surfaces.filter(s => s.visibility === 'normal' && s.enabled).length} normal+enabled)`)
}

const scenarios = await import('../../scripts/ui/renderScenarios.js')
const { writeSyntheticSession, SID, RUNTIME_CWD } = scenarios

{
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  const { rmSync: rmCfg } = await import('node:fs')
  process.env.ANTHROPIC_API_KEY = PROBE_KEY
  rmCfg(path.join(RUN_HOME, '.mercury.json'), { force: true })
  seedFirstRun(RUN_HOME, [repo, RUNTIME_CWD])
}

type PtyLeg = { name: string; cmd: string; markers: string[]; anyOf?: string[] }
const LEGS: PtyLeg[] = [
  { name: 'sessions', cmd: '/sessions', markers: ['— sessions'] },
  { name: 'surfaces', cmd: '/surfaces', markers: ['— surfaces', 'type to filter'] },
]

function runLeg(leg: PtyLeg, withEsc: boolean): string | null {
  writeSyntheticSession('short')
  const tag = `${leg.name}${withEsc ? '-close' : '-mount'}`
  const out = path.join(RUN_HOME, `grid-${tag}.json`)
  const cfg = {
    argv: ['node', dist, '--resume', SID],
    sends: [
      { atTick: 180, minTick: 5, awaitText: 'Type a prompt', requireAwait: true, data: leg.cmd },
      { afterPrevTicks: 6, data: '\r' },
      ...(withEsc ? [{ afterPrevTicks: 24, data: '\x1b' }] : []),
    ],
    stableTicks: 4,
    total: withEsc ? 240 : 220,
    cols: 100,
    rows: 32,
    out,
  }
  const cfgPath = path.join(RUN_HOME, `cfg-${tag}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const ptyEnv = { ...childEnv }
  delete (ptyEnv as Record<string, string | undefined>).NODE_ENV
  const res = spawnSync('/usr/bin/python3', [path.join(repo, 'scripts/ui/vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(120000),
    cwd: RUNTIME_CWD,
    env: ptyEnv,
  })
  if (res.status !== 0) {
    check(`${leg.cmd} PTY capture (${tag}) runs`, false, res.stderr?.slice(0, 200) ?? `status ${res.status}`)
    return null
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  return payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
}

for (const leg of LEGS) {
  const mounted = runLeg(leg, false)
  if (mounted !== null) {
    for (const m of leg.markers) {
      check(`${leg.cmd} mounts its live frame (“${m}”)`, mounted.includes(m))
    }
    if (leg.anyOf) {
      check(
        `${leg.cmd} shows a truthful live/empty state`,
        leg.anyOf.some(m => mounted.includes(m)),
        `none of ${leg.anyOf.join(' / ')} on screen`,
      )
    }
  }
  const closed = runLeg(leg, true)
  if (closed !== null) {
    check(`${leg.cmd} esc returns to the composer`, /❯/.test(closed), 'no prompt marker in the final frame')
  }
}

const { rmSync } = await import('node:fs')
rmSync(RUN_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-beta-journey-matrix: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-beta-journey-matrix: green')
process.exit(0)

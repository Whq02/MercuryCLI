// prove-beta-journey-matrix — REGISTRY truth from the BUILT artifact (
// §9, gate member; class pty).
//
// Leg A (artifact dump): boots dist/mercury.mjs with MERCURY_SURFACE_DUMP so the
// artifact itself reports its effective catalogue, then verifies:
//   · the purged routes are ABSENT as names (mode · rooms · chronicle · tree ·
//     roster · queue · degraded · states · tiers · hud · parity · map ·
//     control · orch — the dispositions);
//   · the consolidations hold ('rooms' → /multiplayer alias · 'chronicle' →
//     /memory alias);
//   · the live estate is PRESENT + normal + enabled (sessions ·
//     manager · teammates · multiplayer · memory · model · help · palette …);
//   · the ONE dev boundary works IN THE ARTIFACT: /showcase is disabled+dev
//     unarmed, enabled when MERCURY_DEV_SURFACES=1;
//   · every surface row is fully classified (kind/category/visibility/enabled).
//
// Leg B (PTY journeys): drives the built artifact through the three REBUILT
// surfaces — /sessions (the live manager,
// direct), /manager (the catalogue index) — via the vshot PTY substrate;
// each mounts, renders its live frame, and esc returns to the composer.
//
// Run: ~/.bun/bin/bun run scripts/command-catalogue/prove-beta-journey-matrix.ts

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

// Hermetic home BEFORE renderScenarios loads (module-load CONFIG_HOME snapshot).
// mkdtemp, never a pid-keyed fixed path: pids RECYCLE on a busy box and a
// stale home from a crashed earlier run then shadows the seed (the absent-
// only first-run guard no-ops on the leftover config and the boot parks on
// the consent gate — every send dies there).
const RUN_HOME = mkdtempSync(path.join(tmpdir(), 'mercury-verity-journey-'))
process.env.MERCURY_CONFIG_DIR = RUN_HOME

// The registry build reaches login()'s auth probe; the hermetic home has no
// credential, so a placeholder keeps the SHAPE derivation running. The seeded
// customApiKeyResponses APPROVAL for that key is LOAD-BEARING for the PTY
// legs: an unapproved env key leaves the booted REPL in a consent state that
// silently consumes keystrokes (found live authoring this proof — the same
// seed generate-visual-baseline.ts uses).
const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'

function seedHome(): void {
  // The ONE global-config file the product reads (getGlobalMercuryFile):
  // `<home>/.mercury.json` on a fresh home. A seed under any other name is
  // invisible — the boot then parks on the API-key consent card and the
  // FIRST leg's keystrokes die in it.
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
// The PRODUCT's first-run seed beside the legacy-shape file: the PTY boots
// in RUNTIME_CWD (renderScenarios' runtime dir), whose trust + project
// onboarding must be recorded in the config file the product actually
// reads — the legacy-only seed left the boot on the walk/trust gate and
// the composer never went interactive.


const childEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  NODE_ENV: 'test',
  ANTHROPIC_API_KEY: PROBE_KEY,
}

console.log('prove-beta-journey-matrix — the built artifact resolves its surfaces')

// ── Leg A: the artifact dump ───────────────────────────────────────────────
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

  // /doctor became /health (the 'doctor' spelling stays a
  // compat alias, not a first-class surface row) — the pin names the
  // canonical surface. 'multiplayer' left the LIVE list with the
  // the retirement: it stands as a REGISTERED RETIRED DOOR (commands/retired.ts —
  // a typed name answers the retirement sentence, never "unknown"), pinned
  // below so its revival or full removal both surface as deliberate acts.
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

// ── Leg B: PTY journeys through the rebuilt surfaces ───────────────────────
const scenarios = await import('../../scripts/ui/renderScenarios.js')
const { writeSyntheticSession, SID, RUNTIME_CWD } = scenarios

// Re-seed the home AFTER leg A: the dump children write config on their way
// out and their view drops the seeded approval + theme — the PTY boots must
// read the product's own first-run seed (trust for the PTY cwd + the
// PROBE_KEY approval; an unapproved env key parks the boot on the consent
// dialog and every send dies there).
{
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  const { rmSync: rmCfg } = await import('node:fs')
  process.env.ANTHROPIC_API_KEY = PROBE_KEY
  rmCfg(path.join(RUN_HOME, '.mercury.json'), { force: true })
  seedFirstRun(RUN_HOME, [repo, RUNTIME_CWD])
}

type PtyLeg = { name: string; cmd: string; markers: string[]; anyOf?: string[] }
const LEGS: PtyLeg[] = [
  // /stats — the LIVE owner: populated (Overview tab) or the honest empty.
  // /sessions — the live manager frame, mounted DIRECTLY (no gallery hop).
  { name: 'sessions', cmd: '/sessions', markers: ['— sessions'] },
  // /manager — the catalogue index. Marker re-cut (manager-search
  // lane): the duplicated 'Mercury manager' title line became the search row,
  // so the mount now anchors on the lockup title + the search row's resting
  // placeholder (both painted from frame one of the settled surface).
  { name: 'surfaces', cmd: '/surfaces', markers: ['— surfaces', 'type to filter'] },
]

// ORACLE LAW (learned live authoring this proof): Mercury's cell differ
// interleaves cursor movement between glyph runs, so RAW-BYTE substring
// scans (the tee) are BLIND to on-screen text — only pyte-COMPOSED grids
// (vshot's `out` payload) are a truthful text oracle. Each leg therefore
// captures twice: run A ends ON the mounted view (grid ⇒ mount + truthful
// state); run B adds esc (grid ⇒ the composer return).
function runLeg(leg: PtyLeg, withEsc: boolean): string | null {
  writeSyntheticSession('short')
  const tag = `${leg.name}${withEsc ? '-close' : '-mount'}`
  const out = path.join(RUN_HOME, `grid-${tag}.json`)
  const cfg = {
    argv: ['node', dist, '--resume', SID],
    // The first keystroke gates on the COMPOSER'S OWN ready line (the
    // bracketed-paste arm proved too early — it arms during boot, before
    // the composer accepts input, and the command's head typed through);
    // atTick stays the hard deadline. The rest ride relative scheduling so
    // early fires keep the journey shape.
    sends: [
      // requireAwait: a slow boot DELAYS the keystroke instead of firing it
      // blind at the deadline into a not-yet-interactive composer (the
      // eaten-first-keypress class — the typed command vanished and the
      // mount needle read as a product red).
      { atTick: 180, minTick: 5, awaitText: 'Type a prompt', requireAwait: true, data: leg.cmd },
      { afterPrevTicks: 6, data: '\r' },
      ...(withEsc ? [{ afterPrevTicks: 24, data: '\x1b' }] : []),
    ],
    // Mount runs settle on the OPEN view; close runs settle on the composer.
    stableTicks: 4,
    total: withEsc ? 240 : 220,
    cols: 100,
    rows: 32,
    out,
  }
  const cfgPath = path.join(RUN_HOME, `cfg-${tag}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  // NODE_ENV=test is a SOURCE-prover pin, not a PTY-boot pin.
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

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { railPlan } from '../../src/utils/helmGeometry.js'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const composed = '/tmp/lane-stability-composed.jsonl'
const yogaTrace = '/tmp/lane-stability-yoga.jsonl'
const commits = '/tmp/lane-stability-commits.jsonl'
for (const f of [composed, yogaTrace, commits]) {
  try { rmSync(f) } catch {  }
}

const cfg = { ...scenario('resume-2turn', 120, 44), out: '/tmp/lane-stability-grid.json', total: 60, sends: [] }
const cfgPath = '/tmp/lane-stability-cfg.json'
writeFileSync(cfgPath, JSON.stringify(cfg))
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(90000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    INK_COMPOSED_TEE: composed,
    INK_YOGA_TRACE: yogaTrace,
    INK_COMMIT_TEE: commits,
  },
})
cleanupScenario('resume-2turn')
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const contamEvents = existsSync(yogaTrace)
  ? readFileSync(yogaTrace, 'utf8').trim().split('\n').filter(Boolean).length
  : 0
check(contamEvents === 0, `yoga skip-contamination events: ${contamEvents} (want 0)`)

const lines = readFileSync(composed, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const shiftReasons = lines
  .filter(l => l.phase === 'full-damage')
  .flatMap(l => (l.reasons ?? [l.reason]).filter(Boolean) as string[])
const laneFlips = shiftReasons.filter(r => /moved:.*→24,0,1[01][0-9]x/.test(r))
check(laneFlips.length === 0, `center-lane ≥100-wide flips: ${laneFlips.length} (want 0)`)
if (laneFlips.length > 0) for (const r of laneFlips.slice(0, 4)) console.log(`    ${r}`)

const PLAN = railPlan(120)
const SLOT = 120 - PLAN.railW * (PLAN.telemetry ? 2 : 1)
const commitLines = readFileSync(commits, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const badCommits = commitLines.filter(l =>
  (l.inner ?? []).some((r: string) => {
    const w = Number(/,(\d+)x\d+$/.exec(r)?.[1] ?? /^(\d+)x/.exec(r)?.[1] ?? 0)
    return w > SLOT
  }),
)
check(badCommits.length === 0, `commits with inner column wider than the ${SLOT} slot: ${badCommits.length} (want 0)`)

check(commitLines.length < 160, `commits over the run: ${commitLines.length} (ceiling 160; pre-fix storm was ~260)`)

console.log(failures === 0 ? '✅ idle lane stability GREEN' : `❌ idle lane stability RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

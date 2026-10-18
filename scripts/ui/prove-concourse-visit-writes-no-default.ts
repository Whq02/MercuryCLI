#!/usr/bin/env bun
// gate-watch: src/components/concourse/ConcourseScreen.tsx src/components/concourse/CoordinatorModelPicker.tsx src/services/concourse/coordinatorModels.ts src/state/onChangeAppState.ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena, firstOutputTs, type ArenaOpts } from '../streaming/artifactArena.ts'
import { vshotBudgetScale } from '../lib/captureDriver.ts'
import { startCrossfamilyFixture } from '../lib/crossfamilyConcourseFixture.ts'

requireDist()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const SHIFT_LEFT = '\x1b[1;2D'
const SHIFT_RIGHT = '\x1b[1;2C'
const SHIFT_TAB = '\x1b[Z'
const DOWN = '\x1b[B'
const CTRL_S = '\x13'
const ESC = '\x1b'
const TYPED = 'draft test line, do not send'
const COORDINATOR_MODEL = 'glm-5.3'
const SETTINGS = JSON.stringify({ engine: { model: 'claude-opus-5-5', effort: 'max' } }, null, 2) + '\n'
const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const rowsWith = (rows: string[], needle: string): string => rows.filter(r => r.includes(needle)).map(r => r.trim().slice(0, 120)).join(' | ') || `(no row carries "${needle}")`

section('§1 a concourse visit — the draft, the hops, a coordinator turn on glm-5.3, the coordinator-model picker — leaves the user\'s saved default untouched')
const settleMs = Math.max(80, Math.round(300 / vshotBudgetScale()))
const step = (s: Record<string, unknown>): ArenaOpts['sends'][number] => ({ settleMs, ...s }) as ArenaOpts['sends'][number]
const chair = await startCrossfamilyFixture({ port: 0 })
const run = await runArtifactArena({
  cols: 177,
  rows: 49,
  turns: () => [{ kind: 'text', text: 'Hello there.' }],
  seedHome: configDir => {
    const cfgPath = join(configDir, '.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: COORDINATOR_MODEL }
    writeFileSync(cfgPath, JSON.stringify(cfg))
    writeFileSync(join(configDir, 'settings.json'), SETTINGS)
  },
  sends: [
    step({ awaitText: 'Type a prompt', text: SHIFT_LEFT }),
    step({ awaitText: 'COORDINATOR', text: TYPED }),
    step({ awaitText: 'do not send', text: SHIFT_RIGHT }),
    step({ awaitText: 'Type a prompt', awaitAbsent: 'COORDINATOR', text: SHIFT_LEFT }),
    step({ awaitText: 'tab here first', text: SHIFT_TAB }),
    step({ awaitText: '↵↵ sends', text: '\r' }),
    step({ awaitText: '↵ again sends', text: '\r' }),
    step({ awaitText: '[Coordinator] cma-zai', text: CTRL_S }),
    step({ awaitText: ['COORDINATOR MODEL', '↵ selects'], afterPrevMs: 800, text: DOWN }),
    step({ awaitText: ['COORDINATOR MODEL', '↵ selects'], afterPrevMs: 800, text: '\r' }),
    step({ awaitText: 'switched:', afterPrevMs: 600, text: ESC }),
  ],
  anchor: null,
  extraEnv: { MERCURY_ZAI_API_BASE: chair.env.MERCURY_ZAI_API_BASE, ZAI_API_KEY: chair.env.ZAI_API_KEY },
  seconds: 40,
  keep: true,
})
try {
  const t0 = firstOutputTs(run)
  const sent = run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('latin1'))
  check('every witnessed send fired: into the concourse, the draft, out and back, ⇧tab, ↵↵, ⌃s, ↓, ↵, esc', sent.length === 11, `${sent.length} sends: ${JSON.stringify(sent.map(s => s.slice(0, 12)))} · ${run.driverOut.slice(-300)}`)
  const [afterSend, final] = grabScreens(run, 177, 49, [Math.round((run.sendLog[7]?.sent ?? Date.now()) - t0) - 200, -1])
  check('the coordinator turn ran on glm-5.3 and answered (the GLM chair took exactly one coordinator call)', chair.captured.filter(h => h.lane === 'zai').length === 1 && chair.captured.some(h => h.lane === 'zai' && h.model === COORDINATOR_MODEL) && flat(afterSend!.rows).includes('[Coordinator] cma-zai'), `${JSON.stringify(chair.captured.map(h => `${h.lane} ${h.model}`))} · ${rowsWith(afterSend!.rows, 'Coordinator')}`)
  const finalText = flat(final!.rows)
  check('the picker pick switched the COORDINATOR model (the receipt painted and the bar names the new pick)', finalText.includes('switched:') || !finalText.includes(`coordinator · GLM-5.3`), rowsWith(final!.rows, 'coordinator ·'))
  const cfg = JSON.parse(readFileSync(join(run.paths.home, '.mercury', '.config.json'), 'utf8')) as { concourseCoordinator?: { assistModel?: string } }
  check('the pick landed in the coordinator\'s own setting, not the default', cfg.concourseCoordinator?.assistModel !== undefined && cfg.concourseCoordinator.assistModel !== COORDINATOR_MODEL, JSON.stringify(cfg.concourseCoordinator))
  const settingsPath = join(run.paths.home, '.mercury', 'settings.json')
  const after = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '(missing)'
  check('settings.json is byte-identical — engine.model is still the user\'s own', after === SETTINGS, after)
  check('settings.json was never rewritten during the run (its clock predates the first frame)', existsSync(settingsPath) && statSync(settingsPath).mtimeMs < t0, `mtime ${Math.round(statSync(settingsPath).mtimeMs - t0)} ms after the first frame`)
} finally {
  run.cleanup()
  await chair.close()
}

console.log(`\n${failures === 0 ? '✅ concourse-visit-writes-no-default PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

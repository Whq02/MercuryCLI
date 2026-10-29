#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { firstOutputTs, firstPtyVisibility, grabScreens, nodeBinPath, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const COLS = 120
const ROWS = 40
const FACE_READY = '↑↓ choose'
const COMPOSER_READY = 'Type a prompt'
const PROMPT = 'hello there'
const DUD = 'choose a model'
const DOOR = 'choose a model · /model'
const MODEL_NAME = /opus|sonnet|haiku|gpt|gemini|claude/i

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 900) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

const squash = (s: string): string => s.replace(/\s+/g, '')
const painted = (run: ArenaRun, words: string, notBefore = 0): { ts: number; text: string } | undefined => firstPtyVisibility(run.ptyReads, squash(words), notBefore)
const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const saveFrame = (name: string, rows: string[] | null): void => {
  if (frameDir && rows) writeFileSync(join(frameDir, `${name}.txt`), rows.map(steady).join('\n') + '\n')
}
const SETTLE_MS = 700
function screenAfter(run: ArenaRun, paint: { ts: number } | undefined, settleMs = SETTLE_MS): string[] | null {
  if (paint === undefined) return null
  const [frame] = grabScreens(run, COLS, ROWS, [Math.max(0, paint.ts - firstOutputTs(run) + settleMs)])
  return frame ? frame.rows : null
}
const rowsWith = (rows: string[] | null, needle: string): string[] => (rows ?? []).filter(l => l.includes(needle))
const statusRow = (rows: string[] | null): string => (rows ?? []).find(l => /(?:⇧←|shift\+←) back$/.test(l)) ?? ''
const namesAModel = (rows: string[] | null): string[] => (rows ?? []).filter(l => MODEL_NAME.test(l))
const unfired = (run: ArenaRun): string => `${run.outcome.reason ?? 'complete'} · unfired ${JSON.stringify(run.outcome.report?.unfired ?? [])}`

type HealthRow = { id: string; status?: string; evidence?: string }
function healthRows(run: ArenaRun): HealthRow[] {
  const configDir = join(run.paths.home, '.mercury')
  const env: Record<string, string> = {
    HOME: run.paths.home,
    PATH: `/usr/bin:/bin:${dirname(nodeBinPath())}`,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_DIR: join(run.paths.home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CI: 'true',
  }
  const ran = spawnSync(nodeBinPath(), [join(process.cwd(), 'dist', 'mercury.mjs'), 'health', '--json'], { cwd: run.paths.cwd, env, encoding: 'utf8', timeout: 180_000 })
  try {
    const sections = (JSON.parse(ran.stdout) as { sections?: Array<{ checks?: HealthRow[] }> }).sections ?? []
    return sections.flatMap(s => s.checks ?? [])
  } catch {
    return [{ id: 'unparsed', evidence: `${ran.stdout.slice(0, 200)} ${ran.stderr.slice(-300)}` }]
  }
}

section('§1 a home with no sign-in: the first screen, the cockpit, a sent prompt and /model name no provider\'s model — the slot holds "choose a model"')
const run = await runArtifactArena({
  turns: [],
  sends: [
    `after:${COMPOSER_READY}:1500:${PROMPT}`,
    `after:${COMPOSER_READY}:2600:\\r`,
    `after:${DOOR}:1800:/model`,
    `after:${DOOR}:2900:\\r`,
  ],
  seconds: 50,
  cols: COLS,
  rows: ROWS,
  keep: true,
  anchor: null,
  seedCwd: { 'README.md': '# a small folder\n' },
  extraEnv: { BROWSER: '/usr/bin/true', MERCURY_UPDATE_NOTICE: '0', ANTHROPIC_API_KEY: '' },
})
try {
  const home = screenAfter(run, painted(run, FACE_READY))
  const chatPaint = painted(run, 'not signed in · /logins ·')
  const chat = screenAfter(run, chatPaint)
  const doorPaint = painted(run, DOOR, chatPaint?.ts ?? 0)
  const afterSend = screenAfter(run, doorPaint)
  const pickerPaint = painted(run, 'type to search by name or id', doorPaint?.ts ?? 0)
  const picker = screenAfter(run, pickerPaint, 1200)
  saveFrame('keyless-home', home)
  saveFrame('keyless-chat', chat)
  saveFrame('keyless-after-send', afterSend)
  saveFrame('keyless-model-picker', picker)

  check('the boot face painted', home !== null && home.some(l => l.includes('New Session')), unfired(run))
  check('the first screen names no model', home !== null && namesAModel(home).length === 0, namesAModel(home).join(' | '))
  check('the Logins row says not signed in', rowsWith(home, 'Logins').some(l => l.includes('not signed in')), rowsWith(home, 'Logins').join(' | '))

  check('the chat painted its composer', chat !== null && chat.some(l => l.includes(COMPOSER_READY)), unfired(run))
  check(`the chat's model row reads "${DUD}"`, rowsWith(chat, 'model').some(l => l.includes(DUD) && l.includes('/model changes it')), rowsWith(chat, 'model').join(' | '))
  check('the hero row says not signed in and names /logins', rowsWith(chat, 'not signed in').some(l => l.includes('○ not signed in · /logins connects')), rowsWith(chat, 'signed in').join(' | '))
  check(`the status row reads "not signed in · /logins · ${DUD}" with no effort word`, new RegExp(`^\\s*not signed in · /logins · ${DUD}\\s{2,}`).test(statusRow(chat)), statusRow(chat))
  check('the cockpit names no model anywhere', chat !== null && namesAModel(chat).length === 0, namesAModel(chat).join(' | '))
  check('the composer shows no effort line for a model with none', chat !== null && !chat.some(l => /effort: /.test(l)), rowsWith(chat, 'effort').join(' | '))

  check(`a sent prompt answers with one line, "${DOOR}"`, afterSend !== null && afterSend.some(l => l.includes(PROMPT)) && rowsWith(afterSend, DOOR).length === 1, afterSend === null ? `the door never painted · ${unfired(run)}` : rowsWith(afterSend, DOOR).concat(rowsWith(afterSend, PROMPT)).join(' | '))
  check('…never a provider error, and no model named', afterSend !== null && !/401|authentication_error|invalid x-api-key|ECONNREFUSED|API Error|not a model id any provider family declares/.test(afterSend.join('\n')) && namesAModel(afterSend).length === 0, afterSend === null ? '' : namesAModel(afterSend).concat((afterSend ?? []).filter(l => /API Error|declares/.test(l))).join(' | '))

  check('/model opens the picker', picker !== null && picker.some(l => l.includes('type to search by name or id')), picker === null ? `the picker never painted · ${unfired(run)}` : '')
  check('…which marks no row current (nothing was chosen) and paints without error', picker !== null && !picker.some(l => /\bcurrent\b/.test(l) && MODEL_NAME.test(l)) && !picker.some(l => l.includes('RENDER ERROR')), (picker ?? []).filter(l => /\bcurrent\b|RENDER ERROR/.test(l)).join(' | '))

  section('§2 /health in that home: the Model pins row names the entry, the Default model row the way in')
  const rows = healthRows(run)
  const pins = rows.find(r => r.id === 'model')
  const frontier = rows.find(r => r.id === 'frontier')
  check(`Model pins reads "session model ${DUD} · no settings pin"`, pins?.evidence === `session model ${DUD} · no settings pin` && pins.status === 'ok', JSON.stringify(pins ?? rows[0]))
  check('Default model says no sign-in yet and names /logins, no model', frontier !== undefined && /^no sign-in yet · /.test(frontier.evidence ?? '') && (frontier.evidence ?? '').includes('/logins') && !MODEL_NAME.test(frontier.evidence ?? ''), JSON.stringify(frontier))
} finally {
  run.cleanup()
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-choose-a-model — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-choose-a-model — all checks pass')
process.exit(0)

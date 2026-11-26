#!/usr/bin/env bun
// gate-watch: src/models/catalogue/computedDefault.ts src/models/catalogue/engineModel.ts src/models/roads/callModelRouter.ts
// gate-watch: src/models/sign-in/accounts/sessionSignIn.ts src/screen/messages/AssistantTextMessage.tsx src/platform/health/healthReport.ts src/models/facts/capabilities.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nodeBinPath, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const COLS = 120
const ROWS = 40
const FACE_READY = '>_  ·  ↵  ·  ↑↓'
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

const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const saveFrame = (name: string, rows: string[] | null): void => {
  if (frameDir && rows) writeFileSync(join(frameDir, `${name}.txt`), rows.map(steady).join('\n') + '\n')
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
    { awaitText: [FACE_READY, 'New Session'], text: '' },
    { awaitText: [COMPOSER_READY, 'not signed in · /logins ·'], text: PROMPT },
    { awaitText: `❯ ${PROMPT}`, text: '\r' },
    { awaitText: DOOR, text: '\x15/model' },
    { awaitText: '❯ /model', text: '\r' },
    { awaitText: 'type to search by name or id', text: '' },
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
  const frameAt = (step: number): string[] | null => run.sendLog.find(row => row.step === step)?.screen?.map(row => row.trimEnd()) ?? null
  const home = frameAt(0)
  const chat = frameAt(1)
  const afterSend = frameAt(3)
  const picker = frameAt(5)
  saveFrame('keyless-home', home)
  saveFrame('keyless-chat', chat)
  saveFrame('keyless-after-send', afterSend)
  saveFrame('keyless-model-picker', picker)

  check('the boot face painted', home !== null && home.some(l => l.includes('New Session')), 'the boot face never painted New Session before the wait ended, see the unfired sends: ' + unfired(run))
  check('the first screen names no model', home !== null && namesAModel(home).length === 0, 'the boot face must show no model name while nothing is signed in, so the model row there must read no sign-in yet (NO_SIGN_IN_ROW in src/models/catalogue/computedDefault.ts); rows naming a model: ' + namesAModel(home).join(' | '))
  check('the boot face status line says no sign-in yet', rowsWith(home, 'Model ').some(l => l.includes('no sign-in yet')), 'the boot face Model row must say no sign-in yet (NO_SIGN_IN_ROW in src/models/catalogue/computedDefault.ts): ' + rowsWith(home, 'Model ').join(' | '))

  check('the chat painted its composer', chat !== null && chat.some(l => l.includes(COMPOSER_READY)), 'the chat composer never painted before the wait ended, see the unfired sends: ' + unfired(run))
  check(`the chat's model row reads "${DUD}"`, rowsWith(chat, 'model').some(l => l.includes(DUD) && l.includes('/model')), 'the chat model row must read choose a model (CHOOSE_A_MODEL_WORDS in src/models/facts/chooseAModel.ts) followed by /model: ' + rowsWith(chat, 'model').join(' | '))
  check('the hero row says not signed in and names /logins', rowsWith(chat, 'not signed in').some(l => l.includes('○ not signed in · /logins connects')), 'the chat hero row must read ○ not signed in · /logins connects: ' + rowsWith(chat, 'signed in').join(' | '))
  check(`the status row reads "not signed in · /logins · ${DUD}" with no effort word`, new RegExp(`^\\s*not signed in · /logins · ${DUD}\\s{2,}`).test(statusRow(chat)), 'the chat status row must start with not signed in · /logins · choose a model and carry no effort word: ' + statusRow(chat))
  check('the cockpit names no model anywhere', chat !== null && namesAModel(chat).length === 0, 'the chat cockpit must name no model while nothing is signed in, use the choose a model words (CHOOSE_A_MODEL_WORDS in src/models/facts/chooseAModel.ts); rows naming a model: ' + namesAModel(chat).join(' | '))
  check('the composer shows no effort line for a model with none', chat !== null && !chat.some(l => /effort: /.test(l)), 'the composer must print no effort line while the model slot holds choose a model: ' + rowsWith(chat, 'effort').join(' | '))

  check(`a sent prompt answers with one line, "${DOOR}"`, afterSend !== null && afterSend.some(l => l.includes(PROMPT)) && rowsWith(afterSend, DOOR).length === 1, 'a prompt sent with no sign-in must be answered by the single line choose a model · /model (CHOOSE_A_MODEL_DOOR in src/models/facts/chooseAModel.ts): ' + (afterSend === null ? `the door never painted · ${unfired(run)}` : rowsWith(afterSend, DOOR).concat(rowsWith(afterSend, PROMPT)).join(' | ')))
  check('…never a provider error, and no model named', afterSend !== null && !/401|authentication_error|invalid x-api-key|ECONNREFUSED|API Error|not a model id any provider family declares/.test(afterSend.join('\n')) && namesAModel(afterSend).length === 0, 'a prompt sent with no sign-in must reach no provider and name no model, so it must answer with the choose a model door (CHOOSE_A_MODEL_DOOR in src/models/facts/chooseAModel.ts): ' + (afterSend === null ? '' : namesAModel(afterSend).concat((afterSend ?? []).filter(l => /API Error|declares/.test(l))).join(' | ')))

  check('/model opens the picker', picker !== null && picker.some(l => l.includes('type to search by name or id')), picker === null ? `the /model picker never painted before the wait ended, see the unfired sends · ${unfired(run)}` : 'the /model picker must show its type to search by name or id line')
  check('…which marks no row current (nothing was chosen) and paints without error', picker !== null && !picker.some(l => /\bcurrent\b/.test(l) && MODEL_NAME.test(l)) && !picker.some(l => l.includes('RENDER ERROR')), 'the /model picker must mark no row current when no model was chosen and must not hit a render error: ' + (picker ?? []).filter(l => /\bcurrent\b|RENDER ERROR/.test(l)).join(' | '))

  section('§2 /health in that home: the Model pins row names the entry, the Default model row the way in')
  const rows = healthRows(run)
  const pins = rows.find(r => r.id === 'model')
  const frontier = rows.find(r => r.id === 'frontier')
  check(`Model pins reads "session model ${DUD} · no settings pin"`, pins?.evidence === `session model ${DUD} · no settings pin` && pins.status === 'ok', 'change the model row of the health report in src/platform/health/sections/settings/model.ts so a keyless home reads choose a model with status ok: ' + JSON.stringify(pins ?? rows[0]))
  check('Default model says no sign-in yet and names /logins, no model', frontier !== undefined && /^no sign-in yet · /.test(frontier.evidence ?? '') && (frontier.evidence ?? '').includes('/logins') && !MODEL_NAME.test(frontier.evidence ?? ''), 'the Default model health row must start with no sign-in yet (NO_SIGN_IN_ROW in src/models/catalogue/computedDefault.ts), name /logins and name no model: ' + JSON.stringify(frontier))
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

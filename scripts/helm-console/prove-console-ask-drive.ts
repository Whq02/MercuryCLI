#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, runArtifactArena, requireDist } from '../streaming/artifactArena.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/utils/model/configs.ts'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const FRAMES = arg('--frames')
const DIST = arg('--dist')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
if (DIST === undefined) requireDist()
else if (!existsSync(DIST)) {
  console.error(`${DIST} missing`)
  process.exit(2)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const MAIN = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty
const OTHER = ALL_MODEL_CONFIGS[newestGenerationKey('sonnet')].firstParty
const COLS = 140
const ROWS = 44
const QUESTION = 'can u lmk what the cube colour is'
const MAIN_ANSWER = 'The cube is red.'
const CONSOLE_ANSWER = 'The console says the cube is red.'
const ERROR_WORDS = ['An API error occurred', 'Cannot read properties']

console.log('============================================================')
console.log(' console ask drive — a question typed into /console is answered, never an API error')
console.log('============================================================')
console.log(`  main ${MAIN} · console pins: ${OTHER} (≠ main) and ${MAIN} (= main)`)

async function leg(tag: string, consoleModel: string): Promise<void> {
  console.log(`\n── ${tag}: console pinned to ${consoleModel}`)
  const consoleGate = consoleModel === MAIN ? 'opus' : 'sonnet'
  const run = await runArtifactArena({
    ...(DIST !== undefined ? { distPath: DIST } : {}),
    turns: [
      { kind: 'text', text: MAIN_ANSWER, thinking: 'The operator asks about the cube.', whenModel: 'opus', whenBody: 'what colour is the cube' },
      { kind: 'text', text: CONSOLE_ANSWER, whenModel: consoleGate, whenBody: 'Side question' },
      { kind: 'text', text: 'Spare answer.' },
    ],
    sends: [
      'after:Type a prompt:1500:what colour is the cube\r',
      'after:cube is red:2500:/console',
      'after:side questions from the cockpit:800:\r',
      `after:ask anything:1200:${QUESTION}`,
      'after:ask anything:3500:\r',
    ],
    seconds: 32,
    cols: COLS,
    rows: ROWS,
    keep: true,
    extraEnv: { MERCURY_MODEL: MAIN, MERCURY_CONSOLE_MODEL: consoleModel, MERCURY_CACHE_CLOCK: '0' },
  })
  try {
    const unfired = run.outcome.report?.unfired ?? []
    check(`${tag}: the capture completed and every send fired`, run.outcome.complete && unfired.length === 0, `${run.outcome.reason ?? ''} ${JSON.stringify(unfired)}`)
    const final = grabScreens(run, COLS, ROWS, [-1])[0]!.rows.join('\n')
    if (FRAMES !== undefined) writeFileSync(join(FRAMES, `console-ask-${tag}.txt`), final + '\n')
    const requests = run.fixture.messageRequests().map(r => (r.body as { model?: string; messages?: unknown[] }))
    const consoleRequests = requests.filter(r => typeof r.model === 'string' && r.model === consoleModel && JSON.stringify(r.messages ?? []).includes('Side question'))
    check(`${tag}: the main turn answered on screen`, final.includes(MAIN_ANSWER), final.slice(-600))
    check(`${tag}: the console's request reached the wire on the pinned model`, consoleRequests.length === 1, requests.map(r => r.model).join(', ') || '(no requests)')
    check(`${tag}: the console's request carries the shared context and the question`, consoleRequests.length === 1 && (consoleRequests[0]!.messages?.length ?? 0) >= 3 && JSON.stringify(consoleRequests[0]!.messages).includes(QUESTION))
    check(`${tag}: the console painted the answer`, final.includes(CONSOLE_ANSWER), final.split('\n').filter(l => l.includes('console') || l.includes('cube')).join(' | '))
    check(`${tag}: the receipt row carries the duration and the token figure`, /\d+s · \d[\d.]*[km]?→\d/.test(final), final.split('\n').find(l => /\ds ·/.test(l)) ?? '(no receipt row)')
    check(`${tag}: no API-error card and no raw TypeError on the screen`, ERROR_WORDS.every(w => !final.includes(w)), final.split('\n').find(l => ERROR_WORDS.some(w => l.includes(w))) ?? '')
    check(`${tag}: the history row shows the ask without an err mark`, final.split('\n').some(l => l.includes(QUESTION) && /→/.test(l) && !/\berr\b/.test(l)), final.split('\n').find(l => l.includes(QUESTION)) ?? '')
  } finally {
    if (failures === 0) run.cleanup()
    else console.log(`  [forensics] arena kept: ${run.paths.home}`)
  }
}

await leg('other-model', OTHER)
await leg('same-model', MAIN)

console.log('')
if (failures > 0) {
  console.log(`prove-console-ask-drive: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-console-ask-drive: ALL GREEN')

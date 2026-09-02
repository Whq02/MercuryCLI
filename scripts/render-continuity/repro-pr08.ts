#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/repro-pr08.ts — (D5) reproduction: the frame
//  anatomy of streamed answers across four scenes.
//
//    A short-paced   — 10 deltas x 400ms + settleDelayMs 1800 (settle swap
//                      isolated; the baseline scene).
//    B thinking-first— thinking deltas then text (the chrome handoff).
//    C long-scroll   — 24 paragraph deltas x 250ms; the answer outgrows the
//                      viewport mid-stream (the field shape for "assembles
//                      in separate pieces").
//    D interrupt     — esc mid-stream; the row must mutate truthfully and
//                      keep received text.
//
//  Per-frame structural anatomy: text rows, nameplate rows, settled user row,
//  which tokens are visible, and DUPLICATE-content detection (the same token
//  painted on more than one row = tail + settled list double-paint).
//
//  Exit 0 = journeys conclusive (receipt written, verdict per scene).
//  Exit 2 = a scene failed to run.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPulseArena } from '../pulse/lib/pulseArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const RECEIPTS = join(HERE, 'receipts')

const TOKENS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar',
  'papa', 'quebec', 'romeo', 'sierra', 'tango',
  'uniform', 'victor', 'whiskey', 'xray',
]
const TOKEN_RE = new RegExp(`(${TOKENS.join('|')}) stream body`)

type Frame = { atMs: number; rows: string[] }
type Anat = {
  atMs: number
  textStartRow: number
  nameplateRows: number[]
  userRow: number
  visible: string[]
  dupTokens: string[]
}

const analyse = (s: Frame): Anat => {
  const textRowIdx = s.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => TOKEN_RE.test(r))
    .map(({ i }) => i)
  const visible = TOKENS.filter(t => s.rows.some(r => r.includes(`${t} stream body`)))
  const dupTokens = TOKENS.filter(
    t => s.rows.filter(r => r.includes(`${t} stream body`)).length > 1,
  )
  const nameplateRows = s.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.includes('[Mercury]'))
    .map(({ i }) => i)
  const userRow = s.rows.findIndex(r => r.includes('anatomy probe') && r.includes('❯'))
  return {
    atMs: s.atMs,
    textStartRow: textRowIdx.length ? textRowIdx[0] : -1,
    nameplateRows,
    userRow,
    visible,
    dupTokens,
  }
}

type Scene = {
  name: string
  turns: ScriptedTurn[]
  sends: string[]
  seconds: number
  grabFrom: number
  grabTo: number
  grabStep: number
}

const ESC = String.fromCharCode(27)

const scenes: Scene[] = [
  {
    name: 'A short-paced + held settle',
    turns: [
      {
        kind: 'paced',
        deltas: TOKENS.slice(0, 10).map(t => `${t} stream body. `),
        gapMs: 400,
        settleDelayMs: 1800,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['2000:\\r', '6000:stream anatomy probe\\r'],
    seconds: 15,
    grabFrom: 6200,
    grabTo: 12600,
    grabStep: 400,
  },
  {
    name: 'B thinking-first',
    turns: [
      {
        kind: 'stream',
        blocks: [
          {
            type: 'thinking',
            deltas: ['weighing the anatomy request... ', 'choosing a structure... ', 'settling the plan. '],
          },
          { type: 'text', deltas: TOKENS.slice(0, 8).map(t => `${t} stream body. `) },
        ],
        gapMs: 350,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['2000:\\r', '6000:thinking anatomy probe\\r'],
    seconds: 15,
    grabFrom: 6200,
    grabTo: 12200,
    grabStep: 300,
  },
  {
    name: 'C long-scroll pressure',
    turns: [
      {
        kind: 'paced',
        deltas: TOKENS.map(t => `${t} stream body paragraph.\n\n`),
        gapMs: 250,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['2000:\\r', '6000:long anatomy probe\\r'],
    seconds: 16,
    grabFrom: 6200,
    grabTo: 13400,
    grabStep: 300,
  },
  {
    name: 'D interrupt mid-stream',
    turns: [
      {
        kind: 'paced',
        deltas: TOKENS.slice(0, 10).map(t => `${t} stream body. `),
        gapMs: 400,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['2000:\\r', '6000:interrupt anatomy probe\\r', `8000:${ESC}`],
    seconds: 13,
    grabFrom: 6200,
    grabTo: 11000,
    grabStep: 300,
  },
  {
    name: 'E tool-interleaved (prose -> tool -> prose)',
    turns: [
      {
        kind: 'paced_tool_use',
        preDeltas: ['alpha stream body before the tool. ', 'bravo stream body still before. '],
        gapMs: 350,
        tools: [
          {
            name: 'Agent',
            input: {
              description: 'poise piece probe',
              prompt: 'Reply done.',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
      },
      // The spawned agent's own call.
      { kind: 'text', text: 'done' },
      // Main post-tool continuation — the SECOND prose piece of the turn.
      {
        kind: 'paced',
        deltas: ['charlie stream body after the tool. ', 'delta stream body closing. '],
        gapMs: 350,
      },
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare2.' },
    ],
    sends: ['2000:\\r', '6000:pieces anatomy probe\\r'],
    seconds: 16,
    grabFrom: 6200,
    grabTo: 13400,
    grabStep: 300,
  },
  {
    name: 'F markdown restyle under stream',
    turns: [
      {
        kind: 'paced',
        deltas: [
          '## alpha stream body heading\n\n',
          'bravo stream body **bold opens ',
          'and charlie stream body closes** then\n\n',
          '```\ndelta stream body in a fence\n',
          'echo stream body second fence row\n```\n\n',
          'foxtrot stream body tail prose. ',
        ],
        gapMs: 500,
      },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['2000:\\r', '6000:markdown anatomy probe\\r'],
    seconds: 14,
    grabFrom: 6200,
    grabTo: 11600,
    grabStep: 200,
  },
]

const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}

log('── PR-08 (D5) stream frame-anatomy receipt — six scenes ──')

const frameStore: { scene: string; frames: Frame[] }[] = []
let inconclusive = false

for (const scene of scenes) {
  const run = await runPulseArena({
    turns: scene.turns,
    sends: scene.sends,
    seconds: scene.seconds,
    cols: 120,
    rows: 40,
    keep: true,
  })
  const offsets: number[] = []
  for (let t = scene.grabFrom; t <= scene.grabTo; t += scene.grabStep) offsets.push(t)
  offsets.push(-1)
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets.map(String)],
    { encoding: 'utf8' },
  )
  if (grab.status !== 0) {
    console.error(`screengrab failed for ${scene.name}: ${grab.stderr}`)
    inconclusive = true
    run.cleanup()
    continue
  }
  const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
  frameStore.push({ scene: scene.name, frames: screens })

  const anats = screens.map(analyse)
  const withText = anats.filter(a => a.textStartRow !== -1 && a.atMs !== -1)
  const settledA = anats[anats.length - 1]

  log('')
  log(`━━ scene ${scene.name} ━━`)
  log('  atMs | text@ | nameplates@ | user@ | visible | dups')
  for (const a of anats) {
    log(
      `  ${String(a.atMs).padStart(5)} | ${String(a.textStartRow).padStart(5)} | ${a.nameplateRows.join(',').padEnd(11)} | ${String(a.userRow).padStart(5)} | ${(a.visible[0] ?? '') + '..' + (a.visible[a.visible.length - 1] ?? '')} | ${a.dupTokens.join(',')}`,
    )
  }

  // Row-content instability: a token row's TEXT changes in a later frame
  // while both frames still show it (restyle/reflow repaint of settled rows).
  const instability: string[] = []
  for (let i = 1; i < screens.length; i++) {
    if (screens[i].atMs === -1) continue
    for (const tok of TOKENS.slice(0, 10)) {
      const prevRow = screens[i - 1].rows.find(r => r.includes(`${tok} stream body`))
      const curRow = screens[i].rows.find(r => r.includes(`${tok} stream body`))
      if (
        prevRow !== undefined &&
        curRow !== undefined &&
        prevRow.trim() !== curRow.trim() &&
        // growth of the LAST visible token's own row is the live edge, not
        // instability; flag only non-tail rows that changed
        !curRow.trim().startsWith(prevRow.trim().slice(0, Math.max(8, prevRow.trim().length - 4)))
      ) {
        instability.push(`@${screens[i].atMs} ${tok}: "${prevRow.trim().slice(0, 60)}" -> "${curRow.trim().slice(0, 60)}"`)
      }
    }
  }

  const textNoNameplate = withText.filter(a => a.nameplateRows.length === 0)
  const lastLive = withText[withText.length - 1]
  const textHop =
    lastLive &&
    settledA.textStartRow !== -1 &&
    lastLive.textStartRow !== settledA.textStartRow
  const userRowShifts =
    new Set(withText.filter(a => a.userRow !== -1).map(a => a.userRow)).size > 1
  const dupAnywhere = anats.some(a => a.dupTokens.length > 0)
  // Settle window jump: the set of visible tokens changes at settlement
  // without new deltas (scene C: tail-anchored -> list-anchored jump).
  const settleWindowJump =
    lastLive &&
    settledA.visible.length > 0 &&
    (settledA.visible[0] !== lastLive.visible[0] ||
      settledA.visible[settledA.visible.length - 1] !==
        lastLive.visible[lastLive.visible.length - 1])

  log(`  -> frames with text but NO nameplate: ${textNoNameplate.length}`)
  log(`  -> text start row hop at settle: ${textHop} (${lastLive?.textStartRow} -> ${settledA.textStartRow})`)
  log(`  -> settled user row shifts mid-stream: ${userRowShifts}`)
  log(`  -> duplicate token rows anywhere: ${dupAnywhere}`)
  log(`  -> non-tail row content instability events: ${instability.length}`)
  for (const ev of instability.slice(0, 8)) log(`       ${ev}`)
  log(`  -> visible-window jump at settle: ${settleWindowJump} (${lastLive?.visible[0]}..${lastLive?.visible[lastLive.visible.length - 1]} -> ${settledA.visible[0]}..${settledA.visible[settledA.visible.length - 1]})`)
  if (scene.name.startsWith('D')) {
    const preEsc = anats.filter(a => a.atMs !== -1 && a.atMs <= 8000).pop()
    const kept =
      preEsc &&
      settledA.visible.length >= preEsc.visible.length &&
      preEsc.visible.every(v => settledA.visible.includes(v))
    const interruptMarker = screens[screens.length - 1].rows.some(r =>
      /interrupt/i.test(r),
    )
    log(`  -> received text kept after esc: ${kept}`)
    log(`  -> truthful interrupted marker present: ${interruptMarker}`)
  }
  run.cleanup()
}

for (const { scene, frames } of frameStore) {
  lines.push(`\n════════ ${scene} — frames ════════`)
  for (const s of frames) {
    lines.push(`\n════ screen @${s.atMs}ms ════`)
    lines.push(s.rows.filter(r => r.trim() !== '').join('\n'))
  }
}

mkdirSync(RECEIPTS, { recursive: true })
writeFileSync(join(RECEIPTS, 'pr08-head-6fe78a3d.txt'), lines.join('\n'))
console.log('\nreceipt: scripts/render-continuity/receipts/pr08-head-6fe78a3d.txt')
process.exit(inconclusive ? 2 : 0)

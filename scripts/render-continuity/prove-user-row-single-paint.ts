#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena } = await import('../pulse/lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()
const DUMP = process.env.SINGLE_PAINT_DUMP === '1'

type Frame = { atMs: number; rows: string[] }

type Scene = {
  name: string
  probes: string[]
  turns: ScriptedTurn[]
  sends: string[]
  seconds: number
  tailMs: number
  grabStep: number
}

const scenes: Scene[] = [
  {
    name: 'A paced stream + held settle (the pre-settle overlap window)',
    probes: ['duplicate paint probe'],
    turns: [
      { kind: 'paced', deltas: ['alpha stream body. ', 'bravo stream body. ', 'charlie stream body. ', 'delta stream body. '], gapMs: 400, settleDelayMs: 2000 },
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:duplicate paint probe\\r'],
    seconds: 20,
    tailMs: 7050,
    grabStep: 150,
  },
  {
    name: 'B error turn (401 — the not-logged-in class)',
    probes: ['errored paint probe'],
    turns: [
      { kind: 'error', status: 401, errorType: 'authentication_error', message: 'OAuth token has expired.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:errored paint probe\\r'],
    seconds: 16,
    tailMs: 4420,
    grabStep: 120,
  },
  {
    name: 'C queued follow-up (submit during an active turn)',
    probes: ['duplicate paint probe', 'queued follow probe'],
    turns: [
      { kind: 'paced', deltas: ['alpha stream body. ', 'bravo stream body. ', 'charlie stream body. ', 'delta stream body. '], gapMs: 500, settleDelayMs: 1500 },
      { kind: 'text', text: 'Follow answer.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:duplicate paint probe\\r', 'after:alpha stream body.:700:queued follow probe\\r'],
    seconds: 22,
    tailMs: 7750,
    grabStep: 150,
  },
  {
    name: 'F trailing-whitespace draft (one Enter clears the composer)',
    probes: ['trailing space probe'],
    turns: [
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:trailing space probe \\r'],
    seconds: 16,
    tailMs: 3150,
    grabStep: 150,
  },
  {
    name: 'G two return atoms in ONE chunk (a held key) = ONE submission',
    probes: ['double enter probe'],
    turns: [
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:double enter probe\\r\\r'],
    seconds: 18,
    tailMs: 5150,
    grabStep: 150,
  },
]

function driveZero(drivePath: string): number {
  for (const line of readFileSync(drivePath, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line) as { ts?: number }
      if (typeof r.ts === 'number') return r.ts
    } catch {
    }
  }
  return 0
}

function sendOffOf(sendLog: Array<{ sent: number; b64: string }>, needle: string, zero: number): number | null {
  const hit = sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').includes(needle))
  return hit ? hit.sent - zero : null
}

function transcriptHits(rows: string[], probe: string): number[] {
  const hits: number[] = []
  const sigiled = new RegExp(`❯[^│]*${probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  rows.forEach((row, index) => {
    if (!row.includes(probe)) return
    if (!sigiled.test(row)) return
    hits.push(index)
  })
  return hits
}

for (const scene of scenes) {
  const run = await runPulseArena({
    turns: scene.turns,
    sends: scene.sends,
    seconds: scene.seconds,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section(scene.name)
  t.check(`the journey ran whole (${scene.sends.length} sends delivered)`, run.sendLog.length === scene.sends.length, `${run.sendLog.length}/${scene.sends.length}`)
  const zero = driveZero(run.paths.drive)
  const probeOffs = scene.probes
    .map(p => sendOffOf(run.sendLog, p, zero))
    .filter((v): v is number => v !== null)
  if (probeOffs.length !== scene.probes.length) {
    t.check('every probe send is in the drive log', false, `${probeOffs.length}/${scene.probes.length}`)
    run.cleanup()
    continue
  }
  const offsets: string[] = []
  const from = Math.min(...probeOffs) + S(150)
  const to = Math.max(...probeOffs) + S(scene.tailMs)
  for (let ms = from; ms <= to; ms += S(scene.grabStep)) offsets.push(String(Math.round(ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
    run.cleanup()
    continue
  }
  const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
  const final = screens[screens.length - 1]!
  const timed = screens.filter(f => f.atMs !== -1)

  for (const probe of scene.probes) {
    const frames = [...timed, final]
    const firstPaintIdx = frames.findIndex(f => transcriptHits(f.rows, probe).length > 0)
    t.check(`「${probe}」 paints at all`, firstPaintIdx !== -1)
    if (firstPaintIdx === -1) continue
    let doubled: Frame | null = null
    let gap: Frame | null = null
    for (const f of frames.slice(firstPaintIdx)) {
      const hits = transcriptHits(f.rows, probe)
      if (hits.length > 1 && doubled === null) doubled = f
      if (hits.length === 0 && gap === null) gap = f
      if (DUMP) {
        console.log(`  frame@${f.atMs} 「${probe}」 x${hits.length}`)
        for (const h of hits) console.log(`      row${h}: ${f.rows[h]!.trimEnd()}`)
      }
    }
    if (doubled) {
      console.log(`  DOUBLED frame@${doubled.atMs}:`)
      for (const h of transcriptHits(doubled.rows, probe)) {
        console.log(`      row${h}: ${doubled.rows[h]!.trimEnd()}`)
      }
    }
    t.check(`「${probe}」 paints on EXACTLY ONE row in every frame from first paint to final`, doubled === null, doubled ? `doubled at ${doubled.atMs}ms` : '')
    t.check(`「${probe}」 never vanishes after first paint (no gap frame)`, gap === null, gap ? `gone at ${gap.atMs}ms` : '')
  }
  run.cleanup()
}

{
  const { readdirSync, readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const run = await runPulseArena({
    turns: [
      { kind: 'text', text: 'Spare one.' },
      { kind: 'text', text: 'Spare two.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:/mod', 'after:Type a prompt:2100:\\r'],
    seconds: 17,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section('D menu-open slash Enter (one execution, no duplicate)')
  t.check('the journey ran whole (3 sends delivered)', run.sendLog.length === 3, `${run.sendLog.length}/3`)
  const dZero = driveZero(run.paths.drive)
  const acceptOff = sendOffOf(run.sendLog, '/mod', dZero)
  const dMid = acceptOff !== null ? String(Math.round(acceptOff + S(2800))) : '-1'
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', dMid, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    const anyFrameHas = (needle: string): boolean =>
      screens.some(f => f.rows.some(r => r.includes(needle)))
    t.check(
      'the accepted command EXECUTED (the /model picker is on screen)',
      anyFrameHas('CHOOSE A MODEL'),
    )
    t.check(
      'no junk raw-prefix execution painted (no Unknown-skill row)',
      !anyFrameHas('Unknown skill'),
    )
  }
  let logText = ''
  const projectsRoot = join(run.paths.home, '.claude', 'projects')
  if (existsSync(projectsRoot)) {
    for (const dir of readdirSync(projectsRoot)) {
      const pdir = join(projectsRoot, dir)
      for (const f of readdirSync(pdir)) {
        if (f.endsWith('.jsonl')) logText += readFileSync(join(pdir, f), 'utf8')
      }
    }
  }
  t.check('the session log records no Unknown-skill execution', !logText.includes('Unknown skill'))
  t.check(
    'the session log records no queued duplicate submission',
    !(logText.includes('"operation":"enqueue"') && logText.includes('/model')),
  )
  run.cleanup()
}

{
  const run = await runPulseArena({
    turns: [{ kind: 'text', text: 'Spare.' }],
    sends: [
      'after:New Session:800:\\r',
      'after:Type a prompt:900:\t',
      'after:Type a prompt:1600:railprobe',
      `after:Type a prompt:3400:${String.fromCharCode(27)}`,
      `after:Type a prompt:4000:${String.fromCharCode(27)}`,
      'after:Type a prompt:4700:composerprobe',
    ],
    seconds: 18,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section('E rail compose one-owner (tab-then-type)')
  t.check('the journey ran whole (6 sends delivered)', run.sendLog.length === 6, `${run.sendLog.length}/6`)
  const eZero = driveZero(run.paths.drive)
  const railOff = sendOffOf(run.sendLog, 'railprobe', eZero)
  const composerOff = sendOffOf(run.sendLog, 'composerprobe', eZero)
  const offsets: string[] = []
  if (railOff !== null) for (let ms = railOff + S(500); ms <= railOff + S(2000); ms += S(300)) offsets.push(String(Math.round(ms)))
  if (composerOff !== null) for (let ms = composerOff + S(1600); ms <= composerOff + S(2600); ms += S(500)) offsets.push(String(Math.round(ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    const count = (f: Frame, needle: string): number =>
      f.rows.filter(r => r.includes(needle)).length
    const railFrames = screens.filter(f => count(f, 'railprobe') > 0)
    t.check('the rail compose received the typed text', railFrames.length > 0)
    const railDoubled = railFrames.find(f => count(f, 'railprobe') > 1)
    if (railDoubled) {
      for (const r of railDoubled.rows) {
        if (r.includes('railprobe')) console.log(`      leak row: ${r.trimEnd()}`)
      }
    }
    t.check(
      'rail-compose keystrokes paint in EXACTLY ONE place (no composer leak)',
      railDoubled === undefined,
      railDoubled ? `doubled at ${railDoubled.atMs}ms` : '',
    )
    const composerFrames = screens.filter(f => count(f, 'composerprobe') > 0)
    t.check('the composer received the post-Esc typing', composerFrames.length > 0)
    const composerDoubled = composerFrames.find(f => count(f, 'composerprobe') > 1)
    t.check(
      'composer keystrokes paint in EXACTLY ONE place (no rail leak)',
      composerDoubled === undefined,
      composerDoubled ? `doubled at ${composerDoubled.atMs}ms` : '',
    )
    const final = screens[screens.length - 1]!
    t.check('the exited compose leaves no residue in the final frame', count(final, 'railprobe') === 0)
  }
  run.cleanup()
}

t.finish('prove-user-row-single-paint')

#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import { grabScreens, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.ts'
import { paneWindow } from '../../src/components/mercury-ui/paneWindow.ts'
import { railTailParts } from '../../src/components/concourse/NeedsYouRail.tsx'
import { referenceFixtureSnapshot } from './concourseReferenceSeed.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
scratchRoot('concourse-rail')
requireDist()


const TITLES = ['RAILQONE', 'RAILQTWO', 'RAILQTHREE', 'RAILQFOUR', 'RAILQFIVE'] as const

const fixture = referenceFixtureSnapshot() as { needsYou: unknown; counts: Record<string, unknown> }
fixture.needsYou = TITLES.map((title, i) => ({
  obligationId: `b1-rail-${i + 1}`,
  sessionId: `b1-rail-session-${i + 1}`,
  title,
  question: `rail window walk question ${i + 1}`,
  projectLabel: 'Moodle',
  agentLabel: 'Mercury',
  ageLabel: `${i + 1}m`,
}))
fixture.counts['needsYou'] = 5

const fixtureDir = mkdtempSync(join(tmpdir(), 'concourse-rail-'))
const fixturePath = join(fixtureDir, 'concourse-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))


const run: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [
    'after:RAILQONE:1200: ',
    'after:RAILQONE:1800:\t',
    'after:RAILQONE:2400:\t',
    'after:RAILQONE:3000:\t',
    'after:RAILQONE:3800:\x1b[B',
    'after:RAILQONE:4600:\x1b[B',
    'after:↑1:800:\x1b[B',
    'after:↑2:800:\x1b[B',
  ],
  seconds: 16,
  cols: 142,
  rows: 38,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir, 'crew'),
  },
})

try {
  const offsets: number[] = []
  for (let ms = S(2500); ms <= S(15500); ms += S(400)) offsets.push(ms)
  offsets.push(-1)
  const grabs = grabScreens(run, 142, 38, offsets)

  interface RailView {
    atMs: number
    railLine: string
    titlesOn: Set<string>
  }
  const views: RailView[] = grabs.map(g => {
    const railLine = g.rows.find(r => r.includes('NEEDS YOU')) ?? ''
    const text = g.rows.join('\n')
    return {
      atMs: g.atMs,
      railLine,
      titlesOn: new Set(TITLES.filter(x => text.includes(x))),
    }
  })

  const stateOf = (v: RailView, on: string[], off: string[]): boolean =>
    on.every(x => v.titlesOn.has(x)) && off.every(x => !v.titlesOn.has(x))

  const s0 = views.find(
    v => stateOf(v, ['RAILQONE', 'RAILQTWO', 'RAILQTHREE'], ['RAILQFOUR', 'RAILQFIVE']) && v.railLine !== '',
  )
  const s2 = views.find(
    v => stateOf(v, ['RAILQTWO', 'RAILQTHREE', 'RAILQFOUR'], ['RAILQONE', 'RAILQFIVE']) && v.railLine !== '',
  )
  const s3 = views.find(
    v => stateOf(v, ['RAILQTHREE', 'RAILQFOUR', 'RAILQFIVE'], ['RAILQONE', 'RAILQTWO']) && v.railLine !== '',
  )

  if (!s0 || !s2 || !s3) {
    for (const v of views) {
      console.log(
        `    [view] @${v.atMs} [${TITLES.filter(x => v.titlesOn.has(x)).map(x => x.slice(5)).join(',')}] ${v.railLine.trim().slice(0, 60)}`,
      )
    }
    let streamStart: number | undefined
    const seenAt = new Map<string, number>()
    for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as { ts?: number; b64?: string; sent?: number; after?: string; atMs?: number }
        if (typeof e.sent === 'number') {
          console.log(`    [sent] atMs=${e.atMs} after=${e.after ?? '(fixed)'} payload=${JSON.stringify(Buffer.from(e.b64 ?? '', 'base64').toString('latin1'))}`)
        } else if (typeof e.ts === 'number' && typeof e.b64 === 'string') {
          streamStart ??= e.ts
          const text = Buffer.from(e.b64, 'base64').toString('latin1')
          for (const n of TITLES) {
            if (!seenAt.has(n) && text.includes(n)) seenAt.set(n, e.ts - streamStart)
          }
        }
      } catch {
      }
    }
    console.log(`    [needles-in-stream] ${TITLES.map(n => `${n.slice(5)}@${seenAt.get(n) ?? 'never'}`).join(' ')}`)
  }

  t.section('§1 — the window follows the cursor (three distinct rendered states)')
  t.check('S0 (sel=0): rows 1–3 painted, 4–5 genuinely hidden', s0 !== undefined, s0 ? `@${s0.atMs}` : 'never seen')
  t.check('S2 (sel=2): the window advanced — rows 2–4, row 1 scrolled out', s2 !== undefined, s2 ? `@${s2.atMs}` : 'never seen')
  t.check('S3+ (sel≥3): the tail window — rows 3–5, rows 1–2 out', s3 !== undefined, s3 ? `@${s3.atMs}` : 'never seen')
  t.check(
    'the states appear in walk order (S0 → S2 → S3+)',
    s0 !== undefined && s2 !== undefined && s3 !== undefined && s0.atMs < s2.atMs && s2.atMs < s3.atMs,
    `${s0?.atMs} < ${s2?.atMs} < ${s3?.atMs}`,
  )

  t.section('§2 — the header is honest (total + exact hidden counts, rail line only)')
  t.check('S0 header: total 5, ↓2 below, nothing above', s0 !== undefined && s0.railLine.includes('· 5') && s0.railLine.includes('↓2') && !s0.railLine.includes('↑'), s0?.railLine.trim() ?? '')
  t.check('S2 header: ↑1 AND ↓1 (one hidden each side)', s2 !== undefined && s2.railLine.includes('↑1') && s2.railLine.includes('↓1'), s2?.railLine.trim() ?? '')
  t.check('S3+ header: ↑2, nothing below', s3 !== undefined && s3.railLine.includes('↑2') && !s3.railLine.includes('↓'), s3?.railLine.trim() ?? '')
  t.check(
    'the total stays 5 in every matched state',
    [s0, s2, s3].every(v => v !== undefined && v.railLine.includes('· 5')),
  )

  t.section('§3 — the ↵-target identity (structural: acted row == rendered-selected row)')
  const screenSrc = readFileSync(join(import.meta.dir, '../../src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  const railSrc = readFileSync(join(import.meta.dir, '../../src/components/concourse/NeedsYouRail.tsx'), 'utf8')
  t.check('the screen acts on needsYou[liveRailIdx()] (the FULL-list synchronous index)', screenSrc.includes('snapshot.needsYou[liveRailIdx()]'))
  t.check('the rail renders the paneWindow slice of the SAME list', railSrc.includes('snapshot.needsYou.slice(win.start, win.end)'))
  t.check('the rail marks selected at the absolute index', railSrc.includes('selected={win.start + i === selectedIndex}'))
  t.check('the rail windows through the shared paneWindow owner (budget-clamped, RAIL_MAX_ROWS-capped)', railSrc.includes('paneWindow(total, selectedIndex, Math.max(1, Math.min(RAIL_MAX_ROWS, maxRows)))'))

  t.section('§4 — window math spot pins (the shared fn answers what §1 rendered)')
  const w4 = paneWindow(5, 4, 3)
  t.check('paneWindow(5,4,3) = rows 3–5, two hidden above', w4.start === 2 && w4.end === 5 && w4.above === 2 && w4.below === 0)
  const w0 = paneWindow(5, 0, 3)
  t.check('paneWindow(5,0,3) = rows 1–3, two hidden below', w0.start === 0 && w0.end === 3 && w0.above === 0 && w0.below === 2)
  const w1 = paneWindow(1, 0, 3)
  t.check('degenerate N=1: no hidden rows, no indicators (the frozen §8.1 frame — parity prover pins the render)', w1.above === 0 && w1.below === 0 && w1.end === 1)
} finally {
  run.cleanup()
  rmSync(fixtureDir, { recursive: true, force: true })
}


const BURST = 'concourse rail echo!'
const fixtureDir2 = mkdtempSync(join(tmpdir(), 'concourse-echo-'))

let sidecarState = 'never-fired'
const erun: ArenaRun = await runArtifactArena({
  turns: [],
  seedHome: configDir => {
    const timer = setTimeout(() => {
      try {
        writeFileSync(join(configDir, 'concourse-draft.json'), JSON.stringify({ draft: '', updatedAtMs: Date.now() }))
        sidecarState = `fired@${new Date().toISOString().slice(11, 19)}`
      } catch (e) {
        sidecarState = `write-failed: ${e}`
      }
    }, 13_000)
    ;(timer as { unref?: () => void }).unref?.()
  },
  sends: [
    'after:COORDINATOR:1500: ',
    ...BURST.split('').map((ch, i) => `after:COORDINATOR:${2500 + i * 30}:${ch}`),
  ],
  seconds: 23,
  cols: 142,
  rows: 38,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: join(fixtureDir2, 'daemon'),
    MERCURY_DAEMON_DIR: join(fixtureDir2, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir2, 'crew'),
  },
})

try {
  const offsets: number[] = []
  for (let ms = S(4000); ms <= S(22000); ms += S(400)) offsets.push(ms)
  const grabs = grabScreens(erun, 142, 38, offsets)
  const withBurst = grabs.filter(g => g.rows.some(r => r.includes(BURST)))
  const cleared = grabs.filter(
    g => !g.rows.some(r => r.includes(BURST)) && g.rows.some(r => r.includes('COORDINATOR')),
  )

  t.section('§5 — the 30ms burst echoes COMPLETELY (rendered == typed)')
  t.check('the full 20-char burst painted in the strip', withBurst.length > 0, withBurst[0] ? `@${withBurst[0].atMs}` : 'never seen')

  t.section('§6 — an external store clear beats the local echo (D2 §4b)')
  const lastBurst = withBurst[withBurst.length - 1]
  const firstCleared = cleared.find(g => lastBurst !== undefined && g.atMs > lastBurst.atMs)
  t.check('the echo yielded to the store clear (burst gone, placeholder back)', firstCleared !== undefined, firstCleared ? `@${firstCleared.atMs}` : `cleared grabs: ${cleared.map(g => g.atMs).join(',') || 'none'}`)
  t.check(
    'the clear happened AFTER the burst held (order proven)',
    lastBurst !== undefined && firstCleared !== undefined && lastBurst.atMs < firstCleared.atMs,
    `${lastBurst?.atMs} < ${firstCleared?.atMs}`,
  )
} finally {
  try {
    const draftOnDisk = readFileSync(join(erun.paths.home, '.claude', 'concourse-draft.json'), 'utf8')
    console.log(`    [sidecar] ${sidecarState} · draft file at run end: ${draftOnDisk.slice(0, 120)}`)
  } catch (e) {
    console.log(`    [sidecar] ${sidecarState} · draft file unreadable: ${e}`)
  }
  erun.cleanup()
  rmSync(fixtureDir2, { recursive: true, force: true })
}


const fixture3 = referenceFixtureSnapshot() as { groups: Array<Record<string, unknown>> }
fixture3.groups.push({
  id: 'paused',
  label: 'PAUSED',
  rows: [
    {
      sessionId: 'sess-pz',
      title: 'PAUSEDROWQ',
      state: 'paused',
      projectLabel: 'Moodle',
      ownerLabel: null,
      ageLabel: '9m',
      seats: null,
    },
  ],
})
const fixtureDir3 = mkdtempSync(join(tmpdir(), 'concourse-valve-'))
const fixturePath3 = join(fixtureDir3, 'concourse-fixture.json')
writeFileSync(fixturePath3, JSON.stringify(fixture3))

const vrun: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [
    'after:Audit billing receipts:1200: ',
    ...[1800, 2200, 2600, 3000, 3400, 3800, 4200, 4600].map(ms => `${ms}:\x1b[B`),
  ],
  seconds: 9,
  cols: 142,
  rows: 52,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath3,
    MERCURY_DAEMON_DIR: join(fixtureDir3, 'daemon'),
    MERCURY_DAEMON_DIR: join(fixtureDir3, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir3, 'crew'),
  },
})

try {
  const grabs = grabScreens(vrun, 142, 52, [S(2000), S(3400), S(4200), S(5000), S(6000), S(7000), -1])
  const anyFrame = grabs.find(g => g.rows.some(r => r.includes('PAUSEDROWQ')))
  t.section('§7 — the valve is VISIBLE (paused group + redirect compose)')
  t.check('the PAUSED group header renders on the board', anyFrame !== undefined && anyFrame.rows.some(r => r.includes('PAUSED') && !r.includes('PAUSEDROWQ')), anyFrame ? `@${anyFrame.atMs}` : 'never')
} finally {
  vrun.cleanup()
  rmSync(fixtureDir3, { recursive: true, force: true })
}

{
  t.section('§8 — B2: the tail sheds meta first, answer & resume survives last')
  const o = { projectLabel: 'Moodle', agentLabel: 'Mercury', ageLabel: '3m' }
  const joined = (parts: ReturnType<typeof railTailParts>): string => parts.map(p => p.text).join('')
  const full = railTailParts(o, 500)
  t.check('all four parts fit a generous budget, display order kept', full.map(p => p.key).join(',') === 'meta,answer,open,dismiss')
  t.check(
    'the full-fit join is the band-aligned composition (R3 restoration: the meta cluster stands alone at its band — no leading joiner)',
    joined(full) === 'Moodle · 3m │ answer & resume │ open session │ ✕ dismiss',
    JSON.stringify(joined(full)),
  )
  const fullW = displayWidth(joined(full))
  const oneShy = railTailParts(o, fullW - 1)
  t.check('one cell shy: META drops first, every affordance survives', oneShy.map(p => p.key).join(',') === 'answer,open,dismiss', joined(oneShy))
  const affordW = displayWidth(joined(oneShy))
  const openYields = railTailParts(o, affordW - 1)
  t.check("next: OPEN yields — dismiss + 'answer & resume' outrank it", openYields.map(p => p.key).join(',') === 'answer,dismiss', joined(openYields))
  const dismissW = displayWidth(joined(openYields))
  const answerOnly = railTailParts(o, dismissW - 1)
  t.check("last: 'answer & resume' is the final survivor", answerOnly.map(p => p.key).join(',') === 'answer', joined(answerOnly))
  t.check('a hopeless budget sheds everything whole (no half-truncated affordance)', railTailParts(o, 3).length === 0)
  const railSrc2 = readFileSync(join(import.meta.dir, '../../src/components/concourse/NeedsYouRail.tsx'), 'utf8')
  t.check('the component renders the SAME fn against the real remaining budget', railSrc2.includes('railTailParts(o, Math.max(0, width - 4 - titleBand - questionBand), o.foreignProject !== undefined)'))
}

t.finish('prove-concourse-rail')

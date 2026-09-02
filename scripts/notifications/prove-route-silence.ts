#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { grabScreens, requireDist, runArtifactArena, visibleText, type ArenaRun } from '../streaming/artifactArena.ts'
import { referenceFixtureSnapshot } from './concourseReferenceSeed.ts'

const t = checker()
scratchRoot('route-silence')
requireDist()


const OPEN_AT = 6500
const SUBMIT_AT = 8000
const LAYER_ESC_AT = 10000
const ESC_AT = 11500
const WINDOW_FROM = 7600

const run: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [`${OPEN_AT}:/bootmenu`, `${SUBMIT_AT}:\r`, `${LAYER_ESC_AT}:\x1b`, `${ESC_AT}:\x1b`, `${ESC_AT + 1500}:\x1b`],
  seconds: 16,
  cols: 120,
  rows: 36,
  keep: true,
})

interface DriveEntry {
  ts?: number
  b64?: string
  sent?: number
  atMs?: number
}

try {
  const entries: DriveEntry[] = []
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as DriveEntry)
    } catch {
    }
  }
  const chunks = entries
    .filter(e => typeof e.ts === 'number' && typeof e.b64 === 'string')
    .map(e => ({ ts: e.ts as number, text: Buffer.from(e.b64 as string, 'base64').toString('latin1') }))
  const sentStamps = entries.filter(
    (e): e is DriveEntry & { sent: number; atMs: number } =>
      typeof (e as { sent?: unknown }).sent === 'number' && typeof (e as { atMs?: unknown }).atMs === 'number',
  )
  const submitSent = sentStamps.find(e => e.atMs === S(SUBMIT_AT))?.sent
  const base = chunks.length ? chunks[0]!.ts : 0
  const windowStart = submitSent !== undefined ? submitSent - 200 : base + S(WINDOW_FROM)
  const windowText = chunks
    .filter(c => c.ts >= windowStart)
    .map(c => c.text)
    .join('')

  t.section('§1 — the surface painted and returned (silence needs a live subject)')
  {
    const squash = (rows: { rows: unknown[] } | undefined): string =>
      ((rows?.rows ?? []) as Parameters<typeof visibleText>[0][]).map(visibleText).join('\n').replace(/\s+/g, '')
    const openFrom = submitSent !== undefined ? submitSent - base : S(SUBMIT_AT)
    const OPEN_LADDER = [400, 800, 1200, 1600, 2000, 2400, 3200, 4800, 7000, 10_000].map(d => S(d))
    const openReady = (s: string): boolean => s.includes('startfreshhere') && s.includes('configurebootenv')
    const openOffsets = OPEN_LADDER.map(d => Math.round(openFrom + d))
    const grabbed1 = grabScreens(run, 120, 36, [...openOffsets, -1])
    const byAt1 = new Map(grabbed1.map(g => [g.atMs, squash(g)]))
    const openRungs = openOffsets.map(o => byAt1.get(o)).filter((s): s is string => s !== undefined)
    const open = openRungs.find(openReady) ?? openRungs[openRungs.length - 1]!
    const final = byAt1.get(-1)!
    t.check('the canonical Boot face painted on the route (settings esc → face)', open.includes('startfreshhere'), open.slice(0, 200) || '(blank)')
    t.check('a second card action row painted (the face came WHOLE)', open.includes('configurebootenv'), 'action row needle')
    t.check('the second Esc restored the session frame (the face gone)', !final.includes('startfreshhere'), final.slice(0, 200) || '(blank)')
    t.check('the route receipt reached the transcript', final.includes('BootSettingsopened'), 'receipt needle')
  }

  t.section('§2 — zero standing DEC/OSC mode changes across the route window')
  {
    const standing: Record<string, RegExp> = {
      'alt-screen (1049)': /\x1b\[\?1049[hl]/g,
      'focus-events (1004)': /\x1b\[\?1004[hl]/g,
      'bracketed-paste (2004)': /\x1b\[\?2004[hl]/g,
      'mouse (1000-1006)': /\x1b\[\?100[0-6][hl]/g,
      'alt-scroll (1007)': /\x1b\[\?1007[hl]/g,
      'kitty-kbd (push/pop)': /\x1b\[[<>=]\d*u/g,
      'modifyOtherKeys': /\x1b\[>4(;\d+)?m/g,
      'ground OSC 11': /\x1b\]11;/g,
      'title OSC 0/2': /\x1b\][02];/g,
    }
    for (const [name, re] of Object.entries(standing)) {
      const hits = windowText.match(re) ?? []
      t.check(`${name}: ZERO writes in the route window`, hits.length === 0, `${hits.length} hit(s)`)
    }
    const bsu = (windowText.match(/\x1b\[\?2026h/g) ?? []).length
    const esu = (windowText.match(/\x1b\[\?2026l/g) ?? []).length
    t.check('sync-update (2026) stays balanced (frame brackets, not a mode change)', bsu === esu, `h=${bsu} l=${esu}`)
    const hide = (windowText.match(/\x1b\[\?25l/g) ?? []).length
    const show = (windowText.match(/\x1b\[\?25h/g) ?? []).length
    t.check('cursor toggles recorded (declared-cursor frame chrome — informational)', true, `hide=${hide} show=${show}`)
  }
} finally {
  run.cleanup()
}


const WARM_AT = 6000
const B_AT = 7000
const LEFT_AT = 10000
const RIGHT_AT = 12000
const WAKE_AT = 13400
const WAKE_BS_AT = 13800
const CMD_AT = 14200
const CMD_SUBMIT_AT = 15700
const ESC3_AT = 18200

const fixtureDir = mkdtempSync(join(tmpdir(), 'route-silence-concourse-'))
const fixturePath = join(fixtureDir, 'concourse-fixture.json')
writeFileSync(fixturePath, JSON.stringify(referenceFixtureSnapshot()))

const crun: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [
    `${WARM_AT}:\x1b[B`,
    `${B_AT}:\x1b[1;2D`,
    `${LEFT_AT}:\x1b[1;2D`,
    `${RIGHT_AT}:\x1b[1;2C`,
    `${WAKE_AT}: `,
    `${WAKE_BS_AT}:\x7f`,
    `${CMD_AT}:/concourse`,
    `${CMD_SUBMIT_AT}:\r`,
    `${ESC3_AT - 800}:\x1b[B`,
    `${ESC3_AT}:\x1b`,
    `${ESC3_AT + 900}:\x1b`,
  ],
  seconds: 26,
  cols: 142,
  rows: 38,
  keep: true,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir, 'crew'),
  },
})

try {
  const entries: DriveEntry[] = []
  for (const line of readFileSync(crun.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as DriveEntry)
    } catch {
    }
  }
  const chunks = entries
    .filter(e => typeof e.ts === 'number' && typeof e.b64 === 'string')
    .map(e => ({ ts: e.ts as number, text: Buffer.from(e.b64 as string, 'base64').toString('latin1') }))
  const sentStamps = entries.filter(
    (e): e is DriveEntry & { sent: number; atMs: number } =>
      typeof (e as { sent?: unknown }).sent === 'number' && typeof (e as { atMs?: unknown }).atMs === 'number',
  )
  const bSent = sentStamps.find(e => e.atMs === B_AT)?.sent
  const base = chunks.length ? chunks[0]!.ts : 0
  const windowStart = bSent !== undefined ? bSent - 200 : base + B_AT
  const windowText = chunks
    .filter(c => c.ts >= windowStart)
    .map(c => c.text)
    .join('')

  t.section('§3 — the concourse cycle painted every station (subjects)')
  {
    const squash = (rows: { rows: unknown[] } | undefined): string =>
      ((rows?.rows ?? []) as Parameters<typeof visibleText>[0][]).map(visibleText).join('\n').replace(/\s+/g, '')
    const sentRel = (atMs: number): number => {
      const st = sentStamps.find(e => e.atMs === atMs)?.sent
      return st !== undefined ? st - base : atMs
    }
    const LADDER = [400, 800, 1200, 1600, 2200, 3000, 4200, 6000, 8000, 10_000]
    const NONBLANK = 200
    const isChat = (s: string): boolean => s.includes('⇧←back') || s.includes('Typeaprompt')
    const stations: Array<{ from: number; ready: (s: string) => boolean }> = [
      { from: 0, ready: s => s.includes('SESSIONCONCOURSE') },
      { from: sentRel(B_AT), ready: s => isChat(s) && !s.includes('SESSIONCONCOURSE') },
      { from: sentRel(LEFT_AT), ready: s => s.includes('SESSIONCONCOURSE') },
      { from: sentRel(RIGHT_AT), ready: s => isChat(s) && !s.includes('SESSIONCONCOURSE') },
      { from: sentRel(CMD_SUBMIT_AT), ready: s => s.includes('SESSIONCONCOURSE') },
      { from: sentRel(ESC3_AT), ready: s => !s.includes('SESSIONCONCOURSE') && s.length >= NONBLANK },
    ]
    const offsets = stations.flatMap(st => LADDER.map(d => Math.round(st.from + d)))
    const byAt = new Map(grabScreens(crun, 142, 38, offsets).map(g => [g.atMs, squash(g)]))
    const picked = stations.map(st => {
      const mine = LADDER.map(d => byAt.get(Math.round(st.from + d))).filter((s): s is string => s !== undefined)
      return mine.find(st.ready) ?? mine[mine.length - 1]!
    })
    const [boot, afterB, afterLeft, afterRight, afterCmd, final] = picked
    t.check("the boot LANDED on the concourse ('always' + registration ordering)", boot!.includes('SESSIONCONCOURSE'), boot!.slice(0, 160) || '(blank)')
    t.check('⇧← opened the Boot face over it and the arena\'s ↵ on New Session birthed and entered the chat (the strip\'s left stop, then the one birth door)', isChat(afterB!) && !afterB!.includes('SESSIONCONCOURSE'), afterB!.slice(0, 160) || '(blank)')
    t.check('⇧← from the chat is the concourse (the strip\'s own move — no return token)', afterLeft!.includes('SESSIONCONCOURSE') && !isChat(afterLeft!), afterLeft!.slice(0, 160) || '(blank)')
    t.check('⇧→ from the concourse re-enters the focused chat (the stop the birth created; a bare board would not move)', isChat(afterRight!) && !afterRight!.includes('SESSIONCONCOURSE'), afterRight!.slice(0, 160) || '(blank)')
    t.check('/concourse ↵ re-entered the surface (the command entry)', afterCmd!.includes('SESSIONCONCOURSE'))
    t.check('the final esc restored the chat again (home is the focused chat; repeat cycles hold)', !final!.includes('SESSIONCONCOURSE'))
  }

  t.section('§4 — zero standing DEC/OSC across the WHOLE multi-swap window')
  {
    const standing: Record<string, RegExp> = {
      'alt-screen (1049)': /\x1b\[\?1049[hl]/g,
      'focus-events (1004)': /\x1b\[\?1004[hl]/g,
      'bracketed-paste (2004)': /\x1b\[\?2004[hl]/g,
      'mouse (1000-1006)': /\x1b\[\?100[0-6][hl]/g,
      'alt-scroll (1007)': /\x1b\[\?1007[hl]/g,
      'kitty-kbd (push/pop)': /\x1b\[[<>=]\d*u/g,
      'modifyOtherKeys': /\x1b\[>4(;\d+)?m/g,
      'ground OSC 11': /\x1b\]11;/g,
      'title OSC 0/2': /\x1b\][02];/g,
    }
    for (const [name, re] of Object.entries(standing)) {
      const hits = windowText.match(re) ?? []
      t.check(`${name}: ZERO writes across six route swaps (the birth's route flip included)`, hits.length === 0, `${hits.length} hit(s)`)
    }
    const bsu = (windowText.match(/\x1b\[\?2026h/g) ?? []).length
    const esu = (windowText.match(/\x1b\[\?2026l/g) ?? []).length
    t.check('sync-update (2026) stays balanced across the cycle', bsu === esu, `h=${bsu} l=${esu}`)
  }
} finally {
  crun.cleanup()
  rmSync(fixtureDir, { recursive: true, force: true })
}

t.finish('prove-route-silence')

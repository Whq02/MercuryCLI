#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'plate-truth-home-'))
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/utils/staticRender.tsx'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const plate = (await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))) as {
  clockColumnOf?: (meta: { timestamp?: string; queued?: boolean; heldFor?: 'compaction' }, grammar: 'plate' | 'notice') => string | null
  formatClock: (ts?: string) => string | null
  HELD_PLATE: string
  QUEUED_PLATE: string
  MessageMetaProvider: React.ComponentType<{ message: Record<string, unknown>; children?: React.ReactNode }>
  NameplateClock: React.ComponentType
  TranscriptNameplate: React.ComponentType
  useMessageMeta: () => { queued?: boolean; heldFor?: 'compaction' } | null
}

const STAMP = new Date(2026, 9, 4, 9, 41, 7).toISOString()
const CLOCK = plate.formatClock(STAMP) as string
const squeeze = (s: string): string => s.replace(/\s+/g, ' ').trim()

section('§1 one derivation: the clock column for both grammars')
const columnOf = plate.clockColumnOf ?? null
check('the tip exports the one clock-column derivation (absent on the base)', columnOf !== null)
if (columnOf !== null) {
  const rows: Array<[string, Parameters<typeof columnOf>[0], string | null, string | null]> = [
    ['a taken row', { timestamp: STAMP }, `${CLOCK} `, `${CLOCK} `],
    ['a row without a stamp', {}, null, null],
    ['a row with an unreadable stamp', { timestamp: 'not a clock' }, null, null],
    ['a queued row', { timestamp: STAMP, queued: true }, `${plate.QUEUED_PLATE} `, `${plate.HELD_PLATE} since ${CLOCK} `],
    ['a queued row without a stamp', { queued: true }, `${plate.QUEUED_PLATE} `, `${plate.HELD_PLATE} `],
    ['a row held for the compaction', { timestamp: STAMP, queued: true, heldFor: 'compaction' }, `${plate.HELD_PLATE} `, `${plate.HELD_PLATE} `],
    ['a row the queue no longer holds, whatever hold it still carries', { timestamp: STAMP, queued: false, heldFor: 'compaction' }, `${CLOCK} `, `${CLOCK} `],
    ['a row that was never queued, whatever hold it carries', { timestamp: STAMP, heldFor: 'compaction' }, `${CLOCK} `, `${CLOCK} `],
  ]
  for (const [name, meta, wantPlate, wantNotice] of rows) {
    const gotPlate = columnOf(meta, 'plate')
    const gotNotice = columnOf(meta, 'notice')
    check(`${name}: the plate grammar reads ${JSON.stringify(wantPlate)}`, gotPlate === wantPlate, JSON.stringify(gotPlate))
    check(`${name}: the notice grammar reads ${JSON.stringify(wantNotice)}`, gotNotice === wantNotice, JSON.stringify(gotNotice))
  }
}

section('§2 the painters: a hold word exists only while the queue holds the row')
const paintNameplate = async (message: Record<string, unknown>): Promise<string> =>
  squeeze(await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, React.createElement(plate.MessageMetaProvider, { message }, React.createElement(plate.TranscriptNameplate)))))
const paintClock = async (message: Record<string, unknown>): Promise<string> =>
  squeeze(await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, React.createElement(plate.MessageMetaProvider, { message }, React.createElement(plate.NameplateClock)))))

const taken = await paintNameplate({ type: 'user', timestamp: STAMP })
check(`a taken line wears its clock and the handle: "${CLOCK} [sam]"`, taken === `${CLOCK} [sam]`, taken)
const queued = await paintNameplate({ type: 'user', timestamp: STAMP, queued: true })
check('a queued line wears "queued" where the clock would stand', queued === 'queued [sam]', queued)
const held = await paintNameplate({ type: 'user', timestamp: STAMP, queued: true, heldFor: 'compaction' })
check('a line held for the compaction wears "held"', held === 'held [sam]', held)
const stale = await paintNameplate({ type: 'user', timestamp: STAMP, heldFor: 'compaction' })
check('a line the queue does not hold wears its clock even when a stale hold rides the row', stale === `${CLOCK} [sam]`, stale)
const noticeHeld = await paintClock({ type: 'attachment', timestamp: STAMP, queued: true })
check('a notice the queue holds reads "held since <arrival>"', noticeHeld === `held since ${CLOCK}`, noticeHeld)
const noticeCompacting = await paintClock({ type: 'attachment', timestamp: STAMP, queued: true, heldFor: 'compaction' })
check('a notice held for the compaction reads "held"', noticeCompacting === 'held', noticeCompacting)
const noticeTaken = await paintClock({ type: 'attachment', timestamp: STAMP })
check('a taken notice reads its clock alone', noticeTaken === CLOCK, noticeTaken)
const noticeStale = await paintClock({ type: 'attachment', timestamp: STAMP, heldFor: 'compaction' })
check('a notice the queue does not hold reads its clock whatever hold rides the row', noticeStale === CLOCK, noticeStale)

section('§3 the meta a row hands its painters: a hold reason never outlives the queue')
let seen: { queued?: boolean; heldFor?: 'compaction' } | null = null
const Reader = (): null => {
  seen = plate.useMessageMeta()
  return null
}
await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, React.createElement(plate.MessageMetaProvider, { message: { type: 'user', timestamp: STAMP, heldFor: 'compaction' } }, React.createElement(Reader))))
check('a row no queue holds carries no hold reason in its meta (absent on the base: the reason rode the row on its own)', seen !== null && seen.queued === false && seen.heldFor === undefined, JSON.stringify(seen))
await renderToString(React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() }, React.createElement(plate.MessageMetaProvider, { message: { type: 'user', timestamp: STAMP, queued: true, heldFor: 'compaction' } }, React.createElement(Reader))))
check('a queued row held for the compaction carries both', seen !== null && seen.queued === true && seen.heldFor === 'compaction', JSON.stringify(seen))

console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

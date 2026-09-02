#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-accent-snapshot.ts — the accent store's SNAPSHOT is
//  stable: the same object while nothing changed, a new one on every store
//  dimension, and the unsubscribe law.
//
//  useSyncExternalStore compares snapshots with Object.is: a snapshot rebuilt
//  on every read costs a string per subscriber per read (and each subscribing
//  hook retains its own copy), while a snapshot that changes only when the
//  store changes hands every subscriber the one string. The accent object the
//  hook returns follows the same law under /accent.
//
//  §1  STABILITY — thousands of reads rebuild nothing; getSessionAccent() is
//      the same object across reads: bare and under /accent.
//  §2  EVERY DIMENSION — a /critter pick, an /accent set and an /accent clear
//      each rebuild exactly once; a same-key pick rebuilds nothing.
//  §3  THE UNSUBSCRIBE LAW — every subscription's deleter removes exactly its
//      handler; a dead handler is never called again.
//  §4  RENDERS OVER N NOTIFICATIONS — M subscribers under ink: identical-
//      state notifications render nothing and build nothing; a real change
//      renders every subscriber once.
//  §5  SOURCE LOCKS — the hook subscribes through the one snapshot; the memo
//      compares both inputs; the override tint is memoised on identity.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { checker } from '../engine-durability/harness.ts'

process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'accent-snapshot-'))
delete process.env['MERCURY_CRITTER']

const t = checker()
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const accent = await import('../../src/components/mercury-ui/sessionAccent.js')
const React = (await import('react')).default
const { Box, Text, flushPendingSyncWork } = await import('../../src/ink.js')
const { renderSync } = await import('../../src/ink/root.js')

const builds = (): number => accent.accentStoreStatsForProofs().snapshotBuilds
const listeners = (): number => accent.accentStoreStatsForProofs().listeners

t.section('§1 — stability: reads rebuild nothing; the accent object is the same across reads')
{
  accent.setSessionCritter('jellyfish')
  accent.setSessionAccentOverride(null)
  const first = accent.getSessionAccentSnapshotKey()
  const b0 = builds()
  let same = true
  for (let i = 0; i < 10_000; i++) if (accent.getSessionAccentSnapshotKey() !== first) same = false
  t.check('10 000 snapshot reads with nothing changed rebuild NOTHING and answer the same value', same && builds() === b0, `builds ${builds() - b0}`)
  t.check('bare: getSessionAccent() is the same object across reads', accent.getSessionAccent() === accent.getSessionAccent())
  t.check('bare: the accent object IS the catalogue table entry', accent.getSessionAccent() === accent.CRITTERS.jellyfish)
  accent.setSessionAccentOverride('#3f7e96')
  t.check('under /accent: getSessionAccent() is the same object across reads (the tint object is built once per override)', accent.getSessionAccent() === accent.getSessionAccent() && accent.getSessionAccent().accent === '#3f7e96')
  accent.setSessionAccentOverride(null)
  t.check('override cleared: the bare table object again', accent.getSessionAccent() === accent.CRITTERS.jellyfish)
}

t.section('§2 — every store dimension rebuilds the snapshot exactly once')
{
  // The memo rebuilds LAZILY, on the first read after an input moved — so
  // every step reads the snapshot and then counts.
  const read = (): { v: string; b: number } => {
    const v = accent.getSessionAccentSnapshotKey()
    return { v, b: builds() }
  }
  const r0 = read()
  accent.setSessionCritter('crab')
  const r1 = read()
  t.check('a /critter pick rebuilds once and changes the value', r1.b === r0.b + 1 && r1.v !== r0.v && r1.v.startsWith('crab:'), `builds +${r1.b - r0.b}`)
  accent.setSessionCritter('crab')
  const r2 = read()
  t.check('a same-key pick rebuilds nothing', r2.b === r1.b && r2.v === r1.v)
  accent.setSessionAccentOverride('#00ff00')
  const r3 = read()
  t.check('an /accent set rebuilds once and the value carries the tint', r3.b === r2.b + 1 && r3.v.includes('#00ff00'))
  accent.setSessionAccentOverride(null)
  const r4 = read()
  t.check('an /accent clear rebuilds once', r4.b === r3.b + 1 && !r4.v.includes('#'))
  accent.setSessionCritter('jellyfish')
}

t.section('§3 — the unsubscribe law')
{
  const base = listeners()
  let a = 0
  let c = 0
  const offA = accent.subscribeSessionCritter(() => { a++ })
  const offB = accent.subscribeSessionCritter(() => {})
  const offC = accent.subscribeSessionCritter(() => { c++ })
  t.check('three subscriptions register three handlers', listeners() === base + 3)
  offB()
  t.check('a deleter removes exactly its own handler', listeners() === base + 2)
  accent.setSessionCritter('octopus')
  t.check('a live handler is called on a pick', a === 1 && c === 1)
  offA()
  accent.setSessionCritter('clam')
  t.check('a dead handler is never called again; the live one still is', a === 1 && c === 2)
  offC()
  offC()
  t.check('deleting twice is harmless and the count returns to the baseline', listeners() === base)
  accent.setSessionCritter('jellyfish')
}

t.section('§4 — M subscribers under ink: identical-state notifications render and build nothing')
{
  const stdinStub = (): NodeJS.ReadStream =>
    Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      setEncoding() { return this },
      read() { return null },
      unref() { return this },
      ref() { return this },
      pause() { return this },
      resume() { return this },
    }) as unknown as NodeJS.ReadStream
  const M = 40
  let renders = 0
  const Sub = (): React.ReactNode => {
    renders++
    const c = accent.useSessionAccent()
    return React.createElement(Text, null, c.key)
  }
  const Parent = (): React.ReactNode => {
    const kids: React.ReactNode[] = []
    for (let i = 0; i < M; i++) kids.push(React.createElement(Sub, { key: i }))
    return React.createElement(Box, { flexDirection: 'column' } as never, ...kids)
  }
  const stream = new PassThrough()
  const target = stream as unknown as NodeJS.WriteStream & { columns?: number; rows?: number }
  target.columns = 60
  target.rows = 50
  const inst = renderSync(React.createElement(Parent), { stdout: target, stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false })
  flushPendingSyncWork()
  t.check(`the ${M} subscribers mounted and registered`, renders === M && listeners() >= M)
  // Identical-state notifications: a same-key pick and a same-value clear
  // move nothing — the state never changes.
  renders = 0
  const b0 = builds()
  for (let i = 0; i < 25; i++) {
    accent.setSessionCritter('jellyfish')
    accent.setSessionAccentOverride(null)
    flushPendingSyncWork()
  }
  t.check(`50 identical-state notifications across ${M} subscribers render NOTHING and build NOTHING`, renders === 0 && builds() === b0, `renders ${renders} builds ${builds() - b0}`)
  renders = 0
  const b1 = builds()
  accent.setSessionCritter('crab')
  flushPendingSyncWork()
  t.check(`a real /critter change renders every subscriber once and builds the snapshot once (${renders} / ${builds() - b1})`, renders === M && builds() === b1 + 1)
  renders = 0
  const b2 = builds()
  accent.setSessionAccentOverride('#3f7e96')
  flushPendingSyncWork()
  t.check(`a real /accent set renders every subscriber once and builds once (${renders} / ${builds() - b2})`, renders === M && builds() === b2 + 1)
  accent.setSessionAccentOverride(null)
  flushPendingSyncWork()
  inst.unmount()
  t.check('unmounting the subscribers releases every handler', listeners() === 0, String(listeners()))
  accent.setSessionCritter('jellyfish')
}

t.section('§5 — source locks')
{
  const src = readFileSync('src/components/mercury-ui/sessionAccent.ts', 'utf8')
  t.check('the hook subscribes through the one snapshot', /useSyncExternalStore\(\s*subscribeSessionCritter,\s*getSessionAccentSnapshotKey,\s*getSessionAccentSnapshotKey,\s*\)/.test(src))
  t.check('the snapshot memo compares both inputs (key · override identity)', /memo\.key === key && memo\.override === accentOverride\) return memo\.value/.test(src))
  t.check('the override tint is memoised on (base, override) identity', /memo\.base === base && memo\.override === accentOverride/.test(src))
}

t.finish('ACCENT-SNAPSHOT')

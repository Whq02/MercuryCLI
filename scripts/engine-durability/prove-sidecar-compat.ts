#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { checker, scratchRoot, guardWrite } from './harness.ts'

const ROOT = scratchRoot('sidecarcompat')
const t = checker()

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const { emptyRunSnapshot, RUN_SCHEMA_VERSION } = await import(
  '../../src/services/run/runKernel.ts'
)

const owner = (id: string) => makeOwnerKey({ workspace: ROOT, sessionId: id, lane: 'main' })

const stage = (path: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  return path
}

t.section('§1 — a sidecar from an OLDER build still loads')
{
  const o = owner('compat-old')
  const path = guardWrite(ROOT, sidecar.runSidecarPath(o))
  const legacy = {
    schema: 1,
    writeSeq: 7,
    operationId: '11111111-2222-3333-4444-555555555555',
    committedAt: '2026-07-01T00:00:00.000Z',
    snapshot: {
      schema: 1,
      runId: 'legacy-run',
      owner: o,
      rootMessageId: null,
      objective: 'a run recorded by an older build',
      startedAt: 1,
      updatedAt: 2,
      lifecycle: 'active',
      substantive: true,
      phase: 'implementation',
      phaseReason: 'seeded',
      deliverables: [],
      lastAction: '',
      nextAction: 'keep going',
      blocker: null,
      changedPaths: [],
      totalChangedPaths: 0,
      recentEvents: [],
      verification: { state: 'unknown', detail: '' },
    },
  }
  writeFileSync(stage(path), JSON.stringify(legacy, null, 2))

  const load = await sidecar.loadRunSidecar(o)
  t.check('the legacy sidecar loads', load.state === 'loaded', `state=${load.state}`)
  t.check(
    'its objective survives verbatim',
    load.state === 'loaded' && load.snapshot.objective === 'a run recorded by an older build',
    load.state === 'loaded' ? load.snapshot.objective : `state=${load.state}`,
  )
  t.check(
    'its runId survives verbatim',
    load.state === 'loaded' && load.snapshot.runId === 'legacy-run',
  )
  t.check(
    'the on-disk writeSeq is adopted as the revision (no regression)',
    sidecar.runRevision(o) >= 7,
    `revision=${sidecar.runRevision(o)}`,
  )
}

t.section('§2 — every failure mode stays a DISTINCT answer')
{
  const absent = await sidecar.loadRunSidecar(owner('compat-absent'))
  t.check('absent ⇒ none', absent.state === 'none', `state=${absent.state}`)

  const oUnread = owner('compat-unreadable')
  mkdirSync(stage(guardWrite(ROOT, sidecar.runSidecarPath(oUnread))), { recursive: true })
  const unread = await sidecar.loadRunSidecar(oUnread)
  t.check('unreadable ⇒ unavailable (never none)', unread.state === 'unavailable', `state=${unread.state}`)

  const oTorn = owner('compat-torn')
  writeFileSync(stage(guardWrite(ROOT, sidecar.runSidecarPath(oTorn))), '{"schema":1,"snaps')
  const torn = await sidecar.loadRunSidecar(oTorn)
  t.check('torn bytes ⇒ recoverable', torn.state === 'recoverable', `state=${torn.state}`)

  const oFuture = owner('compat-future')
  writeFileSync(
    stage(guardWrite(ROOT, sidecar.runSidecarPath(oFuture))),
    JSON.stringify({ schema: RUN_SCHEMA_VERSION + 1, writeSeq: 1, snapshot: {} }),
  )
  const future = await sidecar.loadRunSidecar(oFuture)
  t.check(
    'a NEWER schema ⇒ recoverable, never a crash and never a fabricated run',
    future.state === 'recoverable',
    `state=${future.state}`,
  )

  const answers = [absent.state, unread.state, torn.state, future.state]
  t.check(
    'absent / unreadable are not the same answer',
    absent.state !== unread.state,
    answers.join(','),
  )
}

t.section('§3 — the persisted top-level shape is pinned')
{
  const o = owner('compat-shape')
  await sidecar.saveRunSidecar(
    o,
    emptyRunSnapshot({
      runId: 'shape-run',
      owner: o,
      objective: 'shape',
      rootMessageId: null,
      at: 1,
    }),
  )
  const raw = JSON.parse(readFileSync(sidecar.runSidecarPath(o), 'utf8')) as Record<string, unknown>
  const REQUIRED = ['schema', 'writeSeq', 'operationId', 'committedAt', 'snapshot']
  const OPTIONAL = ['writerEpoch', 'writerId']
  const keys = Object.keys(raw).sort()
  const missing = REQUIRED.filter(k => !(k in raw))
  const unexpected = keys.filter(k => !REQUIRED.includes(k) && !OPTIONAL.includes(k))
  t.check('every documented key is written', missing.length === 0, missing.join(',') || 'ok')
  t.check(
    'no UNDOCUMENTED key appeared — if one has, decide whether old builds can still read it',
    unexpected.length === 0,
    unexpected.join(',') || `keys: ${keys.join(',')}`,
  )
  t.check(
    'the written schema is the current version',
    raw.schema === RUN_SCHEMA_VERSION,
    `schema=${String(raw.schema)}`,
  )
  const back = await sidecar.loadRunSidecar(o)
  t.check('what this build writes, it reads back', back.state === 'loaded', `state=${back.state}`)
}

t.finish('prove-sidecar-compat')

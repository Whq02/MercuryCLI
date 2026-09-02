#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-p02')
const t = checker()

writeFileSync(guardWrite(root, join(root, 'interview')), 'not a directory — cairn P0-2 fault seam')

const store = await import('../../src/services/interview/store.ts')

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)

t.section('§1 — the defect: a failed required drain is invisible at the flush seam')
{
  store._resetInterviewForProofs()
  store.openInterviewSession({ mission: 'doomed session', atMs: 1 })
  let threw = false
  let receipt: unknown
  try {
    receipt = await store.flushInterviewLog()
  } catch {
    threw = true
  }
  t.check('(premise) the durable write genuinely failed — no log file exists',
    !existsSync(logPath))
  t.check(
    'a failed REQUIRED drain is observable to the caller (typed settlement receipt or throw)',
    threw || (receipt !== undefined && receipt !== null),
    'flushInterviewLog resolved void — persist() swallowed the failure into logError; the registered shutdown cleanup believes the drain completed',
  )
}

t.finish('repro-p0-2-settlement-swallowed')

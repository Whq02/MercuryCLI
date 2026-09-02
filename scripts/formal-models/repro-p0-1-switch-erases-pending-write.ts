#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, waitUntil } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-p01')
const t = checker()

const store = await import('../../src/services/interview/store.ts')

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)

function durableSessions(): Record<string, { events: unknown[] }> {
  if (!existsSync(logPath)) return {}
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  const sessions = (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, { events: unknown[] }>
  return sessions
}

t.section('§1 — control: a lone session\'s pending debounced write settles via the drain')
{
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'lone session', atMs: 1 })
  await store.flushInterviewLog()
  await waitUntil(() => durableSessions()[a] !== undefined)
  t.check('the lone session settled durably (the drain works when identity never switched)',
    durableSessions()[a] !== undefined)
}

t.section('§2 — the defect: a session switch inside the debounce window erases the prior identity\'s accepted write')
{
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'prior identity A', atMs: 2 })
  const b = store.openInterviewSession({ mission: 'next identity B', atMs: 3 })
  await store.flushInterviewLog()
  await waitUntil(() => durableSessions()[a] !== undefined, { tries: 80, everyMs: 10 })
  const sessions = durableSessions()
  t.check('the switched-to session B settled durably (premise: persistence itself works)',
    sessions[b] !== undefined)
  t.check(
    'switching identity never cancels the prior identity\'s accepted write — A settles durably too',
    sessions[a] !== undefined,
    'A\'s pending persist was clearTimeout-erased by B\'s first scheduleSave; the drain then saw only B',
  )
}

t.finish('repro-p0-1-switch-erases-pending-write')

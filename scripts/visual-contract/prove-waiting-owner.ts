#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
import * as React from 'react'
import {
  _seedToolStartStamp,
  RunningToolElapsed,
} from '../../src/components/messages/AssistantToolUseMessage.tsx'
import { DECOR_TICK_MS } from '../../src/utils/cockpit/liveGlyphs.ts'
import { renderToString } from '../../src/utils/staticRender.tsx'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 — the elapsed tail renders honestly')
{
  _seedToolStartStamp('tool-old', Date.now() - 15_000)
  const old = (
    await renderToString(
      React.createElement(RunningToolElapsed, { id: 'tool-old', running: true }),
    )
  ).trim()
  t.check(
    'a 15s-old running tool renders the muted elapsed tail',
    /·\s*1[45]s/.test(old),
    JSON.stringify(old),
  )

  const fresh = (
    await renderToString(
      React.createElement(RunningToolElapsed, { id: 'tool-fresh', running: true }),
    )
  ).trim()
  t.check('a fresh running tool renders NOTHING (quick tools stay quiet)', fresh === '', JSON.stringify(fresh))

  _seedToolStartStamp('tool-done', Date.now() - 60_000)
  const done = (
    await renderToString(
      React.createElement(RunningToolElapsed, { id: 'tool-done', running: false }),
    )
  ).trim()
  t.check('a settled row renders nothing (and clears its stamp)', done === '', JSON.stringify(done))
}

t.section('§2 — the owner pins')
{
  const src = readFileSync('src/components/messages/AssistantToolUseMessage.tsx', 'utf8')
  const tick = src.match(/ELAPSED_TICK_MS = (\d+)/)?.[1]
  t.check(
    `the tick nests on the DECOR tier (${DECOR_TICK_MS}ms × 3)`,
    tick !== undefined && Number(tick) === DECOR_TICK_MS * 3,
    `ELAPSED_TICK_MS=${tick}`,
  )
  const vis = src.match(/ELAPSED_VISIBLE_MS = ([\d_]+)/)?.[1]
  t.check(
    'the visibility threshold is 10s (long-running only)',
    vis === '10_000',
    `ELAPSED_VISIBLE_MS=${vis}`,
  )
  t.check(
    'the tail is composed in the headerRow at the ONE owner',
    /<RunningToolElapsed id=\{param\.id\}/.test(src),
    'headerRow placement',
  )
}

t.finish('prove-waiting-owner')

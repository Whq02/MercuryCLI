#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import * as React from 'react'
import {
  _seedToolStartStamp,
  RunningToolElapsed,
} from '../../src/screen/messages/AssistantToolUseMessage.tsx'
import { renderToString } from '../../src/screen/renderer/staticRender.tsx'
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


t.finish('prove-waiting-owner')

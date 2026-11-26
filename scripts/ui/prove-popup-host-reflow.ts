#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { closeStage, openStage, KEY } from './chatScenarios.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { withDeadline } from '../../src/platform/async/deadline.ts'

pinSourceRef()

const stage = await openStage('popup-host-reflow', { columns: 120, rows: 34, session: 'history' })
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
const { edit } = await import('../../src/screen/composer/input-core/pending-input.ts')
const { enqueueNotification } = await import('../../src/screen/notifications/notifications.tsx')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { openFilesMenu } = await import('../../src/screen/cockpit/filesMenu.ts')
const { getFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { spyOn } = await import('bun:test')
const ink = [...instances.values()][0]!
const rows = Array.from({ length: 50 }, (_, i) => ({ id: `a-${i}`, agentId: `a-${i}`, name: `Agent ${i}`, kind: 'agent' as const, status: 'running', startTime: 1 }))
const roster = spyOn(getFocusedSessionConnector(), 'workRoster').mockReturnValue({ rows, mission: [], reported: true })
const surfaces = [
  ['/config', 'Mercury · config'], ['/crewmates', 'Mercury — crew'], ['/model', 'Mercury · model'],
  ['files', 'Mercury · files'], ['/effort', 'Mercury · effort'],
] as const

function edges(lines: string[], title: string) {
  const at = lines.findIndex(row => row.includes(title))
  const left = lines[at]?.lastIndexOf('│', lines[at]!.indexOf(title)) ?? -1
  const top = lines.findIndex((row, y) => y < at && row[left] === '╭')
  const right = lines[top]?.indexOf('╮', left + 1) ?? -1
  const bottom = lines.findIndex((row, y) => y > at && row[left] === '╰' && row[right] === '╯')
  const hostLeft = lines[0]!.lastIndexOf('╭', left - 1)
  const hostBottom = lines.findIndex((row, y) => y > 0 && row[hostLeft] === '╰')
  return { top, bottom, left, right, hostBottom }
}

async function after(title: string, change: () => void, painted: (text: string) => boolean): Promise<string[]> {
  const next = Promise.withResolvers<string[]>()
  const off = ink.subscribeFrame(() => {
    const lines = stage.view.lines()
    if (painted(lines.join('\n'))) next.resolve(lines)
  })
  try {
    change()
    return await withDeadline(next.promise, 4000, () => { throw new Error(`${title}: the changed bottom block never painted`) })
  } finally { off() }
}

const faults: string[] = []
try {
  const witness = 'under-popup'
  stage.session.setRecords([stage.assistant(Array(60).fill(`${witness} `.repeat(8)).join('\n'))])
  await settledFrame(stage.view, text => text.split('\n').filter(line => line.includes(witness)).length >= 12)
  for (const row of rows) writeFileSync(join(stage.project, row.id), '')
  for (const [door, title] of surfaces) {
    const store = stage.store()
    const block = () => enqueueNotification(store.setState, {
      key: 'block', priority: 'immediate', timeoutMs: Infinity,
      jsx: h(Box, { flexDirection: 'column' }, ...rows.slice(0, 3).map(r => h(Text, { key: r.id }, `Notice ${r.name}`))),
    })
    const clear = () => store.setState(state => ({ ...state, notifications: { current: null, queue: [] } }))
    const showingNotice = (text: string) => text.includes('Notice Agent 0')
    const noNotice = (text: string) => !showingNotice(text)
    await after(title, block, showingNotice)
    if (door === 'files') openFilesMenu()
    else stage.dispatch(door)
    await settledFrame(stage.view, text => text.includes(title))
    const check = (phase: string, lines: string[]) => {
      const { top, bottom, left, right, hostBottom } = edges(lines, title)
      const whole = top > 0 && bottom > top && lines.slice(top + 1, bottom).every(line => line[left] === '│' && line[right] === '│')
      const fit = door === '/effort' ? Math.abs(top - (hostBottom - bottom)) <= 1 : hostBottom - bottom === (door === 'files' ? 5 : 2)
      const covered = lines.slice(top - 1, bottom + 2).every(line => !line.slice(left, right + 1).includes(witness))
      if (!(whole && fit && covered)) faults.push(`${door} · ${phase}: border rows ${top}..${bottom}, host ends at ${hostBottom}`)
      return hostBottom
    }
    check('opened with block notice', stage.view.lines())
    const initial = check('opening notice left', await after(title, clear, noNotice))
    check('block notice arrived', await after(title, block, showingNotice))
    check('block notice left', await after(title, clear, noNotice))
    const draft = await after(title, () => edit('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight'), text => text.includes('eight'))
    assert.ok(check('multiline draft arrived', draft) < initial, `${door}: the test draft must grow the composer`)
    check('draft cleared', await after(title, () => edit(''), text => !text.includes('eight')))
    stage.view.push(KEY.esc)
    await settledFrame(stage.view, text => !text.includes(title))
  }
  assert.deepEqual(faults, [], 'Refit the open popup to the newly laid out centre in FullscreenLayout, before painting')
  console.log('Five popups fit on every first frame, on notice and draft arrival and removal.')
} finally {
  roster.mockRestore()
  await closeStage(stage)
}
process.exit(0)

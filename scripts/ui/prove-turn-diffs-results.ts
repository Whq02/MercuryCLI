#!/usr/bin/env bun
import React from 'react'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('turn-diffs-results')
const HINT = 'check src/screen/diff/useTurnDiffs.ts: a result counts when it is an object with a text filePath; a create with an empty text is a new file with one line'
let bad = 0

try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { Text } = await import('../../src/screen/themedRenderer.ts')
  const { useTurnDiffs } = await import('../../src/screen/diff/useTurnDiffs.ts')
  const h = React.createElement
  const prompt = (text: string) => ({ type: 'user', uuid: `p-${text}`, timestamp: '2026-11-24T07:00:00.000Z', message: { role: 'user', content: text } })
  const result = (toolUseResult: unknown) => ({ type: 'user', uuid: `r-${Math.random()}`, timestamp: '2026-11-24T07:00:01.000Z', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }
  const cases: Array<[string, unknown[], string]> = [
    ['a Write that creates an EMPTY file', [prompt('make it'), result({ type: 'create', filePath: '/w/empty.txt', content: '', structuredPatch: [] })], 'turn 1 "make it": /w/empty.txt new=true +1 -0 hunks=1'],
    ["an edit's result standing before any prompt", [result({ filePath: '/w/a.ts', structuredPatch: [hunk] })], '(no turn)'],
    ['the same result, then a prompt and a second edit: the turn is 1 and holds the second alone', [result({ filePath: '/w/a.ts', structuredPatch: [hunk] }), prompt('go on'), result({ filePath: '/w/b.ts', structuredPatch: [hunk] })], 'turn 1 "go on": /w/b.ts new=false +1 -1 hunks=1'],
    ['a result whose content is present and null', [prompt('edit'), result({ filePath: '/w/a.ts', type: 'update', content: null, structuredPatch: [hunk] })], 'turn 1 "edit": /w/a.ts new=false +1 -1 hunks=1'],
    ['a result whose type is present and null', [prompt('edit'), result({ filePath: '/w/a.ts', type: null, structuredPatch: [hunk] })], 'turn 1 "edit": /w/a.ts new=false +1 -1 hunks=1'],
    ['a patch that holds one entry that is no hunk', [prompt('edit'), result({ filePath: '/w/a.ts', structuredPatch: [hunk, { note: 'not a hunk' }] })], 'turn 1 "edit": /w/a.ts new=false +1 -1 hunks=2'],
    ['an Edit with hunks', [prompt('edit'), result({ filePath: '/w/a.ts', structuredPatch: [hunk, hunk] })], 'turn 1 "edit": /w/a.ts new=false +2 -2 hunks=2'],
    ['a Write of a file with text', [prompt('write'), result({ type: 'create', filePath: '/w/n.txt', content: 'one\ntwo\nthree', structuredPatch: [] })], 'turn 1 "write": /w/n.txt new=true +3 -0 hunks=1'],
    ['a create that also has a patch takes the patch, marked new', [prompt('write'), result({ type: 'create', filePath: '/w/n.txt', content: 'one', structuredPatch: [hunk] })], 'turn 1 "write": /w/n.txt new=true +1 -1 hunks=1'],
    ['an edit with an empty patch that is no create adds nothing', [prompt('edit'), result({ filePath: '/w/a.ts', structuredPatch: [] })], '(no turn)'],
    ['a result with no text filePath is passed over', [prompt('edit'), result({ filePath: 7, structuredPatch: [hunk] })], '(no turn)'],
    ['a patch that is no list is an empty one, so a create is made from its content', [prompt('write'), result({ type: 'create', filePath: '/w/n.txt', content: 'x', structuredPatch: null })], 'turn 1 "write": /w/n.txt new=true +1 -0 hunks=1'],
    ['two turns, newest first', [prompt('first'), result({ filePath: '/w/a.ts', structuredPatch: [hunk] }), prompt('second'), result({ filePath: '/w/b.ts', structuredPatch: [hunk] })], 'turn 2 "second": /w/b.ts new=false +1 -1 hunks=1 | turn 1 "first": /w/a.ts new=false +1 -1 hunks=1'],
  ]
  const captured: string[] = []
  function Probe({ messages }: { messages: unknown[] }): unknown {
    const turns = useTurnDiffs(messages as never) as Array<{ turnIndex: number; userPromptPreview: string; files: Map<string, { filePath: string; isNewFile: boolean; linesAdded: number; linesRemoved: number; hunks: unknown[] }> }>
    const line = turns.length === 0 ? '(no turn)' : turns.map(turn => `turn ${turn.turnIndex} "${turn.userPromptPreview}": ${[...turn.files.values()].map(file => `${file.filePath} new=${file.isNewFile} +${file.linesAdded} -${file.linesRemoved} hunks=${file.hunks.length}`).join(', ')}`).join(' | ')
    captured.push(line)
    return h(Text, null, '.')
  }
  for (const [name, messages, want] of cases) {
    let got = ''
    captured.length = 0
    try {
      const view = await mountOffscreen(h(Probe, { messages }), 200, 4)
      await settle(60)
      got = captured.at(-1) ?? '(the hook was not called)'
      view.unmount()
    } catch (error) {
      got = `THREW ${error instanceof Error ? error.message : String(error)}`
    }
    const ok = got === want
    if (!ok) bad++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${got}${ok ? '' : ` · want ${want}; ${HINT}`}`)
  }
  console.log(bad === 0 ? `prove-turn-diffs-results: ${cases.length} of ${cases.length}` : `prove-turn-diffs-results: ${bad} differ`)
} finally {
  releaseScratchHome(home)
}
process.exit(bad === 0 ? 0 : 1)

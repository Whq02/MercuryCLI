;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, TurnReceiptMessage } from '../../src/engine/message-shapes/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-work-render-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { TurnReceiptRow } = await import('../../src/screen/messages/TurnReceiptRow.tsx')
const { ResumeRecapCard } = await import('../../src/screen/messages/ResumeRecapCard.tsx')
const { composeTranscript } = await import('../../src/screen/messages/Messages.tsx')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')
const { isNotEmptyMessage } = await import('../../src/engine/message-shapes/text.ts')
const { createFoldBoundaryMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { annotateBoundaryWithWork, buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { buildAwayRecap } = await import('../../src/screen/cockpit/awaySummary.ts')

const timestamp = new Date().toISOString()
const messages: Message[] = [createUserMessage({ content: 'Repair the file and run its checks.' })]
for (const name of ['Edit', 'Read', 'Bash', 'Edit', 'Read', 'Bash', 'Edit', 'Read', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash']) {
  const id = randomUUID()
  messages.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id, name, input: { file_path: '/repo/main.ts' } }] } } as Message)
  messages.push({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, ...(name === 'Edit' ? { toolUseResult: { filePath: '/repo/main.ts', structuredPatch: [{ lines: ['+fixed'] }] } } : {}) } as Message)
}
messages.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'The file is repaired.' }] } } as Message)
const keep = messages.slice(13)
const boundary = createFoldBoundaryMessage('manual', 80_000)
const summary = createUserMessage({ content: 'The repair and checks are complete.', isCompactSummary: true, isVisibleInTranscriptOnly: true })
annotateBoundaryWithWork(boundary, messages, keep, summary.uuid)
const folded = buildPostFoldMessages({ boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: keep, attachments: [], hookResults: [], preCompactTokenCount: 80_000, postCompactTokenCount: 200 })
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? `: ${detail} (to fix: the work counts a fold carries are written by annotateBoundaryWithWork in src/engine/compaction/foldConversation.ts and painted by src/screen/messages/TurnReceiptRow.tsx and ResumeRecapCard.tsx, with the recap numbers from buildAwayRecap in src/screen/cockpit/awaySummary.ts; compare the printed frame with the unfolded one)` : ''}`) }
async function frame(rows: Message[], width: number): Promise<string> {
  const composition = composeTranscript({ normalized: normalizeMessages(rows).filter(isNotEmptyMessage), syntheticStreamingRows: [], verbose: false, fullscreen: true, isTranscriptMode: false, truncateTranscript: false, tools: [], inProgressToolUseIDs: new Set() })
  const receipt = composition.collapsed.find((m): m is TurnReceiptMessage => m.type === 'turn_receipt')
  const recap = buildAwayRecap(rows, Date.now())!
  return renderToString(React.createElement(React.Fragment, null,
    receipt ? React.createElement(TurnReceiptRow, { message: receipt }) : null,
    React.createElement(ResumeRecapCard, { metadata: { endedOnError: recap.endedOnError, turns: recap.turns, filesTouched: recap.filesTouched, topTools: recap.topTools, toolFailures: recap.toolFailures }, addMargin: true }),
  ), width)
}
try {
  const sparseKeep = structuredClone(keep)
  const sparseFirst = sparseKeep[0]!
  if (sparseFirst.type === 'assistant' && sparseFirst.message.content[0]?.type === 'text') sparseFirst.message.content[0].text = ''
  const emptyHead = { type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [] } } as unknown as Message
  const sparseBoundary = createFoldBoundaryMessage('manual', 80_000)
  annotateBoundaryWithWork(sparseBoundary, [emptyHead, ...messages], [emptyHead, ...sparseKeep], summary.uuid)
  const sparseFold = buildPostFoldMessages({ boundaryMarker: sparseBoundary, summaryMessages: [summary], messagesToKeep: [emptyHead, ...sparseKeep], attachments: [], hookResults: [], preCompactTokenCount: 80_000, postCompactTokenCount: 200 })
  check('hidden empty rows and blocks cannot swallow the receipt carry', await frame(messages, 120) === await frame(sparseFold, 120), await frame(sparseFold, 120))
  for (const width of [80, 120]) {
    const before = await frame(messages, width)
    const after = await frame(folded, width)
    console.log(`FRAME ${width}\n${after}`)
    check(`both rendered count surfaces keep their exact words at ${width} columns`, before === after, after)
    check(`work line shows all edits, reads and commands at ${width} columns`, after.includes('3 file edits +3') && after.includes('3 reads') && after.includes('7 shell commands'), after)
    check(`resume card shows the full turn and top tools at ${width} columns`, after.includes('1 turn') && after.includes('Bash×7 Edit×3 Read×3'), after)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold work render (${failures} failures)`)
process.exit(failures ? 1 : 0)

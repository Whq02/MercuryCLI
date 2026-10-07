;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, TurnReceiptMessage } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-work-render-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { TurnReceiptRow } = await import('../../src/components/messages/TurnReceiptRow.tsx')
const { ResumeRecapCard } = await import('../../src/components/messages/ResumeRecapCard.tsx')
const { composeTranscript } = await import('../../src/components/Messages.tsx')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { createCompactBoundaryMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { annotateBoundaryWithWork, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { buildAwayRecap } = await import('../../src/utils/cockpit/awaySummary.ts')

const timestamp = new Date().toISOString()
const messages: Message[] = [createUserMessage({ content: 'Repair the file and run its checks.' })]
for (const name of ['Edit', 'Read', 'Bash', 'Edit', 'Read', 'Bash', 'Edit', 'Read', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash']) {
  const id = randomUUID()
  messages.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id, name, input: { file_path: '/repo/main.ts' } }] } } as Message)
  messages.push({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, ...(name === 'Edit' ? { toolUseResult: { filePath: '/repo/main.ts', structuredPatch: [{ lines: ['+fixed'] }] } } : {}) } as Message)
}
messages.push({ type: 'assistant', uuid: randomUUID(), timestamp, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'The file is repaired.' }] } } as Message)
const keep = messages.slice(13)
const boundary = createCompactBoundaryMessage('manual', 80_000)
const summary = createUserMessage({ content: 'The repair and checks are complete.', isCompactSummary: true, isVisibleInTranscriptOnly: true })
annotateBoundaryWithWork(boundary, messages, keep, summary.uuid)
const folded = buildPostCompactMessages({ boundaryMarker: boundary, summaryMessages: [summary], messagesToKeep: keep, attachments: [], hookResults: [], preCompactTokenCount: 80_000, postCompactTokenCount: 200 })
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? `: ${detail}` : ''}`) }
async function frame(rows: Message[], width: number): Promise<string> {
  const composition = composeTranscript({ normalized: normalizeMessages(rows), syntheticStreamingRows: [], verbose: false, fullscreen: true, isTranscriptMode: false, truncateTranscript: false, tools: [], inProgressToolUseIDs: new Set() })
  const receipt = composition.collapsed.find((m): m is TurnReceiptMessage => m.type === 'turn_receipt')
  const recap = buildAwayRecap(rows, Date.now())!
  return renderToString(React.createElement(React.Fragment, null,
    receipt ? React.createElement(TurnReceiptRow, { message: receipt }) : null,
    React.createElement(ResumeRecapCard, { metadata: { endedOnError: recap.endedOnError, turns: recap.turns, filesTouched: recap.filesTouched, topTools: recap.topTools, toolFailures: recap.toolFailures }, addMargin: true }),
  ), width)
}
try {
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

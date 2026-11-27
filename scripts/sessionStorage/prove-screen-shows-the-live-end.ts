#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import type { LeafScene } from '../lib/resumeLeafScenes.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'screen-live-end-')))
const home = join(scratch, 'home')
const workdir = join(scratch, 'project')
mkdirSync(home)
mkdirSync(workdir)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
delete process.env.MERCURY_TRANSCRIPT_READER
process.chdir(workdir)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const state = await import('../../src/boot/process-state/processState.ts')
state.setOriginalCwd(workdir)
state.setCwdState(workdir)
state.setProjectRoot(workdir)
const { LEAF_SCENES, LEAF_UNFINISHED_SCENE, writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
const { readTranscriptChainSince } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { flushSessionStorage, getTranscriptPath, recordTranscript, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { createFoldBoundaryMessage, createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')

const HINT =
  'buildScreenConversation in src/sessions/transcripts/chain.ts must return the screenRows of electConversationEnd(messages) in src/sessions/transcripts/conversationEnd.ts; the screen keeps no chooser of its own in src/sessions/transcripts/rowGraph.ts'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail}; ` : ''}${HINT}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value)

type ScreenRow = { uuid: string; type: string }

function shapeOf(rows: readonly ScreenRow[], scene: LeafScene): string[] {
  const names = new Map<string, string>([
    [scene.prompt, 'prompt'],
    [scene.calls[0], 'call_a'],
    [scene.calls[1], 'call_b'],
    [scene.final, 'final'],
    ...scene.reports.map((id, index): [string, string] => [id, `report_${index}`]),
    ...(scene.boundary ? [[scene.boundary, 'boundary'] as [string, string]] : []),
    ...(scene.summary ? [[scene.summary, 'summary'] as [string, string]] : []),
    ...(scene.second ? [[scene.second.prompt, 'second_prompt'] as [string, string], [scene.second.end, 'second_end'] as [string, string]] : []),
  ])
  return rows.map(row => names.get(row.uuid) ?? row.type)
}

const RETAINS_ITS_CALLS: ReadonlySet<string> = new Set(['plain', 'tie', 'tie-behind', 'kept'])
const SHOWN_AS_BEFORE: Readonly<Record<string, string[]>> = {
  fold: ['boundary', 'summary', 'final', 'report_0'],
  two: ['boundary', 'summary', 'final', 'report_0', 'report_1'],
  'double-fold': ['boundary', 'summary', 'final', 'report_0'],
  'kept-late': ['boundary', 'summary', 'user', 'final', 'report_0', 'second_prompt', 'second_end'],
  onward: ['boundary', 'summary', 'final', 'report_0', 'second_prompt', 'second_end'],
  unfinished: ['boundary', 'summary', 'final', 'second_prompt', 'second_end', 'report_0'],
}

try {
  for (const name of [...LEAF_SCENES, LEAF_UNFINISHED_SCENE] as const) {
    section(`${name}: the rows the daemon's transcript connector reads for the screen`)
    const scene = await writeLeafScene(name)
    const chain = await readTranscriptChainSince(scene.file, null)
    const rows = chain.rows
    const ids: string[] = rows.map(row => row.uuid)
    const at = (id: string): number => ids.indexOf(id)
    const shape = j(shapeOf(rows, scene))
    check(`${name}: the screen holds the last reply and the row the conversation ends on`, ids.includes(scene.final) && ids.includes(scene.end), shape)
    if (scene.boundary !== undefined && scene.summary !== undefined) {
      check(`${name}: the fold line and its summary stand above the reply, in that order`, at(scene.boundary) >= 0 && at(scene.boundary) < at(scene.summary) && at(scene.summary) < at(scene.final), shape)
    }
    if (RETAINS_ITS_CALLS.has(name)) {
      check(`${name}: each result is shown once, under its calls and above the reply`, scene.reports.every(id => ids.filter(seen => seen === id).length === 1 && at(id) > at(scene.calls[1]) && at(id) < at(scene.final)) && at(scene.calls[0]) >= 0 && at(scene.calls[0]) < at(scene.calls[1]), shape)
    } else {
      check(`${name}: the result of the call that was folded away is still shown once, below the reply`, scene.reports.every(id => ids.filter(seen => seen === id).length === 1 && at(id) > at(scene.final)), shape)
    }
    if (scene.second !== undefined) check(`${name}: the second turn is shown below the reply`, at(scene.second.prompt) > at(scene.final) && at(scene.second.end) > at(scene.second.prompt), shape)
    check(`${name}: no row is shown twice`, new Set(ids).size === ids.length, shape)
    const before = SHOWN_AS_BEFORE[name]
    if (before !== undefined) check(`${name}: the screen is row for row what it was`, shape === j(before), shape)

    if (name === 'tie-behind') {
      section(`${name}: a note, then a turn, are written under the late result of a call that is still shown`)
      const note = createSystemMessage('screen proof: a note under the late result', 'info')
      const prompt = createUserMessage({ content: 'screen proof: the prompt after the note' })
      await recordTranscript([note])
      await flushSessionStorage()
      const noted = await readTranscriptChainSince(scene.file, chain.cursor)
      check(`${name}: the note is appended below the reply and no shown row is taken back`, !noted.rewound && j(noted.appended.map(row => row.uuid)) === j([note.uuid]) && noted.rows.at(-2)?.uuid === scene.final, `rewound ${noted.rewound}, ${j(shapeOf(noted.rows, scene))}`)
      await recordTranscript([prompt])
      await flushSessionStorage()
      const asked = await readTranscriptChainSince(scene.file, noted.cursor)
      check(`${name}: the prompt is appended below the note, which keeps its place`, !asked.rewound && j(asked.appended.map(row => row.uuid)) === j([prompt.uuid]) && noted.rows.every((row, index) => asked.rows[index] === row), `rewound ${asked.rewound}, ${j(shapeOf(asked.rows, scene))}`)
    }

    if (name === 'fold') {
      section(`${name}: the session goes on and the connector reads again`)
      const note = createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_note', blockIndex: 0 }] })
      const prompt = createUserMessage({ content: 'screen proof: the next prompt' })
      const reply = createAssistantMessage({ content: 'screen proof: the next reply' })
      reply.message.stop_reason = 'end_turn'
      await recordTranscript([note])
      await recordTranscript([prompt])
      await recordTranscript([reply])
      await flushSessionStorage()
      const grown = await readTranscriptChainSince(scene.file, chain.cursor)
      check(
        `${name}: control: the next read appends the note and the turn written under the late result and takes no shown row back`,
        !grown.rewound && grown.since === rows.length && j(grown.appended.map(row => row.uuid)) === j([note.uuid, prompt.uuid, reply.uuid]) && rows.every((row, index) => grown.rows[index] === row),
        `rewound ${grown.rewound}, since ${grown.since} of ${rows.length}, ${j(shapeOf(grown.rows, scene))}`,
      )
    }
  }

  section('a fold in mid-turn: the result of a folded call lands, and the reply is written straight under it')
  {
    resetProjectForTesting()
    state.switchSession(asSessionId(randomUUID()))
    const call = createAssistantMessage({ content: [{ type: 'tool_use', id: 'midturn_call', name: 'Read', input: { file_path: 'fixture' } }] })
    call.message.stop_reason = 'tool_use'
    const boundary = createFoldBoundaryMessage('auto', 900, call.uuid)
    const summary = createUserMessage({ content: 'summary in mid-turn', isCompactSummary: true })
    const late = createUserMessage({ sourceToolAssistantUUID: call.uuid, content: [{ type: 'tool_result', tool_use_id: 'midturn_call', content: 'report' }] })
    const reply = createAssistantMessage({ content: 'reply in mid-turn' })
    reply.message.stop_reason = 'end_turn'
    for (const row of [createUserMessage({ content: 'prompt in mid-turn' }), call, boundary, summary, late, reply]) await recordTranscript([row])
    await flushSessionStorage()
    const shown = (await readTranscriptChainSince(getTranscriptPath(), null)).rows.map(row => row.uuid)
    check('the screen is row for row what it was: the fold line, the summary, the late result, the reply', j(shown) === j([boundary.uuid, summary.uuid, late.uuid, reply.uuid]), `${shown.length} rows`)
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\nTHE SCREEN SHOWS THE LIVE END: ${checks} checks hold` : `\n${failures} of ${checks} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)

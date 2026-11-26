#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { AgentId } from '../../src/sessions/transcripts/ids.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'crewmate-live-end-')))
const home = join(scratch, 'home')
const workdir = join(scratch, 'project')
mkdirSync(home)
mkdirSync(workdir)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(workdir)

const state = await import('../../src/boot/process-state/processState.ts')
state.setOriginalCwd(workdir)
state.setCwdState(workdir)
state.setProjectRoot(workdir)
const { landCrewmateTranscriptRows } = await import('../../src/tools/crewmate/runCrewmate.ts')
const { getCrewmateTranscript, getCrewmateTranscriptPath, loadCrewmateTranscripts, resetProjectForTesting } = await import(
  '../../src/sessions/transcripts/sessionStorage.ts'
)
const { appendEntryToFile } = await import('../../src/sessions/transcripts/writer.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { asAgentId, asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { settleToolUsesOfEndedRun } = await import('../../src/engine/messages/apiFilters.ts')
const { ENDED_RUN_TOOL_RESULT } = await import('../../src/engine/message-shapes/rejectionText.ts')

const HINT =
  "getCrewmateTranscript in src/sessions/transcripts/sessionListings.ts must take the crewmate's end and its rows from electConversationEnd(messages, { kind: 'crewmate', agentId }) in src/sessions/transcripts/conversationEnd.ts, not from the newest row of the sidechain"

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

let clock = Date.parse('2026-11-26T09:00:00.000Z')
function stamped<T extends Message>(row: T): T {
  row.timestamp = new Date(++clock).toISOString()
  return row
}
function said(text: string): UserMessage {
  return stamped(createUserMessage({ content: text }))
}
function replied(text: string): AssistantMessage {
  const row = stamped(createAssistantMessage({ content: text }))
  row.message.stop_reason = 'end_turn'
  return row
}
function called(id: string, group: string): AssistantMessage {
  const row = stamped(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture' } }] }))
  row.message.id = group
  row.message.stop_reason = 'tool_use'
  return row
}
function reported(id: string, issuer: AssistantMessage, text: string): UserMessage {
  return stamped(createUserMessage({ sourceToolAssistantUUID: issuer.uuid, content: [{ type: 'tool_result', tool_use_id: id, content: text }] }))
}

type Lane = { agentId: AgentId; land: (...rows: Message[]) => Promise<void> }

function lane(): Lane {
  const agentId = asAgentId(`a${randomUUID().replace(/-/g, '').slice(0, 16)}`)
  let tail: UUID | undefined
  return {
    agentId,
    land: async (...rows) => {
      for (const row of rows) tail = await landCrewmateTranscriptRows([row], agentId, tail)
    },
  }
}

function shapeOf(rows: readonly Message[]): string[] {
  return rows.map(row => {
    if (row.type === 'system') return `system:${row.subtype}`
    if (row.type !== 'user' && row.type !== 'assistant') return row.type
    const content = row.message.content
    if (typeof content === 'string') return content
    return content
      .map(block => (block.type === 'text' ? block.text : block.type === 'tool_use' ? `call:${block.id}` : block.type === 'tool_result' ? `result:${block.tool_use_id}` : block.type))
      .join('+')
  })
}

async function resumed(agentId: AgentId): Promise<Message[]> {
  _resetTranscriptReaderForTesting()
  return (await getCrewmateTranscript(agentId))?.messages ?? []
}

function turns(rows: readonly Message[]): string[] {
  return shapeOf(rows.filter(row => row.type === 'user' || row.type === 'assistant'))
}

const j = (value: unknown): string => JSON.stringify(value)

resetProjectForTesting()
state.switchSession(asSessionId(randomUUID()))

try {
  section("§1 a call's result lands after the crewmate folded: the resume keeps the summary and the last reply")
  {
    const crew = lane()
    const brief = said('C1-BRIEF')
    const a = called('c1_call_a', 'msg_c1')
    const b = called('c1_call_b', 'msg_c1')
    const summary = stamped(createUserMessage({ content: 'C1-SUMMARY', isCompactSummary: true }))
    const final = replied('C1-FINAL')
    await crew.land(brief, a, b, stamped(createFoldBoundaryMessage('auto', 1500, b.uuid)), summary, final, reported('c1_call_a', a, 'C1-LATE-REPORT'))
    const rows = await resumed(crew.agentId)
    const ids = rows.map(row => row.uuid)
    check('§1 the resumed crewmate holds its summary and its last reply', ids.includes(summary.uuid) && ids.includes(final.uuid), j(shapeOf(rows)))
    check('§1 the conversation it resumes is the summary and then the reply, nothing else', j(turns(rows)) === j(['C1-SUMMARY', 'C1-FINAL']), j(turns(rows)))
    check('§1 the result of the call that was folded away is not sent back to the model', !j(rows).includes('C1-LATE-REPORT') && !ids.includes(brief.uuid), j(shapeOf(rows)))
    const viaBugReport = (await loadCrewmateTranscripts([crew.agentId]))[crew.agentId] ?? []
    check('§1 the read that a bug report makes of the same crewmate is the same rows', j(viaBugReport.map(row => row.uuid)) === j(ids) && ids.length > 0, j(shapeOf(viaBugReport)))
  }

  section('§2 the crewmate went on after that late result: its newer reply is the end, behind the summary and the earlier reply')
  {
    const crew = lane()
    const a = called('c2_call_a', 'msg_c2')
    const b = called('c2_call_b', 'msg_c2')
    const summary = stamped(createUserMessage({ content: 'C2-SUMMARY', isCompactSummary: true }))
    const final = replied('C2-FINAL')
    const onward = replied('C2-ONWARD')
    await crew.land(said('C2-BRIEF'), a, b, stamped(createFoldBoundaryMessage('auto', 1500, b.uuid)), summary, final, reported('c2_call_a', a, 'C2-LATE-REPORT'), onward)
    const rows = await resumed(crew.agentId)
    check('§2 the resume is the summary, the reply before the late result and the reply after it', j(turns(rows)) === j(['C2-SUMMARY', 'C2-FINAL', 'C2-ONWARD']), j(turns(rows)))
    check('§2 it ends on the newer reply', rows.at(-1)?.uuid === onward.uuid, j(shapeOf(rows)))
  }

  section('§3 no fold: a late result carries the last reply\'s own millisecond and stands behind it in the file')
  {
    const crew = lane()
    const brief = said('C3-BRIEF')
    const a = called('c3_call_a', 'msg_c3')
    const b = called('c3_call_b', 'msg_c3')
    const forB = reported('c3_call_b', b, 'C3-REPORT-B')
    const final = replied('C3-FINAL')
    const forA = reported('c3_call_a', a, 'C3-REPORT-A')
    forA.timestamp = final.timestamp
    await crew.land(brief, a, b, forB, final, forA)
    const rows = await resumed(crew.agentId)
    const ids = rows.map(row => row.uuid)
    const at = (row: Message): number => ids.indexOf(row.uuid)
    check('§3 the resumed crewmate ends on its last reply', rows.at(-1)?.uuid === final.uuid, j(shapeOf(rows)))
    check('§3 both results are there once, each behind its call and before the reply', [forA, forB].every(row => ids.filter(id => id === row.uuid).length === 1 && at(row) > at(b) && at(row) < at(final)) && at(a) < at(b), j(shapeOf(rows)))
    check('§3 the first prompt still opens it', ids[0] === brief.uuid, j(shapeOf(rows)))
  }

  section('§4 control: a call the run never answered is still read as unanswered')
  {
    const crew = lane()
    const brief = said('C4-BRIEF')
    const a = called('c4_call_a', 'msg_c4')
    const b = called('c4_call_b', 'msg_c4')
    const forB = reported('c4_call_b', b, 'C4-REPORT-B')
    await crew.land(brief, a, b, forB)
    const rows = await resumed(crew.agentId)
    check('§4 the resume is the prompt, both calls and the one result that came', j(rows.map(row => row.uuid)) === j([brief.uuid, a.uuid, b.uuid, forB.uuid]), j(shapeOf(rows)))
    const settled = settleToolUsesOfEndedRun(rows)
    const answers = settled.flatMap(row => (row.type === 'user' && Array.isArray(row.message.content) ? row.message.content : [])).filter(block => block.type === 'tool_result' && block.tool_use_id === 'c4_call_a')
    check('§4 the resume answers the open call as one the ended run left without a result', answers.length === 1 && j(answers[0]).includes(ENDED_RUN_TOOL_RESULT), j(shapeOf(settled)))
  }

  section("§5 control: a newer row of another seat and a newer row of the lead in the same file are never the crewmate's end")
  {
    const crew = lane()
    const brief = said('C5-BRIEF')
    const a = called('c5_call_a', 'msg_c5')
    const final = replied('C5-FINAL')
    await crew.land(brief, a, reported('c5_call_a', a, 'C5-REPORT-A'), final)
    const file = getCrewmateTranscriptPath(crew.agentId)
    const foreign = { parentUuid: final.uuid, cwd: workdir, sessionId: state.getSessionId(), version: '1.0.0' }
    appendEntryToFile(file, { ...replied('C5-OTHER-SEAT'), ...foreign, isSidechain: true, agentId: lane().agentId })
    appendEntryToFile(file, { ...replied('C5-THE-LEAD'), ...foreign, isSidechain: false })
    const rows = await resumed(crew.agentId)
    check("§5 the resume ends on the crewmate's own reply", rows.at(-1)?.uuid === final.uuid, j(shapeOf(rows)))
    check('§5 neither foreign row is in it', !j(rows).includes('C5-OTHER-SEAT') && !j(rows).includes('C5-THE-LEAD') && rows[0]?.uuid === brief.uuid, j(shapeOf(rows)))
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\nA RESUMED CREWMATE READS ITS LIVE END: ${checks} checks hold` : `\n${failures} of ${checks} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)

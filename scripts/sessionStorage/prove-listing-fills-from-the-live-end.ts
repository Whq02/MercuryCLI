#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import type { LeafScene } from '../lib/resumeLeafScenes.ts'
import type { Attachment } from '../../src/engine/attachment-shapes/attachmentTypes.ts'
import type { Message } from '../../src/engine/message-shapes/message.ts'
import type { SessionListing } from '../../src/sessions/transcripts/transcriptEntries.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'listing-live-end-')))
const home = join(scratch, 'home')
const workdir = join(scratch, 'project')
mkdirSync(home)
mkdirSync(workdir)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(workdir)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const state = await import('../../src/boot/process-state/processState.ts')
state.setOriginalCwd(workdir)
state.setCwdState(workdir)
state.setProjectRoot(workdir)
const { LEAF_SCENES, LEAF_UNFINISHED_SCENE, writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
const { fillSessionListing, flushSessionStorage, isLiteListing, lastSession, listSessions, listingsOfSessionFile, recordTranscript } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { recordTurnEnd } = await import('../../src/sessions/transcripts/writer.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const React = await import('react')
const { mountOffscreen, pause } = await import('../lib/settingsPopupHarness.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { SessionPreview } = await import('../../src/screen/session-chooser/SessionPreview.tsx')
const { deserializeMessages } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { flipToSession } = await import('../../src/engine/connector/sessionFlip.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')

const HINT =
  "fillSessionListing in src/sessions/transcripts/sessionListings.ts must take the end and the rows of the listing from electConversationEnd(loaded.messages) in src/sessions/transcripts/conversationEnd.ts (primary for leafUuid, summary and gitBranch; rows for messages), not from the newest computed leaf; the preview in src/screen/session-chooser/SessionPreview.tsx draws those rows through deserializeMessages with the listing's own turnEnd"

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

function shapeOf(rows: readonly Message[], scene: LeafScene): string[] {
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
  return rows.map(row => names.get(row.uuid) ?? (row.type === 'system' ? `system:${row.subtype}` : row.type))
}

function lastTurn(rows: readonly Message[]): Message | undefined {
  return rows.findLast(row => row.type === 'user' || row.type === 'assistant')
}

const CLOCK_ALONE = /^[│ ]*\d{1,2}:\d{2}(:\d{2})?( [AP]M)?[ │]*$/

function drawnBy(listing: SessionListing): Message[] {
  return deserializeMessages(listing.messages, listing.turnEnd)
}

async function previewFrame(log: SessionListing, awaited: string): Promise<string[]> {
  const preview = React.createElement(SessionPreview, { log, onExit: () => {}, onSelect: () => {} })
  const view = await mountOffscreen(React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, preview), 100, 30)
  let lines: string[] = []
  for (let tries = 0; tries < 100 && !lines.some(line => line.includes(awaited)); tries++) {
    await pause(50)
    lines = view.lines()
  }
  await pause(200)
  lines = view.lines()
  view.unmount()
  return lines
}

async function liteListingOf(scene: LeafScene): Promise<SessionListing | undefined> {
  return (await listSessions()).find(log => log.sessionId === scene.sid)
}

const RETAINS_ITS_CALLS: ReadonlySet<string> = new Set(['plain', 'tie', 'tie-behind', 'kept'])
const BEHIND_THE_LAST_TURN: ReadonlyArray<{ what: string; attachment: Attachment; asks: boolean }> = [
  { what: 'an attachment the model is never sent', attachment: { type: 'dead_thinking', dead: [{ messageId: 'msg_note', blockIndex: 0 }] }, asks: false },
  { what: "a hook's notice", attachment: { type: 'hook', outcome: 'notice', event: 'turn.end', name: 'listing-proof', words: 'listing proof: the hook said so' }, asks: false },
  { what: 'a changed-file notice', attachment: { type: 'edited_text_file', filename: 'fixture.txt', snippet: '1\tchanged' }, asks: true },
  { what: 'an instructions delta', attachment: { type: 'mcp_instructions_delta', addedNames: ['fixture'], addedBlocks: ['## fixture\nlisting proof'], removedNames: [] }, asks: true },
  { what: 'a prompt typed while the turn ran', attachment: { type: 'queued_command', prompt: 'listing proof: typed while the turn ran' }, asks: true },
]

try {
  for (const name of [...LEAF_SCENES, LEAF_UNFINISHED_SCENE] as const) {
    section(`${name}: the lite listing of the picker, filled`)
    const scene = await writeLeafScene(name)
    const lite = await liteListingOf(scene)
    if (lite === undefined || !isLiteListing(lite)) {
      check(`${name}: the session is listed lite`, false, `listSessions() gave ${lite === undefined ? 'no row' : 'a filled row'} for ${scene.sid}`)
      continue
    }
    const filled = await fillSessionListing(lite)
    const rows = filled.messages
    const ids = rows.map(row => row.uuid)
    const shape = j(shapeOf(rows, scene))
    check(`${name}: the listing's end is the row the conversation ends on`, filled.leafUuid === scene.end && lastTurn(rows)?.uuid === scene.end, `leafUuid ${shapeOf(rows.filter(row => row.uuid === filled.leafUuid), scene)[0] ?? filled.leafUuid} in ${shape}`)
    check(`${name}: the last reply is in the listing`, ids.includes(scene.final), shape)
    if (scene.summary !== undefined) check(`${name}: the active summary is in the listing`, ids.includes(scene.summary), shape)
    check(
      RETAINS_ITS_CALLS.has(name) ? `${name}: each result stands once, with the call it answers` : `${name}: the result of a call that was folded away is not in the listing`,
      RETAINS_ITS_CALLS.has(name) ? scene.reports.every(id => ids.filter(seen => seen === id).length === 1) && scene.calls.every(id => ids.includes(id)) : scene.reports.every(id => !ids.includes(id)),
      shape,
    )
    if (scene.second !== undefined) check(`${name}: the second turn is in the listing, behind the last reply`, ids.indexOf(scene.second.prompt) > ids.indexOf(scene.final) && ids.indexOf(scene.second.end) > ids.indexOf(scene.second.prompt), shape)

    const painted = drawnBy(filled)
    check(
      name === LEAF_UNFINISHED_SCENE ? `${name}: the preview still shows the open call` : `${name}: the preview ends on the conversation's end, with no row made up behind it`,
      name === LEAF_UNFINISHED_SCENE ? painted.some(row => row.uuid === scene.end) : painted.at(-1)?.uuid === scene.end,
      j(shapeOf(painted, scene)),
    )

    if (name === 'fold') {
      section(`${name}: the connector flip and the branch list`)
      state.switchSession(asSessionId(randomUUID()))
      const flipped: SessionListing[] = []
      const outcome = await flipToSession(async (_sessionId, log) => {
        flipped.push(log)
      }, scene.sid)
      const flippedIds = (flipped[0]?.messages ?? []).map(row => row.uuid)
      check(`${name}: a flip to the session hands on the same filled listing`, outcome.flipped && flipped[0]?.leafUuid === scene.end && j(flippedIds) === j(ids), `${j(outcome)} ${j(shapeOf(flipped[0]?.messages ?? [], scene))}`)
      const branches = await listingsOfSessionFile(scene.file)
      const ends = branches.map(branch => branch.leafUuid)
      check(`${name}: control: the list of every branch still names both ends, the reply and the late result`, ends.includes(scene.final) && scene.reports.every(id => ends.includes(id)), j(branches.map(branch => shapeOf(branch.messages.filter(row => row.uuid === branch.leafUuid), scene)[0] ?? branch.leafUuid)))
    }
  }

  for (const { what, attachment, asks } of BEHIND_THE_LAST_TURN) {
    section(`a finished session, then ${what} written behind its last reply`)
    const scene = await writeLeafScene('plain')
    await recordTurnEnd('listing-proof-turn', 'completed')
    await flushSessionStorage()
    const lite = await liteListingOf(scene)
    if (lite === undefined || !isLiteListing(lite)) {
      check(`${what}: the session is listed lite`, false, `listSessions() gave ${lite === undefined ? 'no row' : 'a filled row'} for ${scene.sid}`)
      continue
    }
    const before = await fillSessionListing(lite)
    const drawnBefore = drawnBy(before).map(each => each.uuid)
    const row = createAttachmentMessage(attachment)
    await recordTranscript([row])
    await flushSessionStorage()
    _resetTranscriptReaderForTesting()
    const filled = await fillSessionListing(lite)
    const byId = await lastSession(scene.sid)
    check(`${what}: the rows through the listing are the rows by id, row for row, the row among them`, filled.messages.some(each => each.uuid === row.uuid) && j(filled.messages.map(each => each.uuid)) === j((byId?.messages ?? []).map(each => each.uuid)), `${j(shapeOf(filled.messages, scene))} · by id ${j(shapeOf(byId?.messages ?? [], scene))}`)
    check(`${what}: the listing's end, first prompt and count are what they were before the row`, filled.leafUuid === scene.final && filled.firstPrompt === before.firstPrompt && filled.messageCount === before.messageCount, `${shapeOf(filled.messages.filter(each => each.uuid === filled.leafUuid), scene)[0] ?? filled.leafUuid} ${j(filled.firstPrompt)} ${filled.messageCount} · before ${j(before.firstPrompt)} ${before.messageCount}`)
    const drawn = drawnBy(filled)
    const behind = drawn.slice(drawnBefore.length)
    check(
      asks ? `${what}: a request would carry it, so the preview draws the rows it drew before, the row, and the two rows an unanswered turn gets` : `${what}: the preview draws the rows it drew before, then the row`,
      j(drawn.slice(0, drawnBefore.length).map(each => each.uuid)) === j(drawnBefore) && behind[0]?.uuid === row.uuid && (asks ? behind.length === 3 && behind[1]?.type === 'user' && behind[1].isMeta === true && behind[2]?.type === 'assistant' : behind.length === 1),
      j(shapeOf(drawn, scene)),
    )
  }

  section("turns that ended, each with its hook's row written before the run's turn-end record")
  {
    const scene = await writeLeafScene('plain')
    const hookOf = (words: string): Message => createAttachmentMessage({ type: 'hook', outcome: 'context', event: 'turn.end', name: 'listing-proof', words })
    const first = hookOf('listing proof: the hook adds context')
    await recordTranscript([first])
    await recordTurnEnd('listing-proof-turn', 'completed')
    await flushSessionStorage()
    _resetTranscriptReaderForTesting()
    const lite = await liteListingOf(scene)
    const filled = lite === undefined ? undefined : await fillSessionListing(lite)
    const listed = new Set((filled?.messages ?? []).map(each => each.uuid))
    const drawn = filled === undefined ? [] : drawnBy(filled)
    check("the listing ends on the reply and holds the hook's row behind it", filled?.leafUuid === scene.final && filled.messages.at(-1)?.uuid === first.uuid, j(shapeOf(filled?.messages ?? [], scene)))
    check('the run ended that turn, so the preview draws the rows of the listing and none made up behind them', drawn.at(-1)?.uuid === first.uuid && drawn.every(each => listed.has(each.uuid)), j(shapeOf(drawn, scene)))
    const frame = lite === undefined ? [] : await previewFrame(lite, 'the hook adds context')
    check("the mounted preview paints the hook's words and no reply header with nothing under it", frame.some(line => line.includes('the hook adds context')) && !frame.some(line => CLOCK_ALONE.test(line)), frame.join(' / '))

    const again = createUserMessage({ content: 'listing proof: a second turn' })
    const answer = createAssistantMessage({ content: 'listing proof: the second reply' })
    answer.message.stop_reason = 'end_turn'
    answer.message.model = 'claude-sonnet-5'
    const second = hookOf('listing proof: the hook speaks again')
    await recordTranscript([again])
    await recordTranscript([answer])
    await recordTranscript([second])
    await recordTurnEnd('listing-proof-turn-2', 'completed')
    await flushSessionStorage()
    _resetTranscriptReaderForTesting()
    const twice = lite === undefined ? undefined : await fillSessionListing(lite)
    const twiceListed = new Set((twice?.messages ?? []).map(each => each.uuid))
    const twiceDrawn = twice === undefined ? [] : drawnBy(twice)
    check('two such turns: the preview draws the rows of the listing and none made up behind them', twice?.leafUuid === answer.uuid && twiceDrawn.at(-1)?.uuid === second.uuid && twiceDrawn.every(each => twiceListed.has(each.uuid)), j(shapeOf(twiceDrawn, scene)))
    const twiceFrame = lite === undefined ? [] : await previewFrame(lite, 'the hook speaks again')
    check('two such turns: the mounted preview paints no reply header with nothing under it', twiceFrame.some(line => line.includes('the hook speaks again')) && !twiceFrame.some(line => CLOCK_ALONE.test(line)), twiceFrame.join(' / '))
  }

  section("a turn that really was cut is drawn as it was drawn without the run's record")
  for (const cut of ['a call left open', 'the record says interrupted'] as const) {
    const scene = await writeLeafScene('plain')
    await recordTurnEnd('listing-proof-turn', 'completed')
    const open = createAssistantMessage({ content: [{ type: 'tool_use', id: 'listing_proof_open', name: 'Read', input: { file_path: 'fixture' } }] })
    open.message.stop_reason = 'tool_use'
    await recordTranscript([createUserMessage({ content: 'listing proof: the turn that was cut' })])
    await recordTranscript([open])
    if (cut === 'the record says interrupted') await recordTurnEnd('listing-proof-turn-2', 'interrupted')
    await flushSessionStorage()
    _resetTranscriptReaderForTesting()
    const lite = await liteListingOf(scene)
    const filled = lite === undefined ? undefined : await fillSessionListing(lite)
    const drawn = filled === undefined ? [] : shapeOf(drawnBy(filled), scene)
    const drawnBlind = filled === undefined ? [] : shapeOf(deserializeMessages(filled.messages), scene)
    check(`${cut}: the preview draws the open call and what an unanswered turn gets, the same rows as without the record`, filled?.leafUuid === open.uuid && drawn.length > (filled?.messages.length ?? 0) && j(drawn) === j(drawnBlind), `${j(drawn)} · without the record ${j(drawnBlind)}`)
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\nA LISTING FILLS FROM THE LIVE END: ${checks} checks hold` : `\n${failures} of ${checks} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)

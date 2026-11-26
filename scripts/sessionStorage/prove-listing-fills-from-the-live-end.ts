#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import type { LeafScene } from '../lib/resumeLeafScenes.ts'
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
const { fillSessionListing, flushSessionStorage, isLiteListing, listSessions, listingsOfSessionFile, recordTranscript } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { deserializeMessages, loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { flipToSession } = await import('../../src/engine/connector/sessionFlip.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')

const HINT =
  'fillSessionListing in src/sessions/transcripts/sessionListings.ts must take the end and the rows of the listing from electConversationEnd(loaded.messages) in src/sessions/transcripts/conversationEnd.ts (primary for leafUuid, summary and gitBranch; rows for messages), not from the newest computed leaf'

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

async function liteListingOf(scene: LeafScene): Promise<SessionListing | undefined> {
  return (await listSessions()).find(log => log.sessionId === scene.sid)
}

const RETAINS_ITS_CALLS: ReadonlySet<string> = new Set(['plain', 'tie', 'tie-behind', 'kept'])

try {
  for (const name of [...LEAF_SCENES.filter(scene => scene !== 'large'), LEAF_UNFINISHED_SCENE] as const) {
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

    const painted = deserializeMessages(rows)
    check(
      name === LEAF_UNFINISHED_SCENE ? `${name}: the preview still shows the open call` : `${name}: the preview ends on the conversation's end, with no row made up behind it`,
      name === LEAF_UNFINISHED_SCENE ? painted.some(row => row.uuid === scene.end) : painted.at(-1)?.uuid === scene.end,
      j(shapeOf(painted, scene)),
    )

    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(lite, undefined)
    const kind = resumed?.turnInterruptionState.kind
    check(
      name === LEAF_UNFINISHED_SCENE ? `${name}: a resume through the listing still reads the open call as an interrupted turn` : `${name}: a resume through the listing is not read as interrupted`,
      name === LEAF_UNFINISHED_SCENE ? kind !== undefined && kind !== 'none' && (resumed?.messages ?? []).some(row => row.uuid === scene.end) : kind === 'none' && lastTurn(resumed?.messages ?? [])?.uuid === scene.end,
      `${kind ?? 'no resume'} ${j(shapeOf(resumed?.messages ?? [], scene))}`,
    )

    if (name === 'plain') {
      section(`${name}: rows that are neither prompt nor reply are written after the last reply`)
      const quiet = createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_note', blockIndex: 0 }] })
      await recordTranscript([quiet])
      await flushSessionStorage()
      _resetTranscriptReaderForTesting()
      const noted = await fillSessionListing(lite)
      const notedById = await loadConversationForResume(scene.sid, undefined)
      const notedByListing = await loadConversationForResume(lite, undefined)
      check(`${name}: the reply stays the listing's end and the row written after it is the listing's last row`, noted.leafUuid === scene.final && noted.messages.at(-1)?.uuid === quiet.uuid, j(shapeOf(noted.messages, scene)))
      check(`${name}: a resume through the listing hands on the rows a resume by id hands on, and neither is read as interrupted`, notedByListing?.turnInterruptionState.kind === 'none' && notedById?.turnInterruptionState.kind === 'none' && j((notedByListing?.messages ?? []).map(row => row.uuid)) === j((notedById?.messages ?? []).map(row => row.uuid)), `${notedByListing?.turnInterruptionState.kind} ${j(shapeOf(notedByListing?.messages ?? [], scene))} · by id ${notedById?.turnInterruptionState.kind} ${j(shapeOf(notedById?.messages ?? [], scene))}`)

      const queued = createAttachmentMessage({ type: 'queued_command', prompt: 'listing proof: typed while the turn ran' })
      await recordTranscript([queued])
      await flushSessionStorage()
      _resetTranscriptReaderForTesting()
      const askedById = await loadConversationForResume(scene.sid, undefined)
      const askedByListing = await loadConversationForResume(lite, undefined)
      const asked = j(shapeOf(askedByListing?.messages ?? [], scene))
      check(`${name}: a row that asks for a reply, written after the last reply, is in the resume through the listing and the turn reads as interrupted, as by id`, (askedByListing?.messages ?? []).some(row => row.uuid === queued.uuid) && askedByListing?.turnInterruptionState.kind === 'interrupted_prompt' && askedById?.turnInterruptionState.kind === 'interrupted_prompt' && asked === j(shapeOf(askedById?.messages ?? [], scene)), `${askedByListing?.turnInterruptionState.kind} ${asked} · by id ${askedById?.turnInterruptionState.kind} ${j(shapeOf(askedById?.messages ?? [], scene))}`)
    }

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
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\nA LISTING FILLS FROM THE LIVE END: ${checks} checks hold` : `\n${failures} of ${checks} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import type { UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'resume-live-end-')))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(project)

const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { createBranchSession } = await import('../../src/sessions/branches/branchManifest.ts')
const { transcriptMessageIndex } = await import('../../src/sessions/transcripts/materialize.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { adoptResumedSessionFile, flushSessionStorage, recordTranscript } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
const { createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { SYNTHETIC_MODEL } = await import('../../src/engine/message-shapes/factories.ts')
const { LEAF_SCENES, LEAF_UNFINISHED_SCENE, writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
import type { LeafScene } from '../lib/resumeLeafScenes.ts'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, hint: string, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail.slice(0, 700)}; ` : ''}${hint}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

type Row = { uuid: UUID; type: string; message?: { model?: string; content?: unknown } }
type Seen = { ids: UUID[]; lastTurn: UUID | undefined; interruption?: string; sessionId?: string }
type Source = { id: string; file: string }
type Door = { name: string; hint: string; read: (source: Source) => Promise<Seen | null> }

const ELECTION = 'electConversationEnd (src/sessions/transcripts/conversationEnd.ts)'
function seenOf(rows: readonly Row[]): Pick<Seen, 'ids' | 'lastTurn'> {
  return {
    ids: rows.map(row => row.uuid),
    lastTurn: rows.findLast(row => row.type === 'user' || (row.type === 'assistant' && row.message?.model !== SYNTHETIC_MODEL))?.uuid,
  }
}
async function resumed(id: string, file: string | undefined): Promise<Seen | null> {
  _resetTranscriptReaderForTesting()
  const loaded = await loadConversationForResume(id, file)
  if (loaded === null) return null
  const told = loaded.turnInterruptionState.kind === 'interrupted_prompt' ? loaded.turnInterruptionState.message.uuid : undefined
  return { ...seenOf(loaded.messages.filter(row => row.uuid !== told)), interruption: loaded.turnInterruptionState.kind, sessionId: loaded.sessionId }
}

const pathDoor: Door = {
  name: 'path',
  hint: `walkTranscriptFile in src/sessions/resume/conversationRecovery.ts must take the conversation and its end from ${ELECTION}, never from the newest row of the file`,
  read: source => resumed(source.id, source.file),
}
const doors: Door[] = [pathDoor]

function endsOnTheLiveEnd(door: Door, scene: LeafScene, seen: Seen | null): void {
  const label = `${scene.name} by ${door.name}`
  if (seen === null) {
    check(`${label}: a conversation is loaded`, false, door.hint, 'the door returned null')
    return
  }
  check(
    `${label}: the conversation ends on its last finished reply, holds the reply before it, and no interruption is invented`,
    seen.lastTurn === scene.end && seen.ids.includes(scene.final) && (seen.interruption ?? 'none') === 'none',
    door.hint,
    j({ endsOnEnd: seen.lastTurn === scene.end, hasEnd: seen.ids.includes(scene.end), hasFinal: seen.ids.includes(scene.final), interruption: seen.interruption, rows: seen.ids.length }),
  )
  if (scene.summary !== undefined) {
    check(`${label}: the active summary is in the conversation`, seen.ids.includes(scene.summary), door.hint, j({ rows: seen.ids.length }))
  }
  const retained = scene.boundary === undefined || scene.name === 'kept'
  check(
    `${label}: a late result ${retained ? 'stands with its retained call' : 'whose call was folded away is not in the conversation'}, and no row is there twice`,
    scene.reports.every(id => seen.ids.includes(id) === retained) && seen.ids.includes(scene.calls[0]) === retained && new Set(seen.ids).size === seen.ids.length,
    door.hint,
    j({ reports: scene.reports.map(id => seen.ids.includes(id)), call: seen.ids.includes(scene.calls[0]), rows: seen.ids.length, distinct: new Set(seen.ids).size }),
  )
  if (seen.sessionId !== undefined) check(`${label}: the session is the file's own`, seen.sessionId === scene.sid, door.hint, j({ sessionId: seen.sessionId }))
}

function branchAt(scene: LeafScene, last: UUID): Source {
  const branch = createBranchSession({ sourceTranscriptPath: scene.file, forkOrdinal: transcriptMessageIndex(scene.file, last) + 1, boundaryKind: 'rewind', cwd: project, providerOrigin: 'fixture' })
  if (!branch.ok) throw new Error(`the branch of ${scene.name} was not created: ${branch.reason}`)
  return { id: branch.manifest.branchSessionId, file: branch.branchTranscriptPath }
}

console.log('============================================================')
console.log(' a resumed session ends on the live end, by every door')
console.log('============================================================')

try {
  section(`§1 ${LEAF_SCENES.length} written scenes, each read by its path (an explicit .jsonl, run -c, a daemon claim)`)
  for (const name of LEAF_SCENES) {
    const scene = await writeLeafScene(name)
    for (const door of doors) endsOnTheLiveEnd(door, scene, await door.read({ id: scene.sid, file: scene.file }))
  }

  section('§2 a copied branch file by its path: the whole record copied, a prefix that stops before the final reply, a branch whose own sitting wrote only a notice')
  for (const name of ['tie-behind', 'fold'] as const) {
    const scene = await writeLeafScene(name)
    const seen = await pathDoor.read(branchAt(scene, scene.reports.at(-1)!))
    endsOnTheLiveEnd({ ...pathDoor, name: 'whole branch copy' }, scene, seen === null ? null : { ...seen, sessionId: undefined })
  }
  {
    const scene = await writeLeafScene('fold')
    const seen = await pathDoor.read(branchAt(scene, scene.summary!))
    check('fold by a prefix that stops at the summary: the copy is not extended — it ends on the summary, without the final reply or the late result', seen !== null && seen.ids.includes(scene.summary!) && !seen.ids.includes(scene.final) && !seen.ids.includes(scene.reports[0]!), pathDoor.hint, j({ rows: seen?.ids.length, hasFinal: seen?.ids.includes(scene.final), hasLate: seen?.ids.includes(scene.reports[0]!) }))
  }
  {
    const scene = await writeLeafScene('plain')
    const branch = branchAt(scene, scene.final)
    _resetTranscriptReaderForTesting()
    const carried = await loadConversationForResume(branch.id, branch.file)
    switchSession(asSessionId(branch.id), dirname(branch.file))
    adoptResumedSessionFile()
    const notice = createSystemMessage('branch sitting notice', 'info')
    await recordTranscript([notice], undefined, [...(carried?.messages ?? []), notice])
    await flushSessionStorage()
    const seen = await pathDoor.read(branch)
    check(
      'a branch copy whose own sitting wrote only a notice under the copied reply: the session is still the branch\'s own, never its source\'s, and the conversation ends on the copied reply',
      seen !== null && seen.sessionId === branch.id && seen.lastTurn === scene.end && (seen.interruption ?? 'none') === 'none',
      'walkTranscriptFile in src/sessions/resume/conversationRecovery.ts must answer with the session of the last row of the elected line: a resume writes into the file of the session it is told',
      j({ sessionId: seen?.sessionId, branch: branch.id, source: scene.sid, endsOnEnd: seen?.lastTurn === scene.end, interruption: seen?.interruption }),
    )
  }

  section('§3 a call the run never answered is still an unfinished turn after a late result, with the summary and the finished reply before it')
  {
    const scene = await writeLeafScene(LEAF_UNFINISHED_SCENE)
    const second = scene.second!
    const wanted = [scene.summary!, scene.final, second.prompt, second.end]
    for (const door of doors) {
      const seen = await door.read({ id: scene.sid, file: scene.file })
      check(
        `unfinished by ${door.name}: the conversation holds the summary, the finished reply, the second prompt and its open call, without the late result, and a resume is told the turn was cut`,
        seen !== null && wanted.every(id => seen.ids.includes(id)) && !seen.ids.includes(scene.reports[0]!) && (seen.interruption ?? 'interrupted_prompt') === 'interrupted_prompt',
        door.hint,
        j({ holds: seen === null ? null : wanted.map(id => seen.ids.includes(id)), hasLate: seen?.ids.includes(scene.reports[0]!), interruption: seen?.interruption }),
      )
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ A RESUMED SESSION ENDS ON THE LIVE END (${checks} checks)` : ` ❌ ${failures} of ${checks} RESUME-END CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

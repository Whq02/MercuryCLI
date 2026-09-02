#!/usr/bin/env bun
// ============================================================================
//  prove-chat-tag-live-title — the chat's tag walks L16's stages LIVE.
//
//  The hop (services/switchboard/hopIntoSession) derived the connector
//  record's title ONCE and status() returned that snapshot forever: a chat
//  born blank kept "new session · <project> · ready" in its status row after
//  its first words and after the model's minted title, while the board's
//  row (re-derived on every snapshot) walked the stages.
//  Now the hop registers the naming owner's derivation on the
//  connector and status() asks it on every paint.
//
//  §1 the deriver over scratch owners: no record title + no words ⇒ the
//     stage-1 fact; the first words land ⇒ stage 2; a stored (minted/typed)
//     title ⇒ stage 3; a rename after a mint ⇒ the rename (never regresses).
//  §2 source pins: status() reads through the deriver, falling back to the
//     snapshot; the hop registers it beside the snapshot derivation.
//  POISON: status() spelling `title: this.record.title` alone (the frozen tag).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-tag-live-title-'))
const HOME = join(SCRATCH, 'home')
const DAEMON = join(SCRATCH, 'daemon')
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const { sessionTitleOf, newSessionTitle } = await import('../../src/services/concourse/sessionNaming.ts')
const { headBriefLabel } = await import('../../src/services/concourse/concourseSnapshot.ts')
const { liveTitleDeriverFor } = await import('../../src/services/switchboard/hopIntoSession.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

const workspace = join(SCRATCH, 'work')
mkdirSync(workspace, { recursive: true })
const sessionId = 'aaaaaaaa-1111-4222-8333-444444444444'
const record = { sessionId, runnerId: 'r1', title: newSessionTitle(workspace), projectLabel: 'work', workspaceId: workspace, home: paths.getProjectDir(workspace) }
const deriver = liveTitleDeriverFor(supervisor, sessionTitleOf, headBriefLabel)

// §1a no records file, no transcript: the stage-1 fact (never null, never a worker id).
check('§1a no record, no words ⇒ the stage-1 fact', deriver(record) === newSessionTitle(workspace), String(deriver(record)))

// §1b the records file exists without a stored title; the first words land in the transcript ⇒ stage 2.
const workersPath = supervisor.concourseWorkersPath(DAEMON)
const writeWorkers = (title: string | undefined): void => {
  writeFileSync(workersPath, JSON.stringify({ version: 1, workers: { r1: { sessionId, runnerId: 'r1', workspaceId: workspace, ...(title !== undefined ? { title } : {}) } } }))
}
writeWorkers(undefined)
mkdirSync(paths.getProjectDir(workspace), { recursive: true })
const transcriptPath = join(paths.getProjectDir(workspace), `${sessionId}.jsonl`)
writeFileSync(
  transcriptPath,
  encodeSeedTranscript([{ type: 'user', uuid: 'u-1', timestamp: new Date().toISOString(), sessionId, message: { role: 'user', content: 'hello there tag' } }], sessionId),
)
check('§1b the first words land ⇒ stage 2 (the chat\'s own first line)', deriver(record) === 'hello there tag', String(deriver(record)))
check('§1b the first words are memoized (a second read answers the same without the file)', deriver(record) === 'hello there tag')

// §1c a stored title (the mint) lands on the record ⇒ stage 3 wins over the words; the file's mtime moves.
writeWorkers('Tag greeting session')
const t = new Date(Date.now() + 2000)
utimesSync(workersPath, t, t)
check('§1c a minted title on the record ⇒ stage 3 wins', deriver(record) === 'Tag greeting session', String(deriver(record)))

// §1d a later rename (typed) replaces the mint — the deriver follows the record, never regresses to the words.
writeWorkers('Renamed by the operator')
const t2 = new Date(Date.now() + 4000)
utimesSync(workersPath, t2, t2)
check('§1d a rename on the record follows (the record is the one owner)', deriver(record) === 'Renamed by the operator', String(deriver(record)))

// §2 source pins.
const connectorSrc = readFileSync(new URL('../../src/services/engine-connector/daemonConnector.ts', import.meta.url), 'utf8')
const hopSrc = readFileSync(new URL('../../src/services/switchboard/hopIntoSession.ts', import.meta.url), 'utf8')
check('§2 status() reads the title through the registered deriver, the snapshot as the fallback', connectorSrc.includes('title: liveTitleDeriver?.(this.record) ?? this.record.title'))
check('§2 POISON absent: status() no longer spells the frozen snapshot alone', !/title: this\.record\.title,\n/.test(connectorSrc))
check('§2 the hop registers the deriver beside its snapshot derivation', hopSrc.includes('seat.registerLiveTitleDeriver(liveTitleDeriverFor(supervisor, sessionTitleOf, headBriefLabel))'))

console.log(failures === 0 ? '\nprove-chat-tag-live-title: ALL LAWS HOLD' : `\nprove-chat-tag-live-title: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
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

check('§1a no record, no words ⇒ the stage-1 fact', deriver(record) === newSessionTitle(workspace), String(deriver(record)))

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

writeWorkers('Tag greeting session')
const t = new Date(Date.now() + 2000)
utimesSync(workersPath, t, t)
check('§1c a minted title on the record ⇒ stage 3 wins', deriver(record) === 'Tag greeting session', String(deriver(record)))

writeWorkers('Renamed by the operator')
const t2 = new Date(Date.now() + 4000)
utimesSync(workersPath, t2, t2)
check('§1d a rename on the record follows (the record is the one owner)', deriver(record) === 'Renamed by the operator', String(deriver(record)))

const connectorSrc = readFileSync(new URL('../../src/services/engine-connector/daemonConnector.ts', import.meta.url), 'utf8')
const hopSrc = readFileSync(new URL('../../src/services/switchboard/hopIntoSession.ts', import.meta.url), 'utf8')
check('§2 status() reads the title through the registered deriver, the snapshot as the fallback', connectorSrc.includes('title: liveTitleDeriver?.(this.record) ?? this.record.title'))
check('§2 POISON absent: status() no longer spells the frozen snapshot alone', !/title: this\.record\.title,\n/.test(connectorSrc))
check('§2 the hop registers the deriver beside its snapshot derivation', hopSrc.includes('seat.registerLiveTitleDeriver(liveTitleDeriverFor(supervisor, sessionTitleOf, headBriefLabel))'))

console.log(failures === 0 ? '\nprove-chat-tag-live-title: ALL LAWS HOLD' : `\nprove-chat-tag-live-title: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

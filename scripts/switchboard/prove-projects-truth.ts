#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'projects-truth-'))
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = label.startsWith('T2 ')
    ? 'fix getFocusedSessionConnector/emitFocusedSessionConnectorChanged in src/engine/connector/focusedConnector.ts or bootBirthFacts in src/daemon/switchboard/bootBirthFacts.ts'
    : label.startsWith('T4 ')
      ? 'fix projectDisplayName in src/screen/boot-face/bootCardFacts.ts'
      : label.startsWith('T7 ')
        ? 'fix the workspace focusResumedSession resolves from a folded transcript in src/daemon/switchboard/hopIntoSession.ts'
        : label.startsWith('T6 T') || label.startsWith('T6 an invalid')
          ? 'fix the session scan (scanBootCardFacts, projectIdentity, parkedSessionsOf, projectChatCount) in src/screen/boot-face/bootCardFacts.ts, or the id check in focusResumedSession in src/daemon/switchboard/hopIntoSession.ts'
          : 'fix the session scan (workedInProjects, scanBootCardFacts, isAuthFailureHusk) in src/screen/boot-face/bootCardFacts.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${where}` : ''}`)
}

{
  const state = await import('../../src/boot/process-state/processState.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const facts = await import('../../src/daemon/switchboard/bootBirthFacts.ts')
  facts.setBootBirthFacts({ title: 'boot title', permissionMode: 'sovereign' as never })
  state.setCwdState('/scratch/alpha')
  const before = slot.getFocusedSessionConnector().workspace()
  let pulses = 0
  const off = slot.subscribeFocusedSessionConnector(() => pulses++)
  state.setCwdState('/scratch/beta')
  slot.emitFocusedSessionConnectorChanged()
  const after = slot.getFocusedSessionConnector().workspace()
  check('T2 the resting slot follows the ground (a new workspace snapshot, the slot pulsed)', !slot.hasFocusedSession() && before.cwd === '/scratch/alpha' && after.cwd === '/scratch/beta' && after !== before && pulses === 1)
  check('T2 the same ground is a stable snapshot', slot.getFocusedSessionConnector().workspace() === after)
  check('T2 the boot facts ride untouched by the ground move', facts.bootBirthFacts().title === 'boot title' && facts.bootBirthFacts().permissionMode === ('sovereign' as never))
  off()
  facts._resetBootBirthFactsForTesting()
}

{
  const { projectDisplayName } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  check('T4 a .mercury project row wears its parent name', projectDisplayName('/x/gamma/.mercury') === 'gamma')
  check('T4 an ordinary row keeps its own name', projectDisplayName('/x/repo-beta') === 'repo-beta')
  check('T4 a rootward .mercury falls back honestly', projectDisplayName('/.mercury') === '.mercury')
}

{
  const { mkdirSync, utimesSync, writeFileSync, existsSync } = await import('node:fs')
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
  const { workedInProjects, scanBootCardFacts } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const home = process.env.MERCURY_CONFIG_DIR!
  const projReal = join(home, 'repo-real')
  const projGhost = join(home, 'repo-ghost')
  mkdirSync(projReal, { recursive: true })
  mkdirSync(projGhost, { recursive: true })
  const row = (cwd: string, sid: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd,
    sessionId: sid,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date().toISOString(),
    ...extra,
  })
  const huskRows = (cwd: string, sid: string): Record<string, unknown>[] => [
    row(cwd, sid, { type: 'user', message: { role: 'user', content: 'hello?' } }),
    row(cwd, sid, {
      type: 'assistant',
      error: 'authentication_failed',
      isApiErrorMessage: true,
      message: { id: 'msg_husk', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'OAuth token has expired.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
  ]
  const realRows = (cwd: string, sid: string): Record<string, unknown>[] => [
    row(cwd, sid, { type: 'user', message: { role: 'user', content: 'a real ask' } }),
    row(cwd, sid, {
      type: 'assistant',
      message: { id: 'msg_real', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a real reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ]
  const SID_REAL = '00000000-aaaa-4000-8000-00000000aea1'
  const SID_HUSK = '00000000-aaaa-4000-8000-00000000dead'
  const SID_ONLY = '00000000-aaaa-4000-8000-00000000dea2'
  const dirReal = join(home, 'projects', basename(getProjectDir(projReal)))
  const dirGhost = join(home, 'projects', basename(getProjectDir(projGhost)))
  mkdirSync(dirReal, { recursive: true })
  mkdirSync(dirGhost, { recursive: true })
  const old = new Date(Date.now() - 3_600_000)
  const fReal = join(dirReal, `${SID_REAL}.jsonl`)
  writeFileSync(fReal, encodeSeedTranscript(realRows(projReal, SID_REAL) as never, SID_REAL))
  utimesSync(fReal, old, old)
  const fHusk = join(dirReal, `${SID_HUSK}.jsonl`)
  writeFileSync(fHusk, encodeSeedTranscript(huskRows(projReal, SID_HUSK) as never, SID_HUSK))
  writeFileSync(join(dirGhost, `${SID_ONLY}.jsonl`), encodeSeedTranscript(huskRows(projGhost, SID_ONLY) as never, SID_ONLY))
  const seen = workedInProjects()
  const real = seen.find(p => p.dir === projReal)
  check('T5 the husk is walked past — the project resolves via its REAL newest session', real !== undefined && real.sessionId === SID_REAL, String(real?.sessionId))
  check('T5 the poison row is gone (the husk was today\'s resolution)', real?.sessionId !== SID_HUSK)
  check('T5 a husks-only folder is not a worked-in project', !seen.some(p => p.dir === projGhost))
  check('T5 the husk FILE stays on disk (forensics — only the scan skips it)', existsSync(fHusk))
  const facts = scanBootCardFacts(projReal)
  check('T5 the Continue form rides the same truth (cwdProject = the real session)', facts.cwdProject?.sessionId === SID_REAL)
}

{
  const { mkdirSync, utimesSync, writeFileSync, rmSync } = await import('node:fs')
  const { mock } = await import('bun:test')
  const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
  const { scanBootCardFacts, parkedSessionsOf, projectChatCount, projectIdentity, PROJECT_CARD_FILE } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const project = join(process.env.MERCURY_CONFIG_DIR!, 'repo-receipts')
  mkdirSync(project)
  const store = getProjectDir(project)
  mkdirSync(store, { recursive: true })
  const sessionId = '00000000-aaaa-4000-8000-000000000015'
  const transcript = join(store, `${sessionId}.jsonl`)
  const sidecar = join(store, `${sessionId}.receipts.jsonl`)
  writeFileSync(join(store, PROJECT_CARD_FILE), JSON.stringify({ schema: 1, dir: project, firstChatAt: Date.now(), firstSessionId: sessionId }))
  writeFileSync(transcript, JSON.stringify({ cwd: project, kind: 'input', sessionId }) + '\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(transcript, old, old)
  writeFileSync(sidecar, JSON.stringify({ kind: 'receipt', id: 'receipt-1' }) + '\n')
  check('T6 Continue chooses the transcript, never its newer receipts sidecar', scanBootCardFacts(project).cwdProject?.sessionId === sessionId)
  check('T6 the project identity chooses the same transcript', projectIdentity(project).newestChat?.transcriptPath === transcript)
  check('T6 the parked list contains exactly one session', JSON.stringify(parkedSessionsOf(project).map(row => row.sessionId)) === JSON.stringify([sessionId]))
  check('T6 the chat count excludes the sidecar', projectChatCount(project) === 1)
  check('T6 excluding the session does not offer its sidecar', scanBootCardFacts(project, sessionId).cwdProject === null && parkedSessionsOf(project, { excludeSessionId: sessionId }).length === 0 && projectChatCount(project, { excludeSessionId: sessionId }) === 0)
  rmSync(transcript)
  check('T6 a sidecar alone offers no Continue session', scanBootCardFacts(project).cwdProject === null && projectIdentity(project).newestChat === null && parkedSessionsOf(project).length === 0 && projectChatCount(project) === 0)
  const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const realWorkers = { ...workers }
  let lookups = 0
  mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({ ...realWorkers, sessionOwnedByLiveWorker: () => { lookups++; throw new Error('invalid resume reached the worker registry') } }))
  const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.ts')
  for (const id of [`${sessionId}.receipts`, 'not-a-session', '']) {
    try {
      const resumed = await focusResumedSession(id, sidecar)
      check('T6 an invalid resume id refuses before admission with the existing unknown-session words', !resumed.ok && resumed.reason === 'no live session record owns this id' && await resumed.admitted === false && await resumed.refusal === 'no live session record owns this id')
    } catch (error) {
      check('T6 an invalid resume id refuses before admission', false, String(error))
    }
  }
  check('T6 an invalid resume never consults or launches a runner', lookups === 0)
  mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => realWorkers)
  mock.restore()
}

{
  const { mock } = await import('bun:test')
  const { mkdirSync, readFileSync, realpathSync } = await import('node:fs')
  const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
  const { historyHead } = await import('../../src/sessions/transcripts/historyParts.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
  const state = await import('../../src/boot/process-state/processState.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const seat = await import('../../src/engine/connector/daemonConnector.ts')
  const ensure = await import('../../src/daemon/switchboard/ensureDaemon.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'projects-truth-folded-')))
  const sessionFolder = join(root, 'folded-target-project')
  const processFolder = join(root, 'other-process-folder')
  mkdirSync(sessionFolder, { recursive: true })
  mkdirSync(processFolder, { recursive: true })
  state.setCwdState(processFolder)
  const store = getProjectDir(sessionFolder)
  mkdirSync(store, { recursive: true })
  const foldedSid = '77777777-2222-4333-8444-555555555555'
  const foldedFile = join(store, `${foldedSid}.jsonl`)
  const queue = new QueuePart()
  const land = async (entry: Record<string, unknown>): Promise<void> => {
    const done = queue.enqueueWrite(foldedFile, entry as never)
    await queue.flush()
    await done
  }
  const ts = new Date().toISOString()
  await land({ type: 'user', uuid: 'h-u1', parentUuid: null, sessionId: foldedSid, cwd: sessionFolder, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'opening prompt in target folder' } })
  await land({ type: 'assistant', uuid: 'h-a1', parentUuid: 'h-u1', sessionId: foldedSid, cwd: sessionFolder, timestamp: ts, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } })
  for (let i = 0; i < 6; i++) {
    await land({ type: 'file-history-snapshot', messageId: `snap-${i}`, snapshot: { messageId: `snap-${i}`, trackedFileBackups: { [`file-${i}.ts`]: { backupFileName: `b-${i}`, version: 1, backupTime: ts, pad: 'x'.repeat(2000) } }, timestamp: ts }, isSnapshotUpdate: false })
  }
  await land({ type: 'system', subtype: 'compact_boundary', uuid: 'h-cb1', parentUuid: null, sessionId: foldedSid, timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10000, preservedSegment: { headUuid: 'h-u1', tailUuid: 'h-a1', anchorUuid: 'h-cb1' } } })
  await land({ type: 'user', uuid: 'h-u2', parentUuid: 'h-cb1', sessionId: foldedSid, cwd: sessionFolder, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'second stretch prompt' } })
  await land({ type: 'system', subtype: 'compact_boundary', uuid: 'h-cb2', parentUuid: null, sessionId: foldedSid, timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 12000, preservedSegment: { headUuid: 'h-u2', tailUuid: 'h-u2', anchorUuid: 'h-cb2' } } })
  const sealed = historyHead(foldedFile)
  const rawHead8k = readFileSync(foldedFile, 'utf8').slice(0, 8192)
  check('T7 fixture: folded twice and carried snapshots push cwd past the first 8 KB of the live head', sealed.before > 0 && !/"cwd"\s*:/.test(rawHead8k), JSON.stringify({ before: sealed.before, firstCwdAt: readFileSync(foldedFile, 'utf8').indexOf('"cwd"') }))
  let capturedWorkspace = ''
  const realEnsure = { ...ensure }
  const realSeat = { ...seat }
  mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({ ...realEnsure, ensureOwnedDaemon: async () => false }))
  mock.module('../../src/engine/connector/daemonConnector.ts', () => ({
    ...realSeat,
    daemonSessionConnectorFor: (spec: { workspaceId: string }) => {
      capturedWorkspace = spec.workspaceId
      return realSeat.daemonSessionConnectorFor(spec as never)
    },
  }))
  const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.ts')
  const resumed = await focusResumedSession(foldedSid, foldedFile)
  await resumed.refusal
  slot.releaseFocusedSessionConnector()
  mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => realEnsure)
  mock.module('../../src/engine/connector/daemonConnector.ts', () => realSeat)
  mock.restore()
  check('T7 hopping into a folded session lands in the session folder, not the process folder', resumed.ok && capturedWorkspace === sessionFolder && resumed.title === 'opening prompt in target folder', JSON.stringify({ ok: resumed.ok, title: resumed.ok ? resumed.title : resumed.reason, capturedWorkspace, sessionFolder, processFolder }))
}

{
  const { mkdirSync, realpathSync, statSync } = await import('node:fs')
  const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
  const { historyHead } = await import('../../src/sessions/transcripts/historyParts.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
  const { isAuthFailureHusk, scanBootCardFacts } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'projects-truth-husk-')))
  const projFolded = join(root, 'folded-auth-fail')
  mkdirSync(projFolded, { recursive: true })
  const store = getProjectDir(projFolded)
  mkdirSync(store, { recursive: true })
  const foldedAuthSid = '88888888-2222-4333-8444-555555555555'
  const foldedAuthFile = join(store, `${foldedAuthSid}.jsonl`)
  const queue = new QueuePart()
  const land = async (entry: Record<string, unknown>): Promise<void> => {
    const done = queue.enqueueWrite(foldedAuthFile, entry as never)
    await queue.flush()
    await done
  }
  const ts = new Date().toISOString()
  await land({ type: 'user', uuid: 'ha-u1', parentUuid: null, sessionId: foldedAuthSid, cwd: projFolded, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'real work before fold' } })
  await land({ type: 'assistant', uuid: 'ha-a1', parentUuid: 'ha-u1', sessionId: foldedAuthSid, cwd: projFolded, timestamp: ts, isSidechain: false, message: { id: 'msg_before', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'real answer before fold' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } })
  await land({ type: 'system', subtype: 'compact_boundary', uuid: 'ha-cb1', parentUuid: null, sessionId: foldedAuthSid, timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10000 } })
  await land({ type: 'user', uuid: 'ha-u2', parentUuid: 'ha-cb1', sessionId: foldedAuthSid, cwd: projFolded, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'follow-up after token expiry' } })
  await land({ type: 'assistant', uuid: 'ha-a2', parentUuid: 'ha-u2', sessionId: foldedAuthSid, cwd: projFolded, timestamp: ts, isSidechain: false, error: 'authentication_failed', isApiErrorMessage: true, message: { id: 'msg_after_auth', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'OAuth token has expired.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  const sealed = historyHead(foldedAuthFile)
  const liveSize = statSync(foldedAuthFile).size
  const husk = isAuthFailureHusk(foldedAuthFile, liveSize)
  const facts = scanBootCardFacts(projFolded)
  check('T8 a folded session whose live head ends in authentication_failed is never hidden as a husk', sealed.before > 0 && liveSize <= 64 * 1024 && !husk && facts.cwdProject?.sessionId === foldedAuthSid, JSON.stringify({ before: sealed.before, liveSize, husk, cwdSession: facts.cwdProject?.sessionId }))
}

if (failures > 0) {
  console.log(`\nprove-projects-truth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-projects-truth: ALL LAWS HOLD')

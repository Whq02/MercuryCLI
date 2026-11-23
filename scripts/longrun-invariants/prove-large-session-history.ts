#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, REPO, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'
import { referenceFixtureSnapshot } from '../notifications/concourseReferenceSeed.ts'
import { entryToRecord } from '../../src/sessions/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/sessions/fabric/ordinal.ts'
import type { Entry } from '../../src/sessions/transcripts/transcriptEntries.ts'

const tally = makeTally('prove-large-session-history')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'long-history-')))
const cwd = join(home, 'work')
const sessionId = randomUUID()
const savedReply = 'A reply saved in the long history.'
const firstAsk = 'Confirm the saved turn.'
const finalAsk = 'Answer on the same runner.'
const sleepAsk = 'Hold this tool.'
seedScratchHome(home, cwd)
process.env.MERCURY_CONFIG_DIR = home
const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { emptyFoldState, applyTranscriptEntry } = await import('../../src/sessions/transcripts/fold.ts')
const { writeResumeSnapshot } = await import('../../src/sessions/transcripts/resumeSnapshot.ts')

function generateHistory(): void {
  const project = getProjectDir(cwd)
  mkdirSync(project, { recursive: true })
  const path = join(project, `${sessionId}.jsonl`)
  const fold = emptyFoldState()
  const timestamp = new Date().toISOString()
  let ordinal = 0
  let size = 0
  const ctx = { sessionId: sessionId as never, nextOrdinal: () => ordinalOf(++ordinal), observedAt: timestamp, source: { channel: 'interactive' } as const }
  function append(entry: Record<string, unknown>): void {
    const bytes = Buffer.from(`${JSON.stringify(entryToRecord(entry, ctx))}\n`)
    appendFileSync(path, bytes)
    size += bytes.length
    applyTranscriptEntry(fold, entry as Entry)
  }
  const user = randomUUID()
  const common = { sessionId, timestamp, cwd, isSidechain: false, version: '1.0.11' }
  append({ ...common, uuid: user, parentUuid: null, type: 'user', message: { role: 'user', content: 'The saved question.' } })
  const snapshot = (contentHash: string) => ({ type: 'attribution-snapshot', messageId: user, surface: 'cli', fileStates: { 'proof.ts': { contentHash, mercuryContribution: 1, mtime: 0 } }, promptCount: 1, promptCountAtLastCommit: 0, permissionPromptCount: 0, permissionPromptCountAtLastCommit: 0, escapeCount: 0, escapeCountAtLastCommit: 0 })
  for (let i = 0; size < 560_000_000; i++) append(snapshot('x'.repeat(i < 12 ? 9_000_000 : 55_000)))
  append(snapshot('last'))
  append({ ...common, uuid: randomUUID(), parentUuid: user, type: 'assistant', message: { id: 'msg_saved', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: savedReply }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 8 } } })
  append({ sessionId, type: 'model', model: MODEL })
  append({ sessionId, type: 'custom-title', customTitle: 'History proof' })
  writeResumeSnapshot(path, fold, size)
  tally.check('the generated history is over the string limit and has a resume snapshot', statSync(path).size === size && size >= 560_000_000 && existsSync(`${path}.resume-snapshot.json`))
  console.log(`history: ${size} bytes · ${ordinal} records`)
}

function openWindow(env: NodeJS.ProcessEnv): void {
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') throw new Error(`${driver.reason}: ${driver.remedy}`)
  const fixture = referenceFixtureSnapshot()
  const row = { sessionId, workspaceDir: cwd, title: 'History proof', state: 'ready-to-review', projectLabel: 'History', ownerLabel: null, ageLabel: null, seats: null }
  Object.assign(fixture, { needsYou: [], groups: [{ id: 'ready-to-review', label: 'READY TO REVIEW', rows: [row] }] })
  const snapshot = join(home, 'concourse-fixture.json')
  writeFileSync(snapshot, JSON.stringify(fixture))
  const file = join(home, 'frame.json')
  const config = join(home, 'capture.json')
  writeFileSync(config, JSON.stringify({ argv: [NODE, DIST], cwd, cols: 156, rows: 36, sends: [{ atTick: 80, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, data: '\x1b[1;2C' }], readyText: savedReply, total: 120, out: file }))
  const got = spawnSync(driver.python, [captureEngineEntry(driver, REPO), config], { encoding: 'utf8', env: { ...env, MERCURY_CONCOURSE_FIXTURE: snapshot }, timeout: vshotBudgetMs(60_000) })
  const grid: Array<Array<{ c: string }>> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).grid : []
  const text = grid.map(r => r.map(c => c.c).join('')).join('\n')
  tally.check('sessions window shows the saved reply without a transcript error', got.status === 0 && text.includes(savedReply) && !text.includes('Could not read transcript'), `${text.split('\n').filter(l => /transcript|SESSIONS|History proof|no chat yet|Boot Menu/.test(l)).join(' | ').slice(0, 560)} ${String(got.stderr).slice(-250)}`)
}

try {
  generateHistory()
  const api = await startScriptedFixture(req => req.ask === sleepAsk && req.step === 0 ? [{ type: 'tool_use', name: 'Sleep', input: { seconds: 60 } }] : [{ type: 'text', text: req.ask === firstAsk ? 'The saved turn is here.' : 'The runner is still here.' }])
  try {
    const env = { ...childEnv(home, Number(new URL(api.base).port)), HOME: home, MERCURY_RESUME_SNAPSHOT: '1' }
    openWindow(env)
    const runner = hostRunner({ node: NODE, dist: DIST, cwd, home, env, argv: ['--resume', sessionId, '--model', MODEL, '--mode', 'sovereign', '--sovereign'] })
    try {
      await runner.initialize()
      await runner.prompt(firstAsk)
      await runner.waitFor('saved turn answered', f => f.type === 'outcome' && f.answer === 'The saved turn is here.')
      tally.check('the resumed model saw the saved turn', api.requests.some(req => req.ask === firstAsk && req.opening === 'The saved question.'))
      await runner.prompt(sleepAsk)
      await runner.waitFor('tool live', f => f.type === 'tool_call' && f.tool === 'Sleep')
      await runner.request('turn/interrupt', {})
      const interrupted = await runner.waitFor('turn interrupted', f => f.type === 'outcome' && f.status === 'interrupted')
      await runner.prompt(finalAsk)
      const after = await runner.waitFor('answered after interrupt', f => f.type === 'outcome' && Number(f.turn) > Number(interrupted.turn) && f.answer === 'The runner is still here.')
      tally.check('same runner and session answer after interrupt', after.session_id === sessionId && runner.child.exitCode === null && api.requests.some(req => req.allTexts.some(t => t.includes(finalAsk))), JSON.stringify({ turn: after.turn, session: after.session_id, requests: api.requests.map(r => [r.ask, r.step, r.allTexts.slice(-4).map(t => t.slice(0, 90))]) }))
      tally.check('runner reports no transcript read error', !runner.stderr().includes('Could not read transcript') && !JSON.stringify(runner.rows).includes('Could not read transcript'))
    } finally {
      tally.check('normal runner shutdown', await runner.stop() === 0)
    }
  } finally {
    await api.close()
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
tally.finish()

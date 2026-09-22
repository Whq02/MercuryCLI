#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'rewind-damaged-blob-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'rewind-damaged-blob-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
process.chdir(cwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(true)
bootstrap.setOriginalCwd(cwd)
const fh = await import('../../src/utils/fileHistory.ts')
type FileHistoryState = import('../../src/utils/fileHistory.ts').FileHistoryState
type FileHistorySnapshot = import('../../src/utils/fileHistory.ts').FileHistorySnapshot
type UUID = import('node:crypto').UUID

const uuid = (): UUID => randomUUID() as UUID
const still = (path: string, secondsAgo: number): void => {
  const t = (Date.now() - secondsAgo * 1000) / 1000
  utimesSync(path, t, t)
}
const blobDir = (sessionId: string): string => join(home, 'file-history', sessionId)
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p] }) : [])

const original = 'the original line\n'.repeat(200)
const edited = 'an edited line\n'.repeat(200)
check('checkpointing is on in this proof', fh.fileHistoryEnabled() === true)

async function checkpointed(name: string, secondsStill: number): Promise<{ state: FileHistoryState; file: string; m1: UUID; blob: string; recorded: number | undefined }> {
  let state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  const updateState = (fn: (prev: FileHistoryState) => FileHistoryState): void => {
    state = fn(state)
  }
  const file = join(cwd, name)
  writeFileSync(file, original)
  if (secondsStill > 0) still(file, secondsStill)
  const m1 = uuid()
  await fh.fileHistoryMakeSnapshot(updateState, m1)
  await fh.fileHistoryTrackEdit(updateState, file, m1)
  writeFileSync(file, edited)
  await fh.fileHistoryMakeSnapshot(updateState, uuid())
  const backup = state.snapshots[0]!.trackedFileBackups[name]!
  const blob = join(blobDir(String(bootstrap.getSessionId())), backup.backupFileName!)
  return { state, file, m1, blob, recorded: backup.sourceSize }
}

console.log('[1] a checkpoint blob shorter than its recorded source size is refused, the file untouched')
{
  const { state, file, m1, blob, recorded } = await checkpointed('notes.txt', 10)
  const whole = readFileSync(blob)
  check('the record carries the source size and the blob holds the original bytes', recorded === original.length && whole.equals(Buffer.from(original)), `recorded ${recorded} · blob ${whole.length}`)
  writeFileSync(blob, whole.subarray(0, 100))
  console.log(`  recorded source size ${recorded ?? 'none'} · blob size after the damage ${statSync(blob).size}`)
  const outcome = await fh.fileHistoryRestore(state, m1, { dryRun: false, ownerKey: 'rewind-damaged-blob' })
  console.log(`  restore outcome: ${JSON.stringify(outcome).slice(0, 240)}`)
  check('the restore is refused', outcome.ok === false, JSON.stringify(outcome).slice(0, 200))
  check('the refusal is the missing-copy road, by name', outcome.ok === false && outcome.kind === 'backup-missing' && outcome.paths.includes('notes.txt'), JSON.stringify(outcome).slice(0, 200))
  const now = readFileSync(file)
  check('the file keeps its current bytes', now.equals(Buffer.from(edited)), `file is now ${now.length} bytes`)
  const dry = await fh.fileHistoryRestore(state, m1, { dryRun: true, ownerKey: 'rewind-damaged-blob' })
  check('a dry run refuses the same way', dry.ok === false && dry.kind === 'backup-missing')
}

console.log('[2] an intact blob still restores')
{
  const { state, file, m1 } = await checkpointed('intact.txt', 10)
  const outcome = await fh.fileHistoryRestore(state, m1, { dryRun: false, ownerKey: 'rewind-damaged-blob' })
  check('the restore lands', outcome.ok === true, JSON.stringify(outcome).slice(0, 200))
  check('the file holds the original bytes again', readFileSync(file).equals(Buffer.from(original)))
}

console.log('[3] a record without a size (a source edited inside the racy window) restores as before')
{
  const { state, file, m1, recorded } = await checkpointed('fresh.txt', 0)
  check('the record carries no size for a freshly written source', recorded === undefined, String(recorded))
  const outcome = await fh.fileHistoryRestore(state, m1, { dryRun: false, ownerKey: 'rewind-damaged-blob' })
  check('the restore lands on the bytes alone', outcome.ok === true && readFileSync(file).equals(Buffer.from(original)), JSON.stringify(outcome).slice(0, 200))
}

console.log('[4] the resume copy re-records only the snapshots whose blobs match their record')
{
  const previous = randomUUID()
  mkdirSync(blobDir(previous), { recursive: true })
  const goodName = 'aaaaaaaaaaaaaaaa@v1'
  const badName = 'bbbbbbbbbbbbbbbb@v1'
  writeFileSync(join(blobDir(previous), goodName), original)
  writeFileSync(join(blobDir(previous), badName), original.slice(0, 50))
  const goodSnapshot: FileHistorySnapshot = { messageId: uuid(), timestamp: new Date(), trackedFileBackups: { 'good.txt': { backupFileName: goodName, version: 1, backupTime: new Date(), sourceSize: original.length } } }
  const badSnapshot: FileHistorySnapshot = { messageId: uuid(), timestamp: new Date(), trackedFileBackups: { 'bad.txt': { backupFileName: badName, version: 1, backupTime: new Date(), sourceSize: original.length } } }
  const log = { fileHistorySnapshots: [goodSnapshot, badSnapshot], messages: [{ sessionId: previous }] }
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
  await recordTranscript([createUserMessage({ content: 'resume' })])
  await fh.copyFileHistoryForResume(log as never)
  await flushSessionStorage()
  const current = blobDir(String(bootstrap.getSessionId()))
  check('the intact blob is carried into the current session', existsSync(join(current, goodName)) && statSync(join(current, goodName)).size === original.length)
  const transcripts = walk(join(home, 'projects')).filter(p => p.endsWith('.jsonl')).map(p => readFileSync(p, 'utf8')).join('\n')
  check('the intact snapshot is re-recorded for this session', transcripts.includes(goodSnapshot.messageId))
  check('the snapshot whose blob is short is not re-recorded', !transcripts.includes(badSnapshot.messageId))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

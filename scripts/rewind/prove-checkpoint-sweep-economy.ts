#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sweep-economy-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'sweep-economy-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
process.chdir(cwd)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(true)
bootstrap.setOriginalCwd(cwd)
const fh = await import('../../src/utils/fileHistory.ts')
type FileHistoryState = import('../../src/utils/fileHistory.ts').FileHistoryState
type FileHistoryBackup = import('../../src/utils/fileHistory.ts').FileHistoryBackup
type UUID = import('node:crypto').UUID

let state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
const updateState = (fn: (prev: FileHistoryState) => FileHistoryState): void => {
  state = fn(state)
}
const uuid = (): UUID => randomUUID() as UUID
const census = fh.fileHistoryIoCensus
const reset = (): void => {
  census.stats = 0
  census.reads = 0
  census.copies = 0
}
const snap = (): { stats: number; reads: number; copies: number } => ({ ...census })
const latest = (): Record<string, FileHistoryBackup> => state.snapshots[state.snapshots.length - 1]!.trackedFileBackups
const turn = async (): Promise<{ stats: number; reads: number; copies: number }> => {
  reset()
  await fh.fileHistoryMakeSnapshot(updateState, uuid())
  return snap()
}
const hasFacts = (b: FileHistoryBackup): boolean =>
  typeof b.sourceSize === 'number' && typeof b.sourceMtimeMs === 'number' && typeof b.sourceMode === 'number'
const still = (path: string, secondsAgo: number): void => {
  const t = (Date.now() - secondsAgo * 1000) / 1000
  utimesSync(path, t, t)
}
const blobPath = (b: FileHistoryBackup): string => join(home, 'file-history', String(bootstrap.getSessionId()), b.backupFileName ?? '')
const blobMadeAgo = (key: string, secondsAgo: number): void => still(blobPath(latest()[key]!), secondsAgo)

const N = 6
const names = Array.from({ length: N }, (_, i) => `file-${i}.txt`)
const files = names.map(n => join(cwd, n))
for (const [i, f] of files.entries()) {
  writeFileSync(f, `content ${i}\n`.repeat(20))
  still(f, 10)
}

check('checkpointing is on in this proof (interactive posture, no config off-switch)', fh.fileHistoryEnabled() === true)

section('§0 the tracked set — turn 0, then N tracked edits')
{
  await fh.fileHistoryMakeSnapshot(updateState, uuid())
  reset()
  for (const f of files) await fh.fileHistoryTrackEdit(updateState, f, uuid())
  const t = snap()
  check(`tracking ${N} edits costs one source stat and one copy each`, t.stats === N && t.copies === N && t.reads === 0, JSON.stringify(t))
  check(`the latest snapshot holds ${N} version-1 backups under relative keys`, names.every(k => latest()[k]?.version === 1))
  check('each record carries the source facts (the files had been still for 10 s)', names.every(k => hasFacts(latest()[k]!)))
  for (const k of names) blobMadeAgo(k, 9)
}

section('§1 an unchanged turn — one stat per tracked file, nothing read')
{
  const t = await turn()
  check(`${N} tracked files, nothing changed: exactly ${N} stats (was ${2 * N}: source + backup side), 0 reads, 0 copies`, t.stats === N && t.reads === 0 && t.copies === 0, JSON.stringify(t))
  check('every record reused verbatim (version 1 throughout)', names.every(k => latest()[k]!.version === 1))
  console.log(`  BEFORE (by construction of the replaced sweep): ${2 * N} awaited stats per turn at ${N} tracked files · AFTER: ${t.stats}`)
}

section('§2 touched but identical — the full road once, then one stat again')
{
  for (const f of files) still(f, 5)
  const t = await turn()
  check(`the touch pays the full road ONCE: ${2 * N} stats + ${2 * N} reads, no copy (no byte moved)`, t.stats === 2 * N && t.reads === 2 * N && t.copies === 0, JSON.stringify(t))
  check('the records learned the new facts, version untouched', names.every(k => latest()[k]!.version === 1 && hasFacts(latest()[k]!)))
  const t2 = await turn()
  check(`the next turn is back to ${N} stats and 0 reads (was ${2 * N} stats + ${2 * N} reads on EVERY later turn)`, t2.stats === N && t2.reads === 0, JSON.stringify(t2))
  console.log(`  BEFORE: ${2 * N} stats + ${2 * N} whole-file reads per turn for the rest of the session after a touch · AFTER: that once, then ${t2.stats} stats + 0 reads`)
}

section('§3 a same-size real edit — detected; no facts inside the racy window; learned once still')
{
  const f = files[0]!
  const k = names[0]!
  writeFileSync(f, readFileSync(f, 'utf8').replace('content 0', 'CONTENT 0'))
  const t = await turn()
  const rec = latest()[k]!
  check('the edit took a new backup (version 2) — the facts mismatched, the bytes differed', rec.version === 2 && rec.backupFileName !== null, JSON.stringify(rec))
  check(`the cost: ${N} sweep stats + the edited file's backup-side stat and its two reads + the new backup's stat and copy`, t.stats === N + 2 && t.reads === 2 && t.copies === 1, JSON.stringify(t))
  check('a source modified inside the racy window carries NO facts (the byte-compare road keeps deciding)', !hasFacts(rec))
  check('the other files stayed on the one-stat road (version 1, facts kept)', names.slice(1).every(n => latest()[n]!.version === 1 && hasFacts(latest()[n]!)))
  still(f, 5)
  blobMadeAgo(k, 9)
  const t2 = await turn()
  check('once still, the full road runs once and the record learns the facts (version 2 kept)', latest()[k]!.version === 2 && hasFacts(latest()[k]!) && t2.stats === N + 1 && t2.reads === 2, JSON.stringify({ t2, rec: latest()[k] }))
  const t3 = await turn()
  check(`…and the turn after is ${N} stats again`, t3.stats === N && t3.reads === 0, JSON.stringify(t3))
}

section('§4 a mode-only change — detected (mode is part of the facts)')
{
  const f = files[1]!
  const k = names[1]!
  chmodSync(f, 0o600)
  const t = await turn()
  const rec = latest()[k]!
  check('a chmod with unchanged bytes and mtime still takes a new version (the old road compared modes too)', rec.version === 2, JSON.stringify(rec))
  check('no byte was read to decide it (the mode mismatch decides before the compare)', t.reads === 0 && t.copies === 1 && t.stats === N + 2, JSON.stringify(t))
  still(f, 5)
  blobMadeAgo(k, 9)
  await turn()
  check('the facts caught up after the file was still', hasFacts(latest()[k]!) && latest()[k]!.version === 2)
}

section('§5 persistence — the facts survive the snapshot round trip')
{
  const persisted = JSON.parse(JSON.stringify(state.snapshots)) as FileHistoryState['snapshots']
  const restored: { state: FileHistoryState | null } = { state: null }
  fh.fileHistoryRestoreStateFromLog(persisted, s => {
    restored.state = s
  })
  check('the restore rebuilt the state from the persisted rows', restored.state !== null && restored.state.snapshots.length === state.snapshots.length)
  if (restored.state !== null) state = restored.state
  const t = await turn()
  check(`a resumed session's first unchanged turn is ${N} stats, 0 reads (the facts rode the rows)`, t.stats === N && t.reads === 0, JSON.stringify(t))
  check('older persisted rows without facts stay valid (optional fields): a record stripped of them takes the full road, not an error', await (async () => {
    const k = names[3]!
    const cur = latest()[k]!
    updateState(prev => {
      const last = prev.snapshots[prev.snapshots.length - 1]!
      const stripped: FileHistoryBackup = { backupFileName: cur.backupFileName, version: cur.version, backupTime: cur.backupTime }
      return { ...prev, snapshots: [...prev.snapshots.slice(0, -1), { ...last, trackedFileBackups: { ...last.trackedFileBackups, [k]: stripped } }] }
    })
    const t2 = await turn()
    return t2.stats === N + 1 && latest()[k]!.version === cur.version && hasFacts(latest()[k]!)
  })())
}

console.log(failures === 0 ? '\n✅ ALL CHECKPOINT-SWEEP-ECONOMY PROOFS PASS' : `\n❌ ${failures} CHECKPOINT-SWEEP-ECONOMY PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

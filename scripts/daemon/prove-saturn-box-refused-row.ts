#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SaturnScheduleV1 } from '../../src/daemon/saturn.js'

for (const key of ['NODE_ENV', 'CI', 'MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_SATURN_DISABLE']) delete process.env[key]
const proofHome = mkdtempSync(join(tmpdir(), 'saturn-box-refused-'))
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
const dir = join(proofHome, 'daemon')
mkdirSync(dir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = dir

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { readBoxSchedules, saturnBoxSchedulesPath, removeBoxSchedule, setBoxSchedulePaused } = await import('../../src/daemon/saturnBoxSchedules.ts')
const { tickSaturnOnce } = await import('../../src/daemon/saturnTicker.ts')
const { ensureWorkerWorktree } = await import('../../src/daemon/concourseWorktrees.ts')
const { saturnStandingOf, saturnStandingWords } = await import('../../src/daemon/saturn.ts')
const { BootSaturnScreen } = await import('../../src/components/BootSaturnScreen.tsx')
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const React = (await import('react')).default

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const repo = join(proofHome, 'repo')
mkdirSync(repo)
writeFileSync(join(repo, 'base.txt'), 'base\n')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid', GIT_CONFIG_GLOBAL: join(proofHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { env: gitEnv, encoding: 'utf8' })
check('the fixture repository has no commits', git('init', '-q').status === 0 && git('rev-parse', '--verify', '--quiet', 'HEAD').status !== 0)

const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000
const account = { family: 'anthropic', source: 'oauth' as const }
const rowOf = (id: string, recurring = false): SaturnScheduleV1 => ({
  schema: 1, id,
  when: recurring ? { kind: 'every', cron: '* * * * *', spelling: 'every minute' } : { kind: 'at', atMs: now - 1_000 },
  action: { kind: 'birth', birth: { workspaceDir: repo, modelKey: 'claude-opus-5', presence: 'headless' } },
  account, modelKey: 'claude-opus-5', createdAt: now - 120_000, createdBy: 'operator:test', note: 'keep the original schedule facts',
})
const seed = (...schedules: SaturnScheduleV1[]): void => writeFileSync(saturnBoxSchedulesPath(dir), JSON.stringify({ version: 1, schedules, heldFires: [] }))
const oneShot = rowOf('a0e50001')
const recurring = rowOf('e7e70002', true)
seed(oneShot, recurring)
const births: Array<{ id: string; dueAt: number; ok: boolean; detail?: string }> = []
let refuse: string | undefined
let screenOpen = true
let credentialed = true
let stampBeforeBirth = true
let cancelDuringBirth = false
let replay = false
const ports = {
  now: () => now,
  records: () => [],
  deriveAccount: () => ({ ok: true as const, account }),
  liveFacts: () => ({ credentialed, stranded: false, expiresAt: null, refreshable: false }),
  deliver: async () => ({ ok: true }),
  birth: async (spec: { workspaceDir: string }, opts: { scheduleId: string; dueAt: number }) => {
    const file = readBoxSchedules(dir)
    const schedule = file.schedules.find(s => s.id === opts.scheduleId)
    stampBeforeBirth &&= (schedule === undefined || schedule.lastFiredAt === now) && (!replay || !file.heldFires.some(h => h.scheduleId === opts.scheduleId && h.dueAt === opts.dueAt))
    if (cancelDuringBirth) removeBoxSchedule(opts.scheduleId, dir)
    const carved = refuse === undefined ? await ensureWorkerWorktree(spec.workspaceDir, `saturn-${opts.scheduleId}`, dir) : null
    const outcome = carved === null ? { ok: false, detail: refuse! } : carved.ok ? { ok: true, sessionId: `born-${opts.scheduleId}` } : { ok: false, detail: carved.error }
    births.push({ id: opts.scheduleId, dueAt: opts.dueAt, ...outcome })
    return outcome
  },
  screenOpen: () => screenOpen,
  dir,
} as never
const board = (rows = 40) => renderToString(React.createElement(BootSaturnScreen, { nowMs: now, receiptsOf: () => [], fullScene: { columns: 160, rows } } as never), 160)
const words = (): string[] => {
  const file = readBoxSchedules(dir)
  return file.schedules.map(s => saturnStandingWords(saturnStandingOf(s, file.heldFires), now))
}

console.log('\nA refused first fires remain visible with the admission reason')
const first = await tickSaturnOnce(ports)
const held = readBoxSchedules(dir)
check('the real worktree admission refused both births', births.length === 2 && births.every(b => !b.ok && b.detail?.startsWith('no commits yet in ')), births)
check('the ticker banked one hold per refused fire', first.held === 2 && held.heldFires.length === 2, held)
check('both original schedule rows survive, stamped before admission', held.schedules.length === 2 && held.schedules.every(s => s.lastFiredAt === now && s.note === oneShot.note && s.createdBy === oneShot.createdBy), held.schedules)
const reason = births[0]!.detail!
check('the board wording is the existing refused shape and exact reason', words().length === 2 && words().every(w => w === `refused · ${reason}`), words())
const refusedFrame = await board()
console.log(refusedFrame)
check('the actual board frame contains the one-shot and recurring rows', refusedFrame.includes(oneShot.id) && refusedFrame.includes(recurring.id))
check('the actual board frame shows why the fire is refused', refusedFrame.includes('refused · no commits yet in'))
const detailFrame = await board(80)
console.log(detailFrame.split('\n').filter(line => /admission-refused|no commits yet|one base commit|unlocks forking/.test(line)).join('\n'))
check('the detail panel keeps the existing remedy readable when the row is clipped', detailFrame.includes('one base commit unlocks forking'))

console.log('\nB repeated refusal keeps one hold, original due time, and both rows')
replay = true
const retry = await tickSaturnOnce(ports)
const retried = readBoxSchedules(dir)
check('the next tick retries each refused fire once', births.length === 4 && retry.held === 2 && retry.replayed === 0, retry)
check('the bank and rows neither disappear nor duplicate', retried.heldFires.length === 2 && retried.schedules.length === 2, retried)
check('replay keeps the original due times', births.slice(2).every(b => b.dueAt === births.find(first => first.id === b.id)!.dueAt), births)
check('the refusal reason survives replay', words().length === 2 && words().every(w => w === `refused · ${reason}`), words())

console.log('\nC a base commit releases both fires exactly once')
check('the fixture gains one base commit', git('add', 'base.txt').status === 0 && git('commit', '-q', '-m', 'base').status === 0)
const release = await tickSaturnOnce(ports)
const released = readBoxSchedules(dir)
check('both held fires land after the cause clears', release.replayed === 2 && births.slice(4).length === 2 && births.slice(4).every(b => b.ok), { release, births })
check('the one-shot spends only after success and the recurring schedule remains', released.heldFires.length === 0 && released.schedules.length === 1 && released.schedules[0]!.id === recurring.id && released.schedules[0]!.lastFiredAt === now, released)
const noRepeat = await tickSaturnOnce(ports)
check('the next tick starts no duplicate session', noRepeat.fired + noRepeat.replayed === 0 && births.length === 6, noRepeat)

console.log('\nD another admission reason stays current; pause, resume and delete still work')
refuse = 'repo-held (fixture)'
replay = false
const cancellable = rowOf('ca11ce11')
seed(cancellable)
await tickSaturnOnce(ports)
check('an arbitrary returned refusal uses the same row shape', words()[0] === `refused · ${refuse}`, words())
refuse = 'admission refused (fixture)'
replay = true
await tickSaturnOnce(ports)
check('a later refusal replaces the old reason', words()[0] === `refused · ${refuse}`, words())
check('the held row can be paused', setBoxSchedulePaused(cancellable.id, true, dir) === 'applied')
const beforePause = births.length
await tickSaturnOnce(ports)
check('a paused held fire never starts', births.length === beforePause && readBoxSchedules(dir).heldFires.length === 1)
check('the board shows the existing paused state', words()[0] === 'paused · 1 held', words())
check('resume clears pause', setBoxSchedulePaused(cancellable.id, false, dir) === 'applied')
await tickSaturnOnce(ports)
check('resume retries the held fire', births.length === beforePause + 1)
check('deleting the visible row removes its hold too', removeBoxSchedule(cancellable.id, dir) === 'removed' && readBoxSchedules(dir).heldFires.length === 0)
refuse = undefined
const beforeDelete = births.length
await tickSaturnOnce(ports)
check('a deleted held fire never replays', births.length === beforeDelete && readBoxSchedules(dir).schedules.length === 0)

console.log('\nE screen-present holds wait while the screen is closed')
const visible = rowOf('face0001')
if (visible.action.kind === 'birth') visible.action.birth.presence = 'screen-present'
seed(visible)
refuse = 'repo-held (fixture)'
replay = false
await tickSaturnOnce(ports)
screenOpen = false
refuse = undefined
replay = true
const beforeClosed = births.length
await tickSaturnOnce(ports)
check('a screen-present refusal waits for the screen before replay', births.length === beforeClosed && readBoxSchedules(dir).heldFires.length === 1)
screenOpen = true
await tickSaturnOnce(ports)
await tickSaturnOnce(ports)
check('opening the screen releases once', births.length === beforeClosed + 1 && births.at(-1)?.ok === true && readBoxSchedules(dir).schedules.length === 0)

console.log('\nF cancellation during admission cannot resurrect the held fire')
seed(rowOf('de1e7e01'))
refuse = 'repo-held (fixture)'
cancelDuringBirth = true
replay = false
await tickSaturnOnce(ports)
cancelDuringBirth = false
refuse = undefined
const beforeCancelled = births.length
await tickSaturnOnce(ports)
check('a refused in-flight birth cannot re-bank a deleted schedule', births.length === beforeCancelled && readBoxSchedules(dir).heldFires.length === 0)

refuse = 'repo-held (fixture)'
seed(rowOf('de1e7e02'))
replay = false
await tickSaturnOnce(ports)
cancelDuringBirth = true
replay = true
await tickSaturnOnce(ports)
cancelDuringBirth = false
refuse = undefined
const beforeCancelledReplay = births.length
await tickSaturnOnce(ports)
check('a refused in-flight replay cannot re-bank a deleted schedule', births.length === beforeCancelledReplay && readBoxSchedules(dir).heldFires.length === 0)
writeFileSync(saturnBoxSchedulesPath(dir), JSON.stringify({ version: 1, schedules: [], heldFires: [held.heldFires[0]] }))
check('removal can clear a held fire even if its schedule row is already absent', removeBoxSchedule(oneShot.id, dir) === 'removed' && readBoxSchedules(dir).heldFires.length === 0)

console.log('\nG an account hold that reaches admission preserves the refusal reason and the stamp')
const accountHeld = rowOf('acc00001')
seed(accountHeld)
credentialed = false
replay = false
const beforeAccountHold = births.length
await tickSaturnOnce(ports)
check('sign-out holds the original row without starting a birth', births.length === beforeAccountHold && readBoxSchedules(dir).heldFires[0]?.reason === 'signed-out')
credentialed = true
refuse = 'repo-held (fixture)'
replay = true
await tickSaturnOnce(ports)
check('admission refusal after sign-in retains the row and reports its actual reason', readBoxSchedules(dir).heldFires[0]?.reason === 'admission-refused' && words()[0] === `refused · ${refuse}`, readBoxSchedules(dir))
refuse = undefined
await tickSaturnOnce(ports)
await tickSaturnOnce(ports)
check('the refused account-release birth eventually starts exactly once', births.length === beforeAccountHold + 2 && births.at(-1)?.ok === true && readBoxSchedules(dir).schedules.length === 0)

console.log('\nH an already stamped one-shot cannot fire after a restart')
seed({ ...rowOf('c2a50001'), lastFiredAt: now })
const beforeRestart = births.length
await tickSaturnOnce(ports)
check('a stamp without a hold is spent, never re-admitted', births.length === beforeRestart && readBoxSchedules(dir).schedules.length === 0)
check('every fresh fire stamps and every replay takes its hold before the birth effect', stampBeforeBirth)

console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

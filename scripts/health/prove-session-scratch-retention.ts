#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SELF = import.meta.path
const DAY = 86_400_000

if (process.argv.includes('--cycle')) {
  const lifecycle = await import('../../src/substrate/stateLifecycle.ts')
  let pass = await lifecycle.runLifecyclePass({ budgetMs: 60_000, maxRemovals: 1000 })
  for (let guard = 0; !pass.cycleComplete && guard < 10; guard++) pass = await lifecycle.runLifecyclePass({ budgetMs: 60_000, maxRemovals: 1000 })
  console.log(JSON.stringify({ complete: pass.cycleComplete, failures: pass.cycleFailures, scratch: pass.receipts.find(receipt => receipt.id === 'session-scratchpads') ?? null }))
  process.exit(0)
}
if (process.argv.includes('--health')) {
  const report = await import('../../src/utils/healthReport.ts')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(section => section.checks).find(check => check.id === 'session-scratch')
  let fixed: unknown = null
  if (process.argv.includes('--fix')) {
    const { runHeadlessFix } = await import('../../src/utils/healthFix.ts')
    fixed = await runHeadlessFix(cert, { only: 'session-scratch', yes: process.argv.includes('--yes') })
  }
  console.log(JSON.stringify({ row: row ? { status: row.status, label: row.label, evidence: row.evidence, fix: row.fix ?? null, plan: row.remedy?.plan ?? null, remedyClass: row.remedy?.class ?? null } : null, fixed }))
  process.exit(0)
}
if (process.argv.includes('--resume')) {
  const sessionId = process.argv[process.argv.indexOf('--resume') + 1]!
  const { switchSession } = await import('../../src/bootstrap/state.ts')
  switchSession(sessionId as never)
  const prompts = await import('../../src/constants/prompts.ts')
  const scratchpad = await import('../../src/utils/scratchpad.ts')
  const { getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
  const block = await prompts.computeSimpleEnvInfo('claude-opus-5')
  const dir = getScratchpadDir()
  const record = scratchpad.scratchpadOwnerRecord(dir)
  console.log(JSON.stringify({ pid: process.pid, dir, standing: block.includes(scratchpad.scratchpadPromptLine(dir)), lines: block.split('\n').filter(line => line.includes('cratchpad')), entries: existsSync(dir) ? readdirSync(dir) : null, owner: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null }))
  process.exit(0)
}

const work = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-retention-')))
const temp = join(work, 'temp')
const home = join(work, 'home')
const daemon = join(work, 'daemon')
const outside = join(work, 'outside')
for (const dir of [temp, home, daemon, outside]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_TMPDIR = temp
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemon
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER

const scratchpad = await import('../../src/utils/scratchpad.ts')
const retention = await import('../../src/utils/scratchpadRetention.ts')
const { getMercuryTempDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getMercuryHome } = await import('../../src/utils/envUtils.ts')
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const ROOT = getMercuryTempDir()
const HOME = getMercuryHome()
const OWNERS = scratchpad.scratchpadOwnersDir()
const GONE_PID = spawnSync(process.execPath, ['-e', '0']).pid
const LIVE_START = (await getProcessStartTokenAsync(process.pid)) ?? ''
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_TMPDIR: temp, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemon, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
  delete env.MERCURY_HOME
  delete env.MERCURY_CONCOURSE_WORKER
  return env
}
const child = (args: string[], cwd: string = work): Record<string, any> => {
  const ran = spawnSync(process.execPath, [SELF, ...args], { cwd, env: childEnv(), encoding: 'utf8', timeout: 180_000 })
  const line = ran.stdout.split('\n').filter(text => text.startsWith('{')).at(-1)
  if (line === undefined) return { failed: `${ran.status} ${ran.stderr.slice(-400)}` }
  return JSON.parse(line) as Record<string, any>
}

type Owner = { pid: number; procStart?: string; home?: string } | 'none' | 'unreadable'
const planted = new Map<string, string>()
const workers: Record<string, Record<string, unknown>> = {}
function workspace(name: string): string {
  const dir = join(work, 'projects', name)
  mkdirSync(dir, { recursive: true })
  return dir
}
function backdate(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY)
  utimesSync(path, at, at)
}
function plant(name: string, owner: Owner, days: number, fill: (dir: string) => void = dir => writeFileSync(join(dir, 'notes.md'), `${name}\n`)): string {
  const dir = scratchpad.scratchpadDirFor(workspace(name), randomUUID())
  mkdirSync(dir, { recursive: true })
  fill(dir)
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name))
      if (entry.isSymbolicLink()) lutimesSync(join(folder, entry.name), new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY))
      else backdate(join(folder, entry.name), days)
    }
  }
  walk(dir)
  backdate(dir, days)
  if (owner === 'unreadable') {
    mkdirSync(OWNERS, { recursive: true })
    writeFileSync(scratchpad.scratchpadOwnerRecord(dir), '{"home":')
  } else if (owner !== 'none') {
    mkdirSync(OWNERS, { recursive: true })
    writeFileSync(scratchpad.scratchpadOwnerRecord(dir), JSON.stringify({ home: owner.home ?? HOME, dir, pid: owner.pid, ...(owner.procStart ? { procStart: owner.procStart } : {}) }))
  }
  planted.set(name, dir)
  return dir
}
function worker(name: string, pid: number, procStart: string, state: Record<string, unknown>, days: number): string {
  const dir = plant(name, 'none', days)
  const sessionId = dirname(dir).split('/').at(-1)!
  workers[`concourse-${name}`] = { schema: 1, runnerId: `concourse-${name}`, sessionId, workspaceId: join(work, 'projects', name), isolation: 'shared', modelKey: 'claude-opus-5-5', spawnedAt: Date.now() - days * DAY, lastLiveAt: Date.now() - days * DAY, pid, procStart, ...state }
  writeFileSync(join(daemon, 'concourse-workers.json'), JSON.stringify({ version: 1, workers }))
  return dir
}
const stands = (name: string): boolean => existsSync(join(planted.get(name)!, 'notes.md'))
const gone = (name: string): boolean => !existsSync(dirname(dirname(planted.get(name)!))) && !existsSync(scratchpad.scratchpadOwnerRecord(planted.get(name)!))
const names = (dirs: readonly string[]): string => [...planted].filter(([, dir]) => dirs.includes(dir)).map(([name]) => name).sort().join(' ')

console.log('============================================================')
console.log(' a closed session\'s scratchpad: who owns it, when it goes, what health says')
console.log('============================================================')

section('§1 a session records itself as the owner of its scratchpad, and takes the record with it')
{
  const dir = scratchpad.ensureScratchpadDir()
  const record = scratchpad.scratchpadOwnerRecord(dir)
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>
  check('the record stands under the temp root, outside every project folder, and names this config home, the scratchpad and this process', existsSync(record) && dirname(record) === OWNERS && OWNERS.startsWith(ROOT) && read().home === HOME && read().dir === dir && read().pid === process.pid, existsSync(record) ? JSON.stringify(read()) : 'no record')
  for (let tick = 0; tick < 50 && typeof read().procStart !== 'string'; tick++) await sleep(100)
  check("the record gains the process's start time, so a later process on the same pid is not taken for the owner", read().procStart === LIVE_START && LIVE_START !== '', JSON.stringify(read()))
  check('the session counts as running: its scratchpad is not idle', !(await retention.idleScratchpads()).includes(dir))
  scratchpad.sweepOwnScratchpad()
  check('the sweep takes the scratchpad, the record and the empty owners folder; the temp root stands empty', !existsSync(dir) && !existsSync(record) && !existsSync(OWNERS) && readdirSync(ROOT).length === 0, readdirSync(ROOT).join(' '))
}

section('§2 the census: a scratchpad is idle only when every recorded owner is proven gone')
plant('dead-old', { pid: GONE_PID }, 45)
plant('dead-young', { pid: GONE_PID }, 2)
plant('live-old', { pid: process.pid, procStart: LIVE_START }, 45)
plant('live-untimed-old', { pid: process.pid }, 45)
plant('reused-pid-old', { pid: process.pid, procStart: 'Mon Jan  1 00:00:00 2024' }, 45)
plant('other-home-old', { pid: GONE_PID, home: join(work, 'another-home') }, 45)
plant('unowned-old', 'none', 45)
plant('unreadable-young', 'unreadable', 2)
plant('unreadable-old', 'unreadable', 45)
plant('linked-old', { pid: GONE_PID }, 45, dir => {
  writeFileSync(join(dir, 'notes.md'), 'linked\n')
  writeFileSync(join(outside, 'kept.txt'), 'outside the temp root\n')
  mkdirSync(join(outside, 'kept-folder'))
  writeFileSync(join(outside, 'kept-folder', 'inner.txt'), 'outside the temp root\n')
  symlinkSync(join(outside, 'kept.txt'), join(dir, 'link-to-file'))
  symlinkSync(join(outside, 'kept-folder'), join(dir, 'link-to-folder'))
})
worker('parked-old', GONE_PID, 'Fri Nov  6 12:10:11 2026', { parkedAt: Date.now() - 45 * DAY, parkedBy: 'operator:1' }, 45)
worker('stopped-old', GONE_PID, 'Fri Nov  6 12:09:43 2026', { stoppedAt: Date.now() - 45 * DAY, stoppedBy: 'operator' }, 45)
worker('stopped-young', GONE_PID, 'Fri Nov  6 12:09:43 2026', { stoppedAt: Date.now() - 2 * DAY, stoppedBy: 'operator' }, 2)
worker('worker-live-old', process.pid, LIVE_START, {}, 45)
const resumedElsewhere = worker('parked-then-resumed-old', GONE_PID, 'Fri Nov  6 12:10:11 2026', { parkedAt: Date.now() - 45 * DAY }, 45)
writeFileSync(scratchpad.scratchpadOwnerRecord(resumedElsewhere), JSON.stringify({ home: HOME, dir: resumedElsewhere, pid: process.pid, procStart: LIVE_START }))
const strayDir = scratchpad.scratchpadDirFor(workspace('never-made'), randomUUID())
const strayRecord = scratchpad.scratchpadOwnerRecord(strayDir)
writeFileSync(strayRecord, JSON.stringify({ home: join(work, 'another-home'), dir: strayDir, pid: GONE_PID }))
const besideRoot = join(temp, 'victim', 'scratchpad')
const behindLink = join(outside, 'linked-project', 'sess-2', 'scratchpad')
for (const dir of [besideRoot, behindLink]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kept.txt'), 'outside the temp root\n')
  backdate(join(dir, 'kept.txt'), 45)
  backdate(dir, 45)
}
symlinkSync(join(outside, 'linked-project'), join(ROOT, 'linkproj'))
const dotted = `${ROOT}../victim/scratchpad`
const throughLink = join(ROOT, 'linkproj', 'sess-2', 'scratchpad')
for (const dir of [dotted, throughLink]) writeFileSync(scratchpad.scratchpadOwnerRecord(dir), JSON.stringify({ home: HOME, dir, pid: GONE_PID }))
const outsideStands = (): boolean => [besideRoot, behindLink].every(dir => existsSync(join(dir, 'kept.txt')) && readFileSync(join(dir, 'kept.txt'), 'utf8') === 'outside the temp root\n')
{
  const census = await retention.readScratchpadCensus()
  check('idle: a dead owner record, a parked and an operator-stopped worker record with a dead pid, and a pid that now belongs to a process born at another time', names(census.idle) === 'dead-old dead-young linked-old parked-old reused-pid-old stopped-old stopped-young', names(census.idle))
  check('not idle: a pid alive under its recorded start time, a live pid with no recorded start time, a live worker, a worker record parked while another process has since taken the session, another config home, no owner record, an unreadable one', !['live-old', 'live-untimed-old', 'worker-live-old', 'parked-then-resumed-old', 'other-home-old', 'unowned-old', 'unreadable-young', 'unreadable-old'].some(name => census.idle.includes(planted.get(name)!)))
  check('a record naming a path that leaves the temp root through .. or through a linked project folder names no scratchpad: neither is idle, for a dead owner 45 days gone', !scratchpad.isSessionScratchpad(dotted) && !scratchpad.isSessionScratchpad(throughLink) && !census.idle.includes(dotted) && !census.idle.includes(throughLink), JSON.stringify(census.idle.filter(dir => dir === dotted || dir === throughLink)))
  check('a record whose scratchpad no longer exists is named as stale, and reading the census removes nothing', census.staleOwnerRecords.length === 1 && census.staleOwnerRecords[0] === strayRecord && existsSync(strayRecord), JSON.stringify(census.staleOwnerRecords))
}

section('§3 the footprint is read without following a link and says when it was cut')
{
  const linked = await retention.scratchpadFootprint(planted.get('linked-old')!, 1000)
  check('a link inside a scratchpad is counted as the link, never as what it points to', linked.whole && linked.entries === 3 && linked.bytes < 400, JSON.stringify(linked))
  const many = plant('many-files', 'none', 0, dir => {
    for (let index = 0; index < 300; index++) writeFileSync(join(dir, `file-${index}.txt`), 'x'.repeat(10))
  })
  const cut = await retention.scratchpadFootprint(many, 100)
  const whole = await retention.scratchpadFootprint(many, 1000)
  check('a read cut by its entry budget says so and counts what it saw; an uncut read counts every byte', !cut.whole && cut.entries === 100 && whole.whole && whole.entries === 300 && whole.bytes === 3000, `${JSON.stringify(cut)} ${JSON.stringify(whole)}`)
  const swapped = scratchpad.scratchpadDirFor(workspace('swapped'), randomUUID())
  mkdirSync(dirname(swapped), { recursive: true })
  symlinkSync(join(outside, 'kept-folder'), swapped)
  const through = await retention.scratchpadFootprint(swapped, 1000)
  check('a scratchpad path that is itself a link is not read through', !through.whole && through.entries === 0 && through.bytes === 0, JSON.stringify(through))
  rmSync(dirname(dirname(many)), { recursive: true, force: true })
  rmSync(dirname(dirname(swapped)), { recursive: true, force: true })
  planted.delete('many-files')
}

section('§4 health states what the idle scratchpads hold, and reads without removing')
{
  const before = child(['--health'])
  check('the row counts the idle scratchpads and their bytes, and says when they go; under a gibibyte it is information, with no remedy', before.row?.status === 'info' && before.row.label === 'Session scratchpads' && /^7 sessions that are not running hold \d+ bytes of scratch · removed 30 days after their last write$/.test(before.row.evidence) && before.row.plan === null, JSON.stringify(before))
  console.log(`        ${before.row?.evidence}`)
  check('reading the row removed nothing: every scratchpad, every record and the stale record stand', [...planted.keys()].every(stands) && existsSync(strayRecord))
}

section('§5 the cycle: only a scratchpad proven idle and unwritten for the whole retention goes')
{
  const ran = child(['--cycle'])
  check('the cycle completed with no failure and the class reports what it visited, removed and retained', ran.complete === true && ran.failures === 0 && ran.scratch?.done === true && ran.scratch.visited === 7 && ran.scratch.removed === 5 && ran.scratch.retained === 2, JSON.stringify(ran))
  check('swept with their owner records and the folders that held only them: the dead session, the parked and the operator-stopped worker, the reused pid, the one with links inside', ['dead-old', 'parked-old', 'stopped-old', 'reused-pid-old', 'linked-old'].every(gone), ['dead-old', 'parked-old', 'stopped-old', 'reused-pid-old', 'linked-old'].filter(name => !gone(name)).join(' '))
  check('kept: written within the retention (a dead session, an operator-stopped worker)', stands('dead-young') && stands('stopped-young'))
  check('kept: an owner that cannot be proven gone — alive under its start time, alive with no start time recorded, a live worker, a session another process has taken', ['live-old', 'live-untimed-old', 'worker-live-old', 'parked-then-resumed-old'].every(stands))
  check('kept: another config home, no owner record, an unreadable owner record (young and old alike)', ['other-home-old', 'unowned-old', 'unreadable-young', 'unreadable-old'].every(stands))
  check('what the links pointed to outside the temp root stands whole', readFileSync(join(outside, 'kept.txt'), 'utf8') === 'outside the temp root\n' && readFileSync(join(outside, 'kept-folder', 'inner.txt'), 'utf8') === 'outside the temp root\n')
  check('the two folders outside the temp root that records pointed at stand whole after the cycle', outsideStands())
  check('the stale record went with the cycle; the temp root and the owners folder stand', !existsSync(strayRecord) && existsSync(ROOT) && existsSync(OWNERS))
  const again = child(['--cycle'])
  check('a second cycle removes nothing more', again.complete === true && again.scratch?.removed === 0 && again.scratch.visited === 2, JSON.stringify(again))
}

section('§6 the retention is the home\'s own setting, and an unreadable setting sweeps nothing')
{
  plant('ten-days-dead', { pid: GONE_PID }, 10)
  const byDefault = child(['--cycle'])
  check('ten days old under the default thirty: kept', byDefault.scratch?.removed === 0 && stands('ten-days-dead'), JSON.stringify(byDefault))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ records: { retentionDays: 'soon' } }))
  const unread = child(['--cycle'])
  check('records.retentionDays present but not readable: the class removes nothing', unread.scratch?.removed === 0 && unread.scratch.visited === 0 && stands('ten-days-dead') && stands('dead-young'), JSON.stringify(unread))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ records: { retentionDays: 7 } }))
  const sevenDays = child(['--cycle'])
  check('records.retentionDays 7: the ten-day-old scratchpad goes, the two-day-old ones stay', sevenDays.scratch?.removed === 1 && gone('ten-days-dead') && stands('dead-young') && stands('stopped-young'), JSON.stringify(sevenDays))
  rmSync(join(home, 'settings.json'))
}

section('§7 past a gibibyte the row warns and offers the removal; the removal needs the operator\'s yes and never takes a running session')
{
  plant('large-dead', { pid: GONE_PID }, 1, dir => {
    writeFileSync(join(dir, 'notes.md'), 'large\n')
    closeSync(openSync(join(dir, 'weights.bin'), 'w'))
    truncateSync(join(dir, 'weights.bin'), 1024 ** 3)
  })
  const warned = child(['--health', '--fix'])
  check('the row warns, names the bytes and the remedy', warned.row?.status === 'warn' && warned.row.evidence === '3 sessions that are not running hold 1GB of scratch · removed 30 days after their last write' && warned.row.plan === 'remove the scratchpads of 3 sessions that are not running (1GB); their chats stay resumable' && warned.row.remedyClass === 'destructive' && warned.row.fix === 'Remove them (the chats stay resumable, their scratch files are deleted): press f here, or run `mercury health --fix --only session-scratch --yes`.', JSON.stringify(warned.row))
  console.log(`        ${warned.row?.evidence}`)
  console.log(`        ${warned.row?.fix}`)
  check('without --yes the remedy is skipped and nothing is removed', warned.fixed?.fixes?.length === 0 && String(warned.fixed?.skipped?.[0]?.reason).includes('requires --yes') && stands('large-dead') && stands('dead-young'), JSON.stringify(warned.fixed))
  const fixed = child(['--health', '--fix', '--yes'])
  check('with --yes the three idle scratchpads go and the remedy verifies', fixed.fixed?.fixes?.[0]?.applied?.ok === true && fixed.fixed.fixes[0].applied.note === 'removed 3 scratchpads' && fixed.fixed.fixes[0].verified?.ok === true && gone('large-dead') && gone('dead-young') && gone('stopped-young'), JSON.stringify(fixed.fixed))
  check('the remedy took nothing outside the temp root: the folder reached through .. and the one behind the linked project folder stand whole', outsideStands())
  check('every scratchpad whose owner is not proven gone still stands', ['live-old', 'live-untimed-old', 'worker-live-old', 'parked-then-resumed-old', 'other-home-old', 'unowned-old', 'unreadable-young', 'unreadable-old'].every(stands))
  const after = child(['--health'])
  check('the row then reads ok', after.row?.status === 'ok' && after.row.evidence === 'only running sessions hold scratch' && fixed.fixed.fixes[0].verified.note === 'only running sessions hold scratch', JSON.stringify(after.row))
  const tooLarge = plant('too-many-to-read', { pid: GONE_PID }, 45, dir => {
    for (let folder = 0; folder < 21; folder++) {
      mkdirSync(join(dir, `f${folder}`))
      for (let index = 0; index < 1000; index++) writeFileSync(join(dir, `f${folder}`, `${index}`), '')
    }
    writeFileSync(join(dir, 'notes.md'), 'too many\n')
  })
  const unreadWhole = child(['--cycle'])
  check('a scratchpad too large to scan whole is retained by the cycle, however old', unreadWhole.scratch?.visited === 1 && unreadWhole.scratch.removed === 0 && unreadWhole.scratch.retained === 1 && existsSync(tooLarge), JSON.stringify(unreadWhole))
  const named = child(['--health'])
  check('and the row warns and says it stays until removed here', named.row?.status === 'warn' && /^1 session that is not running holds at least \d+ bytes of scratch · 1 too large to scan stays until removed here$/.test(named.row.evidence), JSON.stringify(named.row))
  console.log(`        ${named.row?.evidence}`)
  rmSync(dirname(dirname(tooLarge)), { recursive: true, force: true })
  rmSync(scratchpad.scratchpadOwnerRecord(tooLarge), { force: true })
}

section('§8 a session resumed after its scratchpad was swept is told nothing false about it')
{
  const swept = planted.get('parked-old')!
  const sessionId = dirname(swept).split('/').at(-1)!
  const resumed = child(['--resume', sessionId], join(work, 'projects', 'parked-old'))
  check('the resumed session is given the same scratchpad path, made again and empty', resumed.dir === swept && Array.isArray(resumed.entries) && resumed.entries.length === 0, JSON.stringify(resumed))
  check('its prompt carries the standing scratchpad sentence and no other line about a scratchpad: nothing claims the earlier files', resumed.standing === true && resumed.lines?.length === 1, JSON.stringify(resumed.lines))
  check('and it is recorded as the owner again, under its own pid', resumed.owner?.pid === resumed.pid && resumed.owner?.dir === swept && resumed.owner?.home === HOME, JSON.stringify(resumed.owner))
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${'─'.repeat(76)}`)
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

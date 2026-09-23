#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-rename-retry-'))
const HOME = join(SCRATCH, 'home')
const DAEMON = join(HOME, 'daemon')
mkdirSync(DAEMON, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT

const { processSweepCensusPath, recordProcessCensusAtBoot } = await import('../../src/daemon/processSweepRun.ts')
const { mintGitInitAsk } = await import('../../src/daemon/permissionAsks.ts')
const { migrateTranscriptHomeToLaw } = await import('../../src/daemon/concourseSupervisor.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { _resetFaultInjectionCountersForTests } = await import('../../src/substrate/durablePublish.ts')

const IS_WINDOWS = process.platform === 'win32'
const HOLD_MS = 150

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

type Engaged = 'held' | 'exited' | 'timeout'

async function whileHeld<T>(path: string, run: () => T | Promise<T>): Promise<{ engaged: Engaged; value: T | undefined }> {
  const quoted = path.replace(/'/g, "''")
  const script = [
    `$f=[System.IO.File]::Open('${quoted}','Open','Read','Read')`,
    `[Console]::Out.WriteLine('HELD')`,
    `[Console]::Out.Flush()`,
    `[System.Threading.Thread]::Sleep(${HOLD_MS})`,
    `$f.Close()`,
  ].join('; ')
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  })
  const done = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const held = new Promise<Engaged>(resolve => {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('HELD')) resolve('held')
    })
  })
  const engaged = await Promise.race([
    held,
    done.then((): Engaged => 'exited'),
    new Promise<Engaged>(resolve => setTimeout(() => resolve('timeout'), 30_000)),
  ])
  if (engaged !== 'held') {
    child.kill()
    await done
    return { engaged, value: undefined }
  }
  const value = await run()
  await done
  return { engaged, value }
}

async function whileOpen<T>(path: string, run: () => T | Promise<T>): Promise<T> {
  const fd = openSync(path, 'r')
  try {
    return await run()
  } finally {
    closeSync(fd)
  }
}

async function withFault<T>(spec: string, run: () => T | Promise<T>): Promise<T> {
  _resetFaultInjectionCountersForTests()
  process.env.MERCURY_FAULT_INJECT = spec
  try {
    return await run()
  } finally {
    delete process.env.MERCURY_FAULT_INJECT
  }
}

const censusPath = processSweepCensusPath(HOME)
const OLD_CENSUS = JSON.stringify({ readAt: 1, memory: {} }, null, 2)
const censusDeps = {
  home: HOME,
  ownDaemonDir: DAEMON,
  nowMs: () => 1_700_000_000_000,
  waitMs: 100,
  collect: async () => ({ observations: [], complete: true }),
  rpc: async (): Promise<never> => {
    throw new Error('no daemon answers in this proof')
  },
}
const seedCensus = (): void => {
  mkdirSync(join(HOME, 'processes'), { recursive: true })
  writeFileSync(censusPath, OLD_CENSUS)
}
const censusLanded = (census: unknown): boolean =>
  census !== undefined && read(censusPath) === JSON.stringify(census, null, 2) && !existsSync(`${censusPath}.${process.pid}.tmp`)

const asksPath = join(DAEMON, 'git-init-asks.json')
let folders = 0
const freshFolder = (): string => {
  const folder = join(SCRATCH, `project-${++folders}`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), '{}\n')
  return folder
}
const seedAsks = (): void => writeFileSync(asksPath, '{}')
const askIdOf = (minted: ReturnType<typeof mintGitInitAsk> | undefined): string =>
  minted !== undefined && 'requestId' in minted ? minted.requestId : ''
const asksLanded = (id: string, folder: string): boolean =>
  id !== '' && read(asksPath) === JSON.stringify({ [id]: folder }) && !existsSync(`${asksPath}.tmp-${process.pid}`)

const WORKSPACE = join(SCRATCH, 'workspace')
const WORKTREE = join(SCRATCH, 'worktree')
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(WORKTREE, { recursive: true })
const legacyHome = getProjectDir(WORKTREE)
const lawHome = getProjectDir(WORKSPACE)
mkdirSync(legacyHome, { recursive: true })
interface TranscriptCase {
  rec: { sessionId: string; workspaceId: string; worktreePath: string }
  legacy: string
  law: string
  bytes: string
}
let sessions = 0
const seedTranscript = (): TranscriptCase => {
  const sessionId = `rename-retry-session-${++sessions}`
  const bytes = `${JSON.stringify({ type: 'user', sessionId })}\n`
  const legacy = join(legacyHome, `${sessionId}.jsonl`)
  writeFileSync(legacy, bytes)
  return { rec: { sessionId, workspaceId: WORKSPACE, worktreePath: WORKTREE }, legacy, law: join(lawHome, `${sessionId}.jsonl`), bytes }
}
const transcriptMoved = (t: TranscriptCase): boolean => read(t.law) === t.bytes && !existsSync(t.legacy)
const transcriptStayed = (t: TranscriptCase): boolean => read(t.legacy) === t.bytes && !existsSync(t.law)

console.log('============================================================')
console.log(' the daemon-home and config-home renames against a held file')
console.log('============================================================')

console.log('§1 with nothing holding the files, each write lands with the bytes and the names it always had')
{
  seedCensus()
  const census = await recordProcessCensusAtBoot(censusDeps)
  check('the boot census replaces census.json with the writer\'s own bytes and leaves no temp beside it', censusLanded(census), read(censusPath).slice(0, 60))
}
{
  seedAsks()
  const folder = freshFolder()
  const id = askIdOf(mintGitInitAsk(folder))
  check('the git-init ask lands in git-init-asks.json with the writer\'s own bytes and leaves no temp beside it', asksLanded(id, folder), read(asksPath))
}
{
  const t = seedTranscript()
  migrateTranscriptHomeToLaw(t.rec)
  check('the worktree transcript moves to the workspace project folder byte for byte', transcriptMoved(t))
}

if (IS_WINDOWS) {
  console.log(`§2 another program holds the file without delete sharing and lets go ${HOLD_MS} ms later: each write waits it out`)
  {
    seedCensus()
    const run = await whileHeld(censusPath, () => recordProcessCensusAtBoot(censusDeps))
    check('the holder took census.json', run.engaged === 'held', run.engaged)
    check('the boot census lands once the holder lets go', censusLanded(run.value), read(censusPath).slice(0, 60))
  }
  {
    seedAsks()
    const folder = freshFolder()
    const run = await whileHeld(asksPath, () => mintGitInitAsk(folder))
    check('the holder took git-init-asks.json', run.engaged === 'held', run.engaged)
    check('the git-init ask lands once the holder lets go', asksLanded(askIdOf(run.value), folder), read(asksPath))
  }
  {
    const t = seedTranscript()
    const run = await whileHeld(t.legacy, () => migrateTranscriptHomeToLaw(t.rec))
    check('the holder took the worktree transcript', run.engaged === 'held', run.engaged)
    check('the transcript moves once the holder lets go', transcriptMoved(t))
  }
} else {
  console.log('§2 an open handle never blocks a rename on POSIX: each write lands at once, as it always has')
  {
    seedCensus()
    const census = await whileOpen(censusPath, () => recordProcessCensusAtBoot(censusDeps))
    check('the boot census lands through an open handle on census.json', censusLanded(census), read(censusPath).slice(0, 60))
  }
  {
    seedAsks()
    const folder = freshFolder()
    const minted = await whileOpen(asksPath, () => mintGitInitAsk(folder))
    check('the git-init ask lands through an open handle on git-init-asks.json', asksLanded(askIdOf(minted), folder), read(asksPath))
  }
  {
    const t = seedTranscript()
    await whileOpen(t.legacy, () => migrateTranscriptHomeToLaw(t.rec))
    check('the transcript moves through an open handle on it', transcriptMoved(t))
  }
}

if (IS_WINDOWS) {
  console.log('§3 each write takes the shared Win32 rename retry (an EPERM injected at the rename)')
  {
    seedCensus()
    await withFault('rename@census.json:eperm', () => recordProcessCensusAtBoot(censusDeps))
    check('an EPERM that never clears leaves the last census whole', read(censusPath) === OLD_CENSUS, read(censusPath).slice(0, 60))
    seedCensus()
    const census = await withFault('rename@census.json:eperm#2', () => recordProcessCensusAtBoot(censusDeps))
    check('EPERM twice, then clear: the census lands through the bounded retry', censusLanded(census), read(censusPath).slice(0, 60))
  }
  {
    seedAsks()
    await withFault('rename@git-init-asks.json:eperm', () => mintGitInitAsk(freshFolder()))
    check('an EPERM that never clears leaves the git-init sidecar as it was', read(asksPath) === '{}', read(asksPath))
    seedAsks()
    const folder = freshFolder()
    const minted = await withFault('rename@git-init-asks.json:eperm#2', () => mintGitInitAsk(folder))
    check('EPERM twice, then clear: the git-init ask lands through the bounded retry', asksLanded(askIdOf(minted), folder), read(asksPath))
  }
  {
    const stays = seedTranscript()
    await withFault(`rename@${stays.rec.sessionId}.jsonl:eperm`, () => migrateTranscriptHomeToLaw(stays.rec))
    check('an EPERM that never clears leaves the transcript where it was', transcriptStayed(stays))
    const moves = seedTranscript()
    await withFault(`rename@${moves.rec.sessionId}.jsonl:eperm#2`, () => migrateTranscriptHomeToLaw(moves.rec))
    check('EPERM twice, then clear: the transcript moves through the bounded retry', transcriptMoved(moves))
  }
}

try {
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(`\nprove-daemon-rename-retry: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

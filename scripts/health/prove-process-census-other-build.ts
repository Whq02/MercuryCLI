#!/usr/bin/env bun
import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSweepObservation, ProcessSweepRecords, ProcessSweepTable } from '../../src/daemon/processSweep.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { composeProcessSweepFacts, classifyMercuryProcess, readProcessSweepCensus, processSweepCounts, PROCESS_SWEEP_WORDS, bundleArgOf, sameBundlePath, bundleDirOf } = await import('../../src/daemon/processSweep.ts')
const { readMercuryProcesses, ownBundlePath } = await import('../../src/daemon/processSweepRun.ts')

let checks = 0
const check = (label: string, run: () => void | Promise<void>): Promise<void> => Promise.resolve(run()).then(() => {
  checks++
  console.log(`[PASS] ${label}`)
})

const NOW = Date.parse('2026-10-03T23:24:07+01:00')
const token = (ms: number): string => {
  const date = new Date(ms)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${day} ${String(date.getDate()).padStart(2, ' ')} ${month} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`
}

const OWN_BUNDLE = '/Users/op/pre27-air/pre27/dist/mercury.mjs'
const INSTALLED_BUNDLE = '/Users/op/.mercury/versions/1.0.0-beta.26/mercury.mjs'

const observation = (pid: number, ppid: number, args: string[], opts: { exe?: string; terminal?: string | null; terminalAlive?: boolean | null; bornMs?: number; user?: string; state?: string } = {}): ProcessSweepObservation => {
  const bornMs = opts.bornMs ?? NOW - 60_000
  return {
    process: { pid, ppid, exe: opts.exe ?? 'node', args, startedAtMs: bornMs, user: opts.user ?? '501', terminal: opts.terminal ?? null },
    startToken: token(bornMs),
    state: opts.state ?? 'S',
    terminalAlive: opts.terminalAlive ?? null,
  }
}

const SELF = 90_001
const table: ProcessSweepTable = {
  complete: true,
  observations: [
    observation(SELF, 1, ['node', OWN_BUNDLE, 'health', 'processes']),
    observation(41139, 1, ['/Users/op/.mercury/versions/1.0.0-beta.26/vendor/node/bin/node', INSTALLED_BUNDLE, 'daemon', 'run', '/Users/op/Desktop/Test'], { bornMs: NOW - 15 * 3_600_000 }),
    observation(69025, 1, ['mercury'], { terminal: 'ttys003', terminalAlive: true }),
    observation(71158, 41139, ['mercury']),
    observation(82903, 1, ['node', OWN_BUNDLE, 'run', 'hello']),
    observation(77001, 1, ['/usr/bin/python3', '/Users/op/pre27-air/runwatch.py', 'mercury.mjs'], { exe: 'python3' }),
    observation(7001, 7000, ['node', INSTALLED_BUNDLE, 'daemon', 'run', '/elsewhere'], { user: '502' }),
  ],
}
const records: ProcessSweepRecords = {
  nowMs: NOW,
  platform: 'darwin',
  selfPid: SELF,
  user: '501',
  configHome: '/Users/op/pre27-air/pre27/field-home/config',
  drainMs: 600_000,
  heartbeatAllowanceMs: 90_000,
  planes: [{ daemonDir: '/Users/op/pre27-air/pre27/field-home/config/daemon', supervisor: null, supervisorReadable: true, answer: null, runners: null }],
  registrations: [],
  memory: null,
  bundle: OWN_BUNDLE,
}

const classes = (): Map<number, { classification: string; reason: string; kind: string }> => {
  const out = new Map<number, { classification: string; reason: string; kind: string }>()
  for (const facts of composeProcessSweepFacts(table, records)) {
    const entry = classifyMercuryProcess(facts)
    out.set(entry.process.pid, { classification: entry.classification, reason: entry.reason, kind: entry.kind })
  }
  return out
}

await check('the bundle a process runs is read from its command line', () => {
  assert.equal(bundleArgOf(['node', INSTALLED_BUNDLE, 'daemon', 'run', '/x']), INSTALLED_BUNDLE)
  assert.equal(bundleArgOf(['mercury']), null)
  assert.equal(bundleArgOf(['C:\\pre27-field\\pre27\\node.exe', 'C:\\pre27-field\\pre27\\dist\\mercury.mjs', 'daemon', 'run']), 'C:\\pre27-field\\pre27\\dist\\mercury.mjs')
  assert.equal(bundleDirOf(INSTALLED_BUNDLE), '/Users/op/.mercury/versions/1.0.0-beta.26')
  assert.equal(sameBundlePath('C:\\a\\Dist\\mercury.mjs', 'c:/a/dist/mercury.mjs', 'win32'), true)
  assert.equal(sameBundlePath('/a/dist/mercury.mjs', '/a/Dist/mercury.mjs', 'darwin'), false)
})

await check("another install's daemon, unrecorded in this home, is not ours: another Mercury build, left alone", () => {
  const got = classes()
  assert.equal(got.get(41139)!.kind, 'daemon')
  assert.equal(got.get(41139)!.classification, 'not-ours')
  assert.match(got.get(41139)!.reason, /another Mercury build at \/Users\/op\/\.mercury\/versions\/1\.0\.0-beta\.26; left alone/)
})

await check('a process of this build that left no record keeps its honest reading', () => {
  const got = classes()
  assert.equal(got.get(82903)!.kind, 'runner')
  assert.equal(got.get(82903)!.classification, 'cannot-end')
  assert.match(got.get(82903)!.reason, /cannot establish this process's config home/)
})

await check("a process whose command line is the bare word says nothing about its build; the terminal in use keeps it running, a bare runner stays cannot-end", () => {
  const got = classes()
  assert.equal(got.get(69025)!.classification, 'running')
  assert.match(got.get(69025)!.reason, /in use: terminal/)
  assert.equal(got.get(71158)!.classification, 'cannot-end')
})

await check("another user's process and a non-Mercury executable stay not ours for their own reasons; the reader is running", () => {
  const got = classes()
  assert.match(got.get(7001)!.reason, /another user/)
  assert.equal(got.get(7001)!.classification, 'not-ours')
  assert.equal(got.has(77001), false)
  assert.equal(got.get(SELF)!.classification, 'running')
})

await check('the counts line names the other install as not ours', () => {
  const census = readProcessSweepCensus(table, records)
  const counts = processSweepCounts(census.entries)
  assert.equal(counts['not-ours'], 2)
  assert.equal(PROCESS_SWEEP_WORDS.counts(counts), `${counts.running} running · ${counts.stale} stale · ${counts['cannot-end']} cannot end · 2 not ours`)
})

await check('with no bundle of its own the census cannot judge builds and says so as before', () => {
  const blind = { ...records, bundle: null }
  const entry = composeProcessSweepFacts(table, blind).map(classifyMercuryProcess).find(e => e.process.pid === 41139)!
  assert.equal(entry.classification, 'cannot-end')
  assert.match(entry.reason, /cannot establish this process's config home/)
})

await check('the census resolves symlinked bundle spellings before it compares them', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'census-bundle-')))
  try {
    const builds = join(scratch, 'builds', 'abc')
    mkdirSync(builds, { recursive: true })
    writeFileSync(join(builds, 'mercury.mjs'), '')
    symlinkSync(builds, join(scratch, 'current'))
    const viaLink = join(scratch, 'current', 'mercury.mjs')
    const own = ownBundlePath(viaLink)
    assert.equal(own, join(builds, 'mercury.mjs'))
    assert.equal(ownBundlePath('/usr/bin/node'), null)
    assert.equal(ownBundlePath(undefined), null)
    const linked: ProcessSweepTable = { complete: true, observations: [observation(SELF, 1, ['node', own!, 'health']), observation(5050, 1, ['node', viaLink, 'daemon', 'run', '/p'])] }
    const resolving: ProcessSweepRecords = { ...records, bundle: own, resolvePath: path => { try { return realpathSync.native(path) } catch { return null } } }
    const entry = composeProcessSweepFacts(linked, resolving).map(classifyMercuryProcess).find(e => e.process.pid === 5050)!
    assert.notEqual(entry.classification, 'not-ours')
    assert.equal(entry.classification, 'cannot-end')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

await check('the census road hands the classifier its own bundle and the path resolver', async () => {
  const home = mkdtempSync(join(tmpdir(), 'census-home-'))
  const me = typeof process.getuid === 'function' ? String(process.getuid()) : ''
  try {
    const census = await readMercuryProcesses({
      home,
      ownDaemonDir: join(home, 'daemon'),
      bundle: OWN_BUNDLE,
      waitMs: 200,
      nowMs: () => NOW,
      rpc: async () => { throw new Error('no daemon') },
      collect: async () => ({ complete: true, observations: [observation(process.pid, 1, ['node', OWN_BUNDLE, 'health'], { user: me }), observation(41139, 1, ['node', INSTALLED_BUNDLE, 'daemon', 'run', '/Users/op/Desktop/Test'], { user: me })] }),
    })
    const other = census.entries.find(e => e.process.pid === 41139)
    assert.ok(other, 'the other install is in the census')
    assert.equal(other!.classification, 'not-ours')
    assert.match(other!.reason, /another Mercury build/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

console.log(`\n${checks} checks passed — prove-process-census-other-build`)

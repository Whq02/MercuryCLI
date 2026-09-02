#!/usr/bin/env bun
// ============================================================================
//  scripts/exit-handle/prove-exit-cliff-census.ts — THE HANDLE CENSUS at the
// exit cliff on the REAL dist (TASK-017 D3: the box's 8/8
//  0xC0000409 after any tool executed — the runtime's own libuv assert,
//  nodejs/node#56645, fixed in Node 24.20.0; this proves the PRODUCT's side
//  of the cliff is empty and the run's own data landed).
//
//  Four -p runs on the scripted stream (zero network for the model call,
//  a seeded scratch home): the no-tool control `answer-text`, then one
//  tool_use each of Read · Glob · Bash settling with text. Each boots under
//  census-preload.mjs, which wraps process.reallyExit ahead of signal-exit
//  and records every live libuv handle/request at the true cliff.
//
//    per case, the DRAIN arm (production):
//      · exit 0 and the settled text on stdout (the run itself is unchanged)
//      · the census was taken at reallyExit (not a natural drain)
//      · ZERO pending product-owned requests at the cliff — the transcript
//        writer's append/close — none in flight
//      · the session transcript on disk carries the settled text
//    the POISON arm (MERCURY_EXIT_CLIFF_DRAIN=0, one tool case): the pre-fix
//      shape — a product-owned request pending at the cliff (the writer's
//      append cut by process.exit within its own duration).
//
//  Requires the prebuilt dist. Bounded: ≤90s per run, exact-pid kill.
//  Run: ~/.bun/bin/bun run scripts/exit-handle/prove-exit-cliff-census.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const PRELOAD = join(import.meta.dir, 'census-preload.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — exit-cliff census exceeded 600s')
  process.exit(1)
}, 600_000)
guard.unref?.()

const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { ONE_TOOL_SCRIPTS, ANSWER_TEXT_SCRIPT, ONE_TOOL_READ_FILE, ONE_TOOL_SETTLED_TEXT, ONE_TOOL_WRITE_WITNESS } =
  await import('../../src/query/scriptedStream.ts')

/** A request is PRODUCT-OWNED when its creation stack names one of the
 *  product's persistence seams (method names survive the bundler; free
 *  functions do not — the async frames carry the owning method). */
const PRODUCT_SEAM = /appendToFile|_drainWriteQueueInner/

type Req = { kind: string; pending?: boolean; stack?: string[] }
type Census = {
  where: string
  code: number
  node: string
  requests: Req[]
  handles: { kind: string; fd?: number }[]
  activeResourcesInfo: Record<string, number>
  /** The drain owner's registered seam names (published on the channel). */
  drainSeams?: string[] | null
  drainSkipped?: boolean
  /** The drain owner's report (settled/failed/abandoned), at the cliff. */
  drainReport?: { skipped: boolean; settled: string[]; failed: string[]; abandoned: string[]; elapsedMs: number } | null
}
type Run = {
  script: string
  arm: 'drain' | 'poison'
  /** The --allowedTools handed to the run (a tool outside it is DENIED at dispatch). */
  allowed: string[]
  rc: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** The dump taken the moment the drain owner was about to run. */
  beforeDrain: Census | null
  /** The dump taken at the reallyExit cliff, after the drain. */
  census: Census | null
  home: string
  fix: string
}

function pendingProductOwned(c: Census): Req[] {
  return c.requests.filter(
    r =>
      (r.kind === 'FileHandleCloseReq' || r.pending === true || r.pending === undefined) &&
      PRODUCT_SEAM.test((r.stack ?? []).join('\n')),
  )
}

function readTranscript(home: string): string {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return ''
  let text = ''
  for (const p of readdirSync(projects)) {
    const dir = join(projects, p)
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) text += readFileSync(join(dir, f), 'utf8')
    }
  }
  return text
}

async function runCase(
  script: string,
  arm: 'drain' | 'poison',
  allowed: string[] = ['Bash', 'Read', 'Glob'],
): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), `exit-cliff-home-${script}-${arm}-`))
  const fix = mkdtempSync(join(tmpdir(), `exit-cliff-fix-${script}-${arm}-`))
  writeFileSync(join(fix, ONE_TOOL_READ_FILE), '# one-tool read fixture\n\nthe read tool reads this file.\n')
  writeFileSync(join(fix, 'second.md'), '# second markdown\n')
  seedFirstRun(home, [fix, realpathSync(fix)])
  const censusPath = join(home, 'census.json')
  for (const d of ['daemon', 'teams', 'tabula']) mkdirSync(join(home, d), { recursive: true })
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_SCRIPTED_STREAM: script,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    EXIT_CENSUS_OUT: censusPath,
    VISUAL: '',
    EDITOR: '',
  }
  delete env.MERCURY_EXIT_CLIFF_DRAIN
  delete env.MERCURY_HOME
  if (arm === 'poison') env.MERCURY_EXIT_CLIFF_DRAIN = '0'
  const child = spawn(
    nodeBin,
    ['--import', PRELOAD, DIST, '-p', 'please do the scripted thing', '--allowedTools', ...allowed],
    { cwd: fix, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => (stdout += String(d)))
  child.stderr.on('data', d => (stderr += String(d)))
  const exit = await new Promise<{ rc: number | null; signal: string | null }>(res => {
    const killer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
    }, 90_000)
    child.on('exit', (rc, signal) => {
      clearTimeout(killer)
      res({ rc, signal: signal ?? null })
    })
  })
  const readDump = (path: string): Census | null => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Census
    } catch {
      return null
    }
  }
  const census = readDump(censusPath)
  const beforeDrain = readDump(`${censusPath}.before-drain.json`)
  return { script, arm, allowed, rc: exit.rc, signal: exit.signal, stdout, stderr, beforeDrain, census, home, fix }
}

/** The verbatim pre-drain list — printed so the receipt can carry it. */
function describeOwned(reqs: Req[]): string[] {
  return reqs.map(r => `${r.kind}${r.pending === true ? ' PENDING' : r.pending === false ? ' settled' : ''} ← ${(r.stack ?? []).slice(0, 6).map(s => s.replace(/\s*\(file:.*mercury\.mjs:(\d+:\d+)\)/, ' @' + '$1').replace(/^at /, '')).join(' ← ')}`)
}

const cleanups: string[] = []
const drainRuns: Run[] = []
for (const script of [ANSWER_TEXT_SCRIPT, ...ONE_TOOL_SCRIPTS]) {
  drainRuns.push(await runCase(script, 'drain'))
}
// The DISPATCH boundary (the dispatch boundary): a Bash call DENIED at the
// permission layer — never run — crashed the box identically. The mutating
// write script with Bash outside --allowedTools is that shape (a read-only
// echo is auto-allowed and would run regardless of the allow list).
drainRuns.push(await runCase('tool-bash-write', 'drain', ['Read', 'Glob']))
const poison = await runCase('tool-bash', 'poison')

section('§1 — the DRAIN arm: six -p runs (control · Read · Glob · Bash · Bash write · Bash write DENIED at dispatch), the census BEFORE the drain and AT the cliff')
for (const run of drainRuns) {
  cleanups.push(run.home, run.fix)
  const denied = run.script === 'tool-bash-write' && !run.allowed.includes('Bash')
  const tag = `[${run.script}${denied ? ' DENIED' : ''}]`
  check(`${tag} the run exits 0 with the settled text (the run itself is unchanged)`, run.rc === 0 && run.stdout.includes(ONE_TOOL_SETTLED_TEXT), `rc=${run.rc} signal=${run.signal} stderr=${run.stderr.slice(-300)}`)
  check(`${tag} the census was taken at the reallyExit cliff`, run.census?.where === 'reallyExit', j(run.census?.where))
  check(`${tag} the BEFORE dump was taken the moment the drain owner was about to run (the channel spoke)`, run.beforeDrain?.where === 'before-drain' && run.beforeDrain.drainSkipped === false, j(run.beforeDrain?.where))
  if (!run.census) continue
  const owned = pendingProductOwned(run.census)
  const ownedBefore = run.beforeDrain ? pendingProductOwned(run.beforeDrain) : []
  console.log(`    before-drain product-owned (${ownedBefore.length}): ${describeOwned(ownedBefore).join(' ‖ ') || '(none)'}`)
  check(
    `${tag} THE DELTA: product-owned persistence was in flight BEFORE the drain (the seams existed — this is the census's evidence, not an absence)`,
    ownedBefore.length >= 1,
    j(run.beforeDrain?.requests.map(r => `${r.kind}:${r.pending}:${(r.stack ?? []).slice(2, 5).join('|')}`)),
  )
  check(
    `${tag} …and ZERO pending product-owned requests at the cliff after it (writer append/close) — drained by name, not raced`,
    owned.length === 0,
    j(owned.map(r => `${r.kind}:${(r.stack ?? []).slice(0, 5).join('|')}`)),
  )
  check(
    `${tag} the drain owner's own report at the cliff: the transcript-writer seam settled, none failed, none abandoned`,
    run.census.drainReport?.skipped === false &&
      run.census.drainReport.settled.includes('transcript-writer') &&
      run.census.drainReport.failed.length === 0 &&
      run.census.drainReport.abandoned.length === 0,
    j(run.census.drainReport),
  )
  const ownHandles = run.census.handles.filter(h => !(h.kind === 'Socket' && typeof h.fd === 'number' && h.fd <= 2))
  check(
    `${tag} no ref'd handle of the run's own keeps the cliff (no child, socket, or watcher — the stdio pipes are the spawner's)`,
    ownHandles.length === 0,
    j(ownHandles),
  )
  check(`${tag} the session transcript on disk carries the settled text`, readTranscript(run.home).includes(ONE_TOOL_SETTLED_TEXT))
  if (run.script !== ANSWER_TEXT_SCRIPT) {
    const transcript = readTranscript(run.home)
    check(
      `${tag} …and the tool round (the tool-use record + its tool-result record) is on disk`,
      /"kind":"tool-use"/.test(transcript) && /"kind":"tool-result"/.test(transcript),
    )
    if (run.script === 'tool-bash-write') {
      const witness = existsSync(join(run.fix, ONE_TOOL_WRITE_WITNESS))
      if (denied) {
        check(
          `${tag} the denied call never ran (its side-effect witness is ABSENT) and its result is the denial (an error tool-result) — dispatched, not executed: the box's checkpoint-8 shape`,
          !witness && /"kind":"tool-result"[^\n]*"isError":true/.test(transcript),
          `witness=${witness} ${transcript.slice(-400)}`,
        )
      } else {
        check(`${tag} the allowed write ran (its side-effect witness EXISTS) — the same script, the other side of the permission layer`, witness)
      }
    }
  }
}

section('§2 — the POISON arm (MERCURY_EXIT_CLIFF_DRAIN=0): the pre-fix cut, seen by the same instrument')
{
  cleanups.push(poison.home, poison.fix)
  check('[poison tool-bash] the run still exits 0 with the settled text (the poison only skips the drain)', poison.rc === 0 && poison.stdout.includes(ONE_TOOL_SETTLED_TEXT), `rc=${poison.rc}`)
  check('[poison tool-bash] the channel still speaks at the same moment — the BEFORE dump says the drain was skipped', poison.beforeDrain?.where === 'before-drain' && poison.beforeDrain.drainSkipped === true && poison.census?.drainReport?.skipped === true, j({ before: poison.beforeDrain?.where, skipped: poison.beforeDrain?.drainSkipped, report: poison.census?.drainReport }))
  const owned = poison.census ? pendingProductOwned(poison.census) : []
  console.log(`    poison cliff product-owned (${owned.length}): ${describeOwned(owned).join(' ‖ ') || '(none)'}`)
  check(
    '[poison tool-bash] a product-owned request is PENDING at the cliff (the writer append/close cut by process.exit) — the census sees the seam the drain empties',
    owned.length >= 1,
    j(poison.census?.requests.map(r => `${r.kind}:${r.pending}:${(r.stack ?? []).slice(2, 5).join('|')}`)),
  )
  check('[poison tool-bash] the JSONL transcript still carries the settled text (the cleanup flush lands it in both arms — the JSONL law is unchanged)', readTranscript(poison.home).includes(ONE_TOOL_SETTLED_TEXT))
}

for (const dir of cleanups) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // scratch only
  }
}
console.log(`\n${failures === 0 ? '✅' : '❌'} exit-cliff census — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

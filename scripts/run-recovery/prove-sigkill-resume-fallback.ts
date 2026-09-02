#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-sigkill-resume-fallback.ts — the ledger
//  §TRANSCRIPT-DEBOUNCE-SIGKILL, the real-binary journey.
//
//  ORACLE: a SIGKILL landing right at a young session's first completion must
//  NEVER yield an unresumable session. The guarded class: the transcript
//  writer lands queued lines on a 100 ms timer, so a completion visible on
//  stdout could precede the turn's lines on disk — and a resume of the
//  killed session then found nothing. The mechanism is ONE stroke at the
//  root: the -p message pump flushes the transcript BEFORE a result frame
//  (and the final text it becomes) reaches the wire, so the completion a
//  caller acts on is never ahead of the transcript. (The former second
//  store — a fabric room mirror the resume read back — retired with the
//  multiplayer estate; this leg A is its successor.)
//
//  Legs (headless -p — cpu-lane compatible):
//   0  the source pin: the pump awaits the writer's flush on a result frame
//   A  kill -9 at FIRST SIGHT of the completion marker on stdout — the jsonl
//      ALREADY holds the turn's conversation records (deterministic: the
//      flush preceded the print), and `--resume <sid>` carries the turn-1
//      prompt AND reply exactly once (uuid-dedup self-heal mints no
//      duplicates)
//   A2 the metadata-only-jsonl world (queue/metadata rows flushed, zero
//      conversation records) refuses cleanly with the honest floor — never a
//      crash, never a half-resumed session
//
//  Run:  ~/.bun/bin/bun run scripts/run-recovery/prove-sigkill-resume-fallback.ts
// ============================================================================
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
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
  console.log('\n❌ TIMEOUT — scenario exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const MARKER = 'T2-FIRST-REPLY-COMPLETE alpha bravo.'
const PROMPT = 'please reply with your scripted line'
const FOLLOWUP_REPLY = 'T2-SECOND-REPLY charlie.'

interface Arena {
  home: string
  cwd: string
  env: Record<string, string>
}
function makeArena(label: string, fixtureUrl: string): Arena {
  const home = mkdtempSync(join(tmpdir(), `velvet-t2-${label}-home-`))
  const cwd = mkdtempSync(join(tmpdir(), `velvet-t2-${label}-cwd-`))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      ANTHROPIC_BASE_URL: fixtureUrl,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_VERIFY_EVIDENCE: '0',
    },
  }
}

/** Run the binary, killing -9 the moment `killOn` appears on stdout. */
function runKillAt(
  arena: Arena,
  args: string[],
  killOn: string,
): Promise<{ exit: number | null; signal: string | null; stdout: string; sawMarker: boolean }> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let killed = false
    child.stdout.on('data', d => {
      stdout += String(d)
      if (!killed && stdout.includes(killOn)) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', () => {})
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', (exit, signal) => {
      clearTimeout(killer)
      resolvePromise({ exit, signal, stdout, sawMarker: killed })
    })
  })
}

function run(
  arena: Arena,
  args: string[],
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolvePromise({ exit, stdout, stderr })
    })
  })
}

function findJsonl(arena: Arena, sid: string): string | null {
  const projects = join(arena.home, '.mercury', 'projects')
  if (!existsSync(projects)) return null
  for (const dir of readdirSync(projects)) {
    const p = join(projects, dir, `${sid}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

/** How many CONVERSATION records the jsonl actually holds. File existence is
 *  NOT capture: queue/metadata rows can land ahead of the conversation
 *  records. Mirror the runtime's predicate: ≥1 parseable user/assistant
 *  line (torn tails skip, as parseJSONL does). */
function isConversationLine(line: string): boolean {
  try {
    const o = JSON.parse(line) as {
      type?: string
      schemaVersion?: number
      payload?: { kind?: string }
    }
    if (o.type === 'user' || o.type === 'assistant') return true
    // vNext record lines
    return (
      typeof o.schemaVersion === 'number' &&
      (o.payload?.kind === 'input' || o.payload?.kind === 'output')
    )
  } catch {
    return false
  }
}

function jsonlConversationRecords(arena: Arena, sid: string): number {
  const p = findJsonl(arena, sid)
  if (!p) return 0
  let n = 0
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    if (isConversationLine(line)) n++
  }
  return n
}

function countOf(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

interface KilledWorld {
  arena: Arena
  fixture: Awaited<ReturnType<typeof startFixtureApi>>
  sid: string
}

/** One kill-at-marker run in a fresh arena. */
async function killRun(label: string, sid: string): Promise<KilledWorld> {
  const fixture = await startFixtureApi([
    { kind: 'text', text: MARKER },
    { kind: 'text', text: FOLLOWUP_REPLY },
  ] as ScriptedTurn[])
  const arena = makeArena(label.toLowerCase(), fixture.url)
  const killed = await runKillAt(
    arena,
    ['-p', PROMPT, '--model', 'claude-opus-4-8', '--session-id', sid],
    'T2-FIRST-REPLY-COMPLETE',
  )
  check(`${label}: the first run reached its completion marker`, killed.sawMarker,
    JSON.stringify(killed.stdout.slice(0, 200)))
  check(`${label}: the process was killed, not clean-exited`, killed.exit !== 0,
    `exit=${killed.exit} signal=${killed.signal}`)
  console.log(
    `  (${label}: post-kill jsonl=${findJsonl(arena, sid) ? 'present' : 'ABSENT'} convRecords=${jsonlConversationRecords(arena, sid)})`,
  )
  return { arena, fixture, sid }
}

/** Resume the killed world and assert the class invariants: the flush
 *  preceded the completion, so the turn-1 PROMPT and REPLY are both on disk
 *  and resume carries each exactly once — nothing lost, nothing doubled. */
async function resumeAndAssert(label: string, w: KilledWorld): Promise<void> {
  const resumed = await run(w.arena, [
    '-p', 'what did you reply?', '--model', 'claude-opus-4-8', '--resume', w.sid,
  ])
  check(`${label}: --resume completes (exit 0, never "No conversation found")`,
    resumed.exit === 0 && !resumed.stdout.includes('No conversation found') &&
      !resumed.stderr.includes('No conversation found'),
    `exit=${resumed.exit} stderr=${resumed.stderr.slice(0, 200)}`)
  check(`${label}: the follow-up turn completed`, resumed.stdout.includes('T2-SECOND-REPLY'),
    JSON.stringify(resumed.stdout.slice(0, 200)))

  const msgs = w.fixture.messageRequests()
  const resumeBody = JSON.stringify(msgs[msgs.length - 1]?.body ?? {})
  check(`${label}: the resume request carries the turn-1 prompt exactly once`,
    countOf(resumeBody, PROMPT) === 1, `count=${countOf(resumeBody, PROMPT)}`)
  const replyN = countOf(resumeBody, 'T2-FIRST-REPLY-COMPLETE')
  check(`${label}: the resume request carries the turn-1 reply exactly once (flushed before the print, never duplicated)`,
    replyN === 1, `count=${replyN}`)

  // Self-heal, no duplication: after resume, no single transcript file holds
  // the turn-1 user message twice.
  const healed = findJsonl(w.arena, w.sid)
  if (healed) {
    const text = readFileSync(healed, 'utf8')
    const userN = text.split('\n').filter(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes(PROMPT)).length
    check(`${label}: the healed transcript holds the turn-1 prompt at most once`, userN <= 1,
      `count=${userN}`)
  }
  await w.fixture.close()
}

console.log('============================================================')
console.log(' VELVET T2 — SIGKILL at first completion is never data loss')
console.log('============================================================')

console.log('\n-- leg 0: the source pin — the pump flushes before a result frame --')
{
  const pump = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  check(
    'the -p message pump awaits the transcript flush on a result frame BEFORE routing it (the turn-boundary flush)',
    /for await \(const outboundMessage of io\.outbound\) \{[\s\S]{0,900}?if \(outboundMessage\.type === 'result'\) await peekProject\(\)\?\.flush\(\)\s*\n\s*routeOutbound\(outboundMessage\)/.test(pump),
  )
}

console.log('\n-- leg A: kill at marker — the transcript is ahead of the print --')
// The completion marker reaches stdout only after the pump flushed the
// turn's records, so the kill finds BOTH conversation lines on disk. A
// contentless jsonl here would mean the flush no longer precedes the print.
{
  const w = await killRun('A', 'a3e70000-0000-4000-8000-0000000000b1')
  const records = jsonlConversationRecords(w.arena, w.sid)
  check('A: the killed session\'s jsonl already holds the turn (prompt + reply — the flush preceded the print)',
    records >= 2, `convRecords=${records}`)
  await resumeAndAssert('A', w)
}

console.log('\n-- leg A2: the metadata-only-jsonl world, pinned deterministically --')
// The shape a kill inside an unflushed window used to leave (2-core CI,
// run 29649165884): the jsonl EXISTS — early queue/metadata rows landed —
// but holds ZERO conversation records. Timing cannot force it on this
// build, so build the shape from a REAL binary artifact: complete a run
// gracefully (the full jsonl always lands on graceful exit), then strip the
// conversation rows — resume must refuse with the honest message, never
// crash, never half-resume.
{
  const sid = 'a3e70000-0000-4000-8000-0000000000b2'
  const fixture = await startFixtureApi([
    { kind: 'text', text: MARKER },
    { kind: 'text', text: FOLLOWUP_REPLY },
  ] as ScriptedTurn[])
  const arena = makeArena('a2', fixture.url)
  const first = await run(arena, [
    '-p', PROMPT, '--model', 'claude-opus-4-8', '--session-id', sid,
  ])
  check('A2: the seed run completed gracefully', first.exit === 0 && first.stdout.includes('T2-FIRST-REPLY-COMPLETE'),
    `exit=${first.exit}`)
  const jsonl = findJsonl(arena, sid)
  check('A2: the graceful run left a transcript', jsonl !== null)
  if (jsonl) {
    const kept = readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter(line => {
        if (!line) return false
        return !isConversationLine(line)
      })
    writeFileSync(jsonl, kept.length ? kept.join('\n') + '\n' : '')
    check('A2: the stripped world is the metadata-only shape (jsonl present, zero conv records)',
      findJsonl(arena, sid) !== null && jsonlConversationRecords(arena, sid) === 0)
    const refused = await run(arena, [
      '-p', 'what did you reply?', '--model', 'claude-opus-4-8', '--resume', sid,
    ])
    check('A2: resume refuses cleanly on the metadata-only world (honest floor)',
      refused.exit === 1 &&
        (refused.stdout + refused.stderr).includes('No conversation found'),
      `exit=${refused.exit} stderr=${refused.stderr.slice(0, 160)}`)
  }
  await fixture.close()
  rmSync(arena.home, { recursive: true, force: true })
  rmSync(arena.cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

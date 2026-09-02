#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/live-progress-drive.ts — LIVEPAINT's RUN_LIVE
//  drive leg: the BUILT runner runs a REAL chatty bash command and the live
//  road is asserted end to end on the frames it actually emitted.
//
//  NOT a prove-* (never globs into the pooled gate): RUN_LIVE=1 arms it, and
//  without the flag it skips green. The drill:
//    1. node dist/mercury.mjs -p … --output-format stream-json --verbose
//       --include-partial-messages --allowedTools Bash, in a scratch config
//       home (seedFirstRun + the fixture key), with
//       MERCURY_SCRIPTED_STREAM=tool-bash-chatty — the scripted model calls
//       the REAL BashTool with a slow multi-line command (zero network, no
//       live key: the scripted seam replaces the provider call).
//    2. Assert the runner's stdout carried `ephemeral_tail` tool_progress
//       frames: keyed by the Bash call's id, chatty lines, seq monotonic.
//    3. Replay the CAPTURED lines through the REAL seat (onSeatLine) over
//       this process's scratch daemon dir — the session-progress projection
//       fills; a REAL attached connector fills the ephemeral store; the
//       REAL tool row paints the captured line. The captured result frame
//       then clears seat → projection → store (clear-on-settle, driven on
//       the real wire bytes).
//  Hermetic (scratch homes, fixture key, zero network) · bounded (120s
//  guard) · reaped (exact-pid kill + scratch rm).
//
//  Run: RUN_LIVE=1 ~/.bun/bin/bun run scripts/longrun-invariants/live-progress-drive.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.RUN_LIVE !== '1') {
  console.log('SKIP — live-progress-drive runs only under RUN_LIVE=1 (the drill precedent)')
  process.exit(0)
}

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first: ~/.bun/bin/bun run build.ts')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — live-progress-drive exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// The PROVER's own scratch config home — the seat + connector legs below use
// this process's DEFAULT dirs, so the round-trip is the product's own.
const PROVER_HOME = mkdtempSync(join(tmpdir(), 'live-drive-prover-'))
process.env.MERCURY_CONFIG_DIR = PROVER_HOME
const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
const { CHATTY_BASH_SCRIPT, CHATTY_BASH_LINES, ONE_TOOL_SETTLED_TEXT } = await import('../../src/query/scriptedStream.ts')

// ── 1. the real runner runs the chatty command ──────────────────────────────
section('§1 the built runner — a real chatty bash command under the scripted model')
const CHILD_HOME = mkdtempSync(join(tmpdir(), 'live-drive-child-home-'))
const WORKDIR = mkdtempSync(join(tmpdir(), 'live-drive-workdir-'))
seedFirstRun(CHILD_HOME, [WORKDIR])
for (const d of ['daemon', 'teams', 'tabula']) mkdirSync(join(CHILD_HOME, d), { recursive: true })

const child = spawn(
  nodeBin,
  [DIST, '-p', 'please do the scripted thing', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', 'Bash'],
  {
    cwd: WORKDIR,
    env: {
      ...(process.env as Record<string, string>),
      MERCURY_CONFIG_DIR: CHILD_HOME,
      MERCURY_DAEMON_DIR: join(CHILD_HOME, 'daemon'),
      MERCURY_TEAMS_DIR: join(CHILD_HOME, 'teams'),
      MERCURY_TABULA_DIR: join(CHILD_HOME, 'tabula'),
      MERCURY_SCRIPTED_STREAM: CHATTY_BASH_SCRIPT,
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      VISUAL: '',
      EDITOR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
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
        /* gone */
      }
    }
  }, 90_000)
  child.on('exit', (rc, signal) => {
    clearTimeout(killer)
    res({ rc, signal: signal ?? null })
  })
})
check('the runner settled cleanly (rc 0, no kill)', exit.rc === 0 && exit.signal === null, `rc=${exit.rc} signal=${exit.signal} stderr tail: ${stderr.slice(-300)}`)

const lines = stdout.split('\n').filter(l => l.trim() !== '')
type WireFrame = {
  type?: string
  tool_use_id?: string
  parent_tool_use_id?: string
  progress?: { kind?: string; data_type?: string; seq?: number; latest_line?: string }
}
const tailFrames: WireFrame[] = []
for (const line of lines) {
  if (!line.includes('"ephemeral_tail"')) continue
  try {
    const frame = JSON.parse(line) as WireFrame
    if (frame.type === 'tool_progress' && frame.progress?.kind === 'ephemeral_tail') tailFrames.push(frame)
  } catch {
    /* not a frame line */
  }
}
check(`the runner emitted ephemeral_tail frames on its real stdout (${tailFrames.length})`, tailFrames.length >= 1, `stdout ${lines.length} lines`)
check('every frame keys the REAL Bash call', tailFrames.every(f => f.parent_tool_use_id === 'toolu_chatty_bash_1'))
check('the latest lines are the command\'s own chatty lines', tailFrames.every(f => /^chatty line \d$/.test(f.progress?.latest_line ?? '')), JSON.stringify(tailFrames.map(f => f.progress?.latest_line)))
check('seq is strictly increasing (source-coalesced, never a backlog)', tailFrames.every((f, i) => i === 0 || (f.progress?.seq ?? 0) > (tailFrames[i - 1]!.progress?.seq ?? 0)))
check('the turn settled with the scripted text (the full-output-at-settle world is intact)', stdout.includes(ONE_TOOL_SETTLED_TEXT) && stdout.includes(`chatty line ${CHATTY_BASH_LINES}`))

// ── 2. the captured wire bytes drive the REAL seat + connector + row ───────
section('§2 the captured frames replayed through the real seat → store → row')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const seatMod = await import('../../src/daemon/sessionSeat.ts')
const { daemonSessionConnectorFor } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { getEphemeralProgressFrame } = await import('../../src/state/ephemeralProgressStore.ts')

const SHORT = 'concourse-w1'
const SESSION = 'sess-live-drive'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: WORKDIR,
    isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: Date.now(), lastLiveAt: Date.now(),
  } as never
})
const roster = { control: () => true, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const CHAT_HOME = mkdtempSync(join(tmpdir(), 'live-drive-chat-'))
writeFileSync(join(CHAT_HOME, `${SESSION}.jsonl`), '')
const connector = daemonSessionConnectorFor({
  sessionId: SESSION, runnerId: SHORT, title: 't', projectLabel: 'p',
  workspaceId: WORKDIR, home: CHAT_HOME,
})
await connector.attach()

const resultIndex = lines.findIndex(l => {
  if (!l.includes('"result"')) return false
  try {
    return (JSON.parse(l) as { type?: string }).type === 'result'
  } catch {
    return false
  }
})
check('the capture carries the result frame (the settle to replay)', resultIndex > 0)
for (const line of lines.slice(0, resultIndex)) seatMod.onSeatLine(SHORT, line, roster as never)
await sleep(800)
const filled = getEphemeralProgressFrame('toolu_chatty_bash_1') as { data?: { type?: string; output?: string } } | undefined
check('THE STORE FILLS from the real wire bytes', filled?.data?.type === 'bash_progress' && /^chatty line \d$/.test(filled?.data?.output ?? ''), JSON.stringify(filled?.data))

{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.js')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const row = await renderToString(
    React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(AssistantToolUseMessage as never, {
        param: { type: 'tool_use', id: 'toolu_chatty_bash_1', name: 'Bash', input: { command: 'the chatty command' } },
        tools: [BashTool], verbose: false,
        inProgressToolUseIDs: new Set(['toolu_chatty_bash_1']),
        progressMessagesForMessage: [filled] as never,
        shouldAnimate: true, shouldShowDot: true,
        lookups: {
          siblingToolUseIDs: new Map(), progressMessagesByToolUseID: new Map(),
          inProgressHookCounts: new Map(), resolvedHookCounts: new Map(),
          toolResultByToolUseID: new Map(), toolUseByToolUseID: new Map(),
          normalizedMessageCount: 1, resolvedToolUseIDs: new Set<string>(),
          erroredToolUseIDs: new Set<string>(), deniedToolUseIDs: new Set<string>(),
        } as never,
      } as never),
    ) as never,
    100,
  )
  check('THE ROW PAINTS THE TAIL — the captured line under the running header', /chatty line \d/.test(row), JSON.stringify(row))
}

for (const line of lines.slice(resultIndex)) seatMod.onSeatLine(SHORT, line, roster as never)
await sleep(800)
check('the captured result frame clears seat → projection → store (clear-on-settle on real bytes)', getEphemeralProgressFrame('toolu_chatty_bash_1') === undefined)
connector.detach()
seatMod.onSeatSettled(SHORT)

for (const dir of [PROVER_HOME, CHILD_HOME, WORKDIR, CHAT_HOME]) rmSync(dir, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} LIVE-PROGRESS-DRIVE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ LIVE-PROGRESS-DRIVE PASSES — the real runner\'s output painted the row')
process.exit(0)

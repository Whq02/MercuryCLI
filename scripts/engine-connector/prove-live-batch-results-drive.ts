#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { grabScreens, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

const MODEL = 'claude-fable-5-1'
const PROMPT = 'run the live batch'
const QUEUED = 'words under the batch'
const CHILD = 'read the number for the batch'
const CHILD_REPLY = 'The witness has returned.'
const END = 'Batch complete.'
const MISSING = 'The previous run ended before this call returned a result'
const COLS = 144
const ROWS = 54
const ids = ['toolu_known', 'toolu_slow', 'toolu_sleep']
type Leg = 'plain' | 'queued' | 'crew'

function turns(cwd: string, leg: Leg): ScriptedTurn[] {
  const tools = [
    ...(leg === 'crew' ? [{ id: 'toolu_start_witness', name: 'Crewmate', input: { description: 'batch witness', prompt: CHILD, crewmate_type: 'mercury-crew', run_in_background: true } }] : []),
    { id: ids[0]!, name: 'Read', input: { file_path: join(cwd, 'number.txt') } },
    { id: ids[1]!, name: 'Bash', input: { command: 'sleep 6; printf waited', description: 'Wait for the batch' } },
    { id: ids[2]!, name: 'Sleep', input: { seconds: 2 } },
  ]
  return [
    handoffTurn(),
    ...(leg === 'crew' ? [
      { kind: 'tool_use' as const, whenModel: '', whenSaid: CHILD, name: 'Bash', id: 'toolu_witness_work', input: { command: 'sleep 2; printf witness', description: 'Read the number' } },
      { kind: 'text' as const, whenModel: '', whenBody: 'toolu_witness_work', text: CHILD_REPLY },
    ] : []),
    { kind: 'paced_tool_use', whenModel: 'fable', whenSaid: PROMPT, preDeltas: ['Batch begins now.'], gapMs: 10, tools },
    { kind: 'text', whenModel: 'fable', whenBody: ids[2], text: END },
    { kind: 'text', whenModel: 'fable', whenSaid: QUEUED, text: 'The queued words arrived.' },
  ]
}

function windows(run: ArenaRun): string[] {
  const writes = run.teeLines.flatMap(line => typeof line.content === 'string' && line.content !== '' ? [line.content] : [])
  assert(writes.length > 0, 'the terminal must deliver frames')
  const drive = join(run.paths.home, 'batch-frames.jsonl')
  writeFileSync(drive, writes.map((data, i) => JSON.stringify({ ts: i, b64: Buffer.from(data).toString('base64') })).join('\n'))
  return grabScreens({ ...run, paths: { ...run.paths, drive } }, COLS, ROWS, writes.map((_, i) => i)).map(frame => frame.rows.join('\n'))
}

type Entry = { occurredAt: string; payload: { kind: string; content?: { kind: string; callId?: string; body?: unknown; error?: boolean }[] } }
function history(dir: string): Entry[] {
  const projects = join(dir, '.mercury', 'projects')
  const files = readdirSync(projects, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => {
    const home = join(projects, item.name)
    return readdirSync(home).filter(name => /^[a-f0-9-]{36}\.jsonl$/.test(name)).map(name => join(home, name))
  })
  assert.equal(files.length, 1, 'expected one daemon-hosted session history')
  return readFileSync(files[0]!, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Entry)
}

async function measure(leg: Leg): Promise<number> {
  const run = await runArtifactArena({
    turns: cwd => turns(cwd, leg), cols: COLS, rows: ROWS, seconds: 26, keep: true, anchor: null,
    seedCwd: { 'number.txt': 'KNOWN-RESULT' },
    seedHome(config, cwd) {
      seedFirstRun(config, [cwd])
      writeFileSync(join(config, 'settings.json'), JSON.stringify({ engine: { model: MODEL }, guardrails: { allow: ['Read', 'Bash(sleep *)', 'Bash(printf *)'] } }))
    },
    extraEnv: { MERCURY_MODEL: MODEL },
    sends: [
      { awaitText: 'Type a prompt', text: PROMPT }, { awaitText: PROMPT, text: '\r', afterPrevMs: 200 },
      ...(leg === 'queued' ? [`after:Batch begins now.:1000:${QUEUED}`, 'after:Batch begins now.:1400:\\r'] : []),
    ],
  })
  try {
    assert(run.outcome.complete, run.outcome.reason ?? 'the terminal drive must finish')
    const frames = windows(run)
    assert(frames.some(f => /Sleep\s+2s/.test(f)), 'the pending Sleep call must be visible')
    const rows = history(run.paths.home)
    const results = rows.flatMap(row => Array.isArray(row.payload.content) ? row.payload.content.filter(b => b.kind === 'tool-result').map(block => ({ ...block, at: Date.parse(row.occurredAt) })) : [])
    assert(!JSON.stringify(results).includes(MISSING), 'a live batch must never acquire an ended-call row on disk (a call still running was settled as ended: see settleToolUsesOfEndedRun in src/engine/messages/apiFilters.ts, which should only settle calls of a run that really ended)')
    const bodies = ids.map(id => {
      const own = results.filter(b => b.callId === id)
      assert.equal(own.length, 1, `${id} must have its own single recorded result (found ${own.length}; check where the tool result is written to the session history in the daemon-hosted turn)`)
      return JSON.stringify(own[0]!.body)
    })
    assert(bodies[0]!.includes('KNOWN-RESULT') && bodies[1]!.includes('waited') && /slept|woke|waited/i.test(bodies[2]!), `wrong batch results: ${bodies.join(', ')} (each call must keep its own result: Read the file text, Bash waited, Sleep done; a result landed on the wrong call or was replaced by an ended-run row, see settleToolUsesOfEndedRun in src/engine/messages/apiFilters.ts)`)
    assert(frames.some(f => f.includes(END)), 'the batch must finish in the window')
    const started = run.fixture.toolEmits.find(e => e.id === ids[1])!.at
    const ended = results.find(b => b.callId === ids[1])!.at
    if (leg === 'queued') {
      const enter = run.sendLog.at(-1)!.sent
      assert(enter >= started && enter < ended, `the second Enter must land inside the slow call: ${started} <= ${enter} < ${ended} (the Bash sleep ended outside the Enter window; a timing change in the fixture or a slow start, rerun before changing code)`)
      assert(frames.some(f => f.includes('queued') && f.includes(QUEUED)), 'the window must show the queued input')
    }
    if (leg === 'crew') {
      const notices = run.fixture.requests.filter(r => r.raw.includes('<task-notification>') && r.raw.includes(CHILD_REPLY))
      assert(notices.length > 0, 'a real crewmate completion must reach the parent (no request to the model carried a task-notification with the child reply; check how a background Crewmate completion is delivered to the parent turn, src/tools/crewmate/run/crewmateEnd.ts)')
    }
    const falseFrames = frames.filter(f => f.includes(MISSING)).length
    console.log(`${leg}: ${falseFrames}/${frames.length} delivered frames said the run ended; 3/3 real results, none missing on disk`)
    return falseFrames
  } finally {
    run.cleanup()
  }
}

let failures = 0
for (const leg of ['plain', 'queued', 'crew'] as const) failures += await measure(leg)
assert.equal(failures, 0, 'do not start a new turn when delivering another input to a turn still running (daemon/roster.ts)')

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-notice-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { isOutcome } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5'
const FABLE_WORD = 'Fable 5.1'
const OPUS_WORD = 'Opus 5'
const RECEIPT_MARK = 'stay out of the requests to'
const DEBUG_MARK = 'preserved thinking: Preserved thinking'

interface Record_ {
  line: number
  ordinal: number
  at: string
  kind: string
  content: string
  model: string
  metaKind: string
  operation: string
}

function readRecords(home: string, sessionId: string): Record_[] {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name === `${sessionId}.jsonl`) out.push(full)
    }
    return out
  }
  const root = join(home, '.mercury', 'projects')
  const files = existsSync(root) ? walk(root) : []
  const records: Record_[] = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (line.trim() === '') continue
      let row: { creationOrdinal?: string; occurredAt?: string; payload?: { kind?: string; content?: unknown; model?: string; metaKind?: string; fields?: { operation?: string; content?: unknown } } }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const payload = row.payload ?? {}
      const content = typeof payload.content === 'string' ? payload.content : Array.isArray(payload.content) ? j(payload.content) : typeof payload.fields?.content === 'string' ? payload.fields.content : ''
      records.push({
        line: index + 1,
        ordinal: Number(row.creationOrdinal ?? -1),
        at: String(row.occurredAt ?? ''),
        kind: String(payload.kind ?? ''),
        content,
        model: String(payload.model ?? ''),
        metaKind: String(payload.metaKind ?? ''),
        operation: String(payload.fields?.operation ?? ''),
      })
    }
  }
  return records
}

const receiptsOf = (records: Record_[]): Record_[] => records.filter(r => r.kind === 'notice' && r.content.includes(RECEIPT_MARK))
const promptOf = (records: Record_[], prompt: string): Record_ | undefined => records.find(r => r.kind === 'input' && r.content === prompt)
const enqueueOf = (records: Record_[], prompt: string): Record_ | undefined => records.find(r => r.kind === 'session-meta' && r.metaKind === 'queue-operation' && r.operation === 'enqueue' && r.content.includes(prompt))
const firstOutputAfter = (records: Record_[], from: Record_ | undefined): Record_ | undefined => (from === undefined ? undefined : records.find(r => r.kind === 'output' && r.line > from.line))
const describe = (r: Record_ | undefined): string => (r === undefined ? 'absent' : `line ${r.line} ord ${r.ordinal} ${r.at.slice(11, 23)} ${r.kind}${r.metaKind ? '/' + r.metaKind : ''} ${r.content.slice(0, 60)}`)
const debugReceipts = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(l => l.includes(DEBUG_MARK))
  } catch {
    return []
  }
}

section('§0 the receipt law (pure) — a switch is the row that last answered coming from another model; a resume on the same model is no switch')
{
  const { modelSwitchReceipt, lastServedRow } = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
  const signature = 'sig'
  const think = (text: string) => ({ type: 'thinking' as const, thinking: text, signature })
  const text = (t: string) => ({ type: 'text' as const, text: t, citations: [] })
  const reply = (model: string, id: string) => ({ type: 'assistant' as const, uuid: id, timestamp: '2026-10-09T00:00:00.000Z', message: { id, model, role: 'assistant' as const, type: 'message' as const, content: [think(`${model} ${id}`), text('done')], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const user = (id: string) => ({ type: 'user' as const, uuid: id, timestamp: '2026-10-09T00:00:00.000Z', message: { role: 'user' as const, content: `prompt ${id}` } })
  const synthetic = (id: string) => ({ ...reply('<synthetic>', id), isApiErrorMessage: true })
  const history = [user('u1'), reply(FABLE, 'f1'), user('u2'), reply(FABLE, 'f2'), user('u3')] as never[]
  const atSwitch = modelSwitchReceipt('main', history, OPUS)
  check('the first request after the switch earns the receipt, naming the writer and the model the request carries', atSwitch !== null && atSwitch.text === `Preserved thinking: 2 thinking blocks written by ${FABLE_WORD} stay out of the requests to ${OPUS_WORD} (the conversation switched models); the model re-plans without them.`, j(atSwitch))
  check('the key names the owner, the row that last answered and the model', atSwitch !== null && atSwitch.key === `main|f2|${OPUS}`, j(atSwitch?.key))
  const answered = [...history, reply(OPUS, 'o1'), user('u4')] as never[]
  check('once the new model has answered, the next request to it paints nothing (the resume, the daemon respawn, the next turn)', modelSwitchReceipt('main', answered, OPUS) === null)
  const back = modelSwitchReceipt('main', answered, FABLE)
  check('a switch back is a real switch: the receipt names the other writer and the returning model', back !== null && back.text.includes(`1 thinking block written by ${OPUS_WORD} stay out of the requests to ${FABLE_WORD}`) && back.key === `main|o1|${FABLE}`, j(back))
  const errored = [...history, synthetic('e1'), user('u4')] as never[]
  const afterError = modelSwitchReceipt('main', errored, OPUS)
  check('a synthetic row (an API error stand-in) is not an answer: the switch still stands and its key is unchanged', afterError !== null && afterError.key === `main|f2|${OPUS}`, j(afterError))
  check('no answer yet ⇒ no switch, whatever the model', modelSwitchReceipt('main', [user('u1')] as never[], OPUS) === null && lastServedRow([user('u1'), synthetic('e1')] as never[]) === null)
  check('the same model under another spelling is no switch', modelSwitchReceipt('main', history, `${FABLE}[1m]`) === null)
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi): Arena {
      const home = mkdtempSync(join(tmpdir(), 'switch-notice-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'switch-notice-cwd-'))
      mkdirSync(join(home, '.mercury'), { recursive: true })
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.mercury'),
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_THINKING_BINDING: 'drop_block',
        },
      }
    }
    function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    }
    type Body = { model?: string; messages?: Array<{ role?: string; content?: unknown }> }
    const thinkingBlocksOf = (body: Body): number => (body.messages ?? []).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).filter(b => b.type === 'thinking').length : 0), 0)

    section('§1 the daemon seat\'s road — one process, six turns, Fable 5.1 → Opus 5 → Fable 5.1: each receipt lands in the session file inside the turn whose request it rode, between that prompt and its answer, naming the model the wire carried')
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'SN-F1', thinking: 'fable one', model: FABLE },
      { kind: 'text', text: 'SN-F2', thinking: 'fable two', model: FABLE },
      { kind: 'text', text: 'SN-F3', thinking: 'fable three', model: FABLE },
      { kind: 'text', text: 'SN-O1', thinking: 'opus one', model: OPUS },
      { kind: 'text', text: 'SN-O2', thinking: 'opus two', model: OPUS },
      { kind: 'text', text: 'SN-F4', thinking: 'fable four', model: FABLE },
      { kind: 'text', text: 'SN-F5', thinking: 'fable five', model: FABLE },
      { kind: 'text', text: 'SN-O3', thinking: 'opus three', model: OPUS },
    ]
    const fixture = await startFixtureApi(turns, { bindingCheck: true, apiChecks: true })
    const arena = makeArena(fixture)
    const SID = 'c0ffee00-0000-4000-8000-00000000a1c3'
    const debugSeat = join(arena.home, 'seat.debug.log')
    const P = ['first on fable', 'second on fable', 'third on fable', 'now on opus', 'again on opus', 'back on fable']
    let seatStdout = ''
    const host = hostRunner({
      node: nodeBin,
      dist: DIST,
      argv: ['--model', FABLE, '--allowed-tools', 'Read', '--session-id', SID, '--log-file', debugSeat],
      cwd: arena.cwd,
      env: arena.env,
      home: arena.env.MERCURY_CONFIG_DIR,
      raw: text => {
        seatStdout += text
      },
    })
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 150_000)
    const switchErrors: string[] = []
    const turn = async (prompt: string, switchTo?: string): Promise<void> => {
      if (switchTo !== undefined) {
        await host.request('session/set_model', { model: switchTo }).catch((error: unknown) => {
          switchErrors.push(error instanceof Error ? error.message : String(error))
        })
      }
      const outcomes = host.rows.filter(isOutcome).length
      await host.prompt(prompt)
      await host.waitFor(`outcome of "${prompt}"`, () => host.rows.filter(isOutcome).length > outcomes, 60_000)
    }
    let seatError = ''
    try {
      await host.initialize({})
      await turn(P[0]!)
      await turn(P[1]!)
      await turn(P[2]!)
      await turn(P[3]!, OPUS)
      await turn(P[4]!)
      await turn(P[5]!, FABLE)
    } catch (error) {
      seatError = error instanceof Error ? error.message : String(error)
    }
    host.end()
    const seatExit = await host.exited
    clearTimeout(killer)
    host.peer.close('the turns ended')
    const seat = { exit: seatExit, stdout: seatStdout, stderr: host.stderr() }
    check('§1 the six-turn process exits 0, every switch applied', seat.exit === 0 && seatError === '' && switchErrors.length === 0, `exit=${seat.exit} ${seatError} ${j(switchErrors)} stderr=${seat.stderr.slice(0, 400)}`)
    check('§1 every turn answered', ['SN-F1', 'SN-F2', 'SN-F3', 'SN-O1', 'SN-O2', 'SN-F4'].every(t => seat.stdout.includes(t)), seat.stdout.slice(0, 300))
    const reqs = fixture.messageRequests()
    const bodies = reqs.map(q => q.body as Body)
    check('§1 six requests on the wire, the model following the switch: fable · fable · fable · opus · opus · fable', j(bodies.map(b => b.model)) === j([FABLE, FABLE, FABLE, OPUS, OPUS, FABLE]), j(bodies.map(b => b.model)))
    check('§1 the first Opus request carries none of the Fable thinking; the return to Fable carries none of the Opus thinking and replays the three Fable blocks', bodies[3] !== undefined && thinkingBlocksOf(bodies[3]) === 0 && bodies[5] !== undefined && thinkingBlocksOf(bodies[5]) === 3, j(bodies.map(b => thinkingBlocksOf(b))))
    check('§1 the fixture refused nothing and dropped nothing', fixture.refusals.length === 0 && !seat.stdout.includes('thinking_dropped'), j(fixture.refusals))
    const seatReceipts = debugReceipts(debugSeat)
    check('§1 the debug log carries exactly two receipts, one per real switch', seatReceipts.length === 2, j(seatReceipts))
    const records = readRecords(arena.home, SID)
    const receipts = receiptsOf(records)
    check('§1 RED ON THE BASE: the session file holds exactly two switch receipts (the base holds the first one — written when the next turn began — and loses the second with the process)', receipts.length === 2, `${receipts.length}: ${receipts.map(describe).join(' | ')}`)
    const toOpus = receipts.find(r => r.content.includes(`requests to ${OPUS_WORD}`))
    const toFable = receipts.find(r => r.content.includes(`requests to ${FABLE_WORD}`))
    check(`§1 the first receipt names the three Fable blocks and the model the wire carried (${OPUS_WORD})`, toOpus !== undefined && toOpus.content.includes(`3 thinking blocks written by ${FABLE_WORD} stay out of the requests to ${OPUS_WORD}`), describe(toOpus))
    check(`§1 the second names the two Opus blocks and the return (${FABLE_WORD})`, toFable !== undefined && toFable.content.includes(`2 thinking blocks written by ${OPUS_WORD} stay out of the requests to ${FABLE_WORD}`), describe(toFable))
    const legs: Array<{ label: string; receipt: Record_ | undefined; prompt: string }> = [
      { label: 'the switch to Opus', receipt: toOpus, prompt: P[3]! },
      { label: 'the return to Fable', receipt: toFable, prompt: P[5]! },
    ]
    for (const leg of legs) {
      const prompt = promptOf(records, leg.prompt)
      const answer = firstOutputAfter(records, prompt)
      const r = leg.receipt
      check(`§1 RED ON THE BASE: ${leg.label} — the receipt sits in the file between its own prompt and that turn's first answer (file order)`, prompt !== undefined && answer !== undefined && r !== undefined && prompt.line < r.line && r.line < answer.line, `prompt ${describe(prompt)} · receipt ${describe(r)} · answer ${describe(answer)}`)
      check(`§1 ${leg.label} — the receipt's stamp sits between the prompt's and the answer's`, prompt !== undefined && answer !== undefined && r !== undefined && prompt.at <= r.at && r.at <= answer.at, `${prompt?.at} ≤ ${r?.at} ≤ ${answer?.at}`)
      check(`§1 ${leg.label} — the receipt's ordinal follows the prompt's and precedes the answer's (written in the turn, never re-recorded later)`, prompt !== undefined && answer !== undefined && r !== undefined && prompt.ordinal < r.ordinal && r.ordinal < answer.ordinal, `${prompt?.ordinal} < ${r?.ordinal} < ${answer?.ordinal}`)
    }
    section('§2 the resume — a new process on the model that last answered paints nothing (the owner\'s 13:54 sighting); a resume that switches paints once, in the file, in its turn')
    const debug7 = join(arena.home, 'resume-same.debug.log')
    const r7 = await run(arena, ['run', 'still on fable after a resume', '--model', FABLE, '--allowed-tools', 'Read', '--resume', SID, '--log-file', debug7])
    check('§2 the resumed turn on Fable exits 0 and is answered', r7.exit === 0 && r7.stdout.includes('SN-F5'), `exit=${r7.exit} ${r7.stderr.slice(0, 200)}`)
    check('§2 RED ON THE BASE: the resumed process paints NO receipt — the switch was announced once, when it happened', debugReceipts(debug7).length === 0, j(debugReceipts(debug7)))
    const after7 = receiptsOf(readRecords(arena.home, SID))
    check('§2 RED ON THE BASE: the session file still holds exactly the two receipts', after7.length === 2, `${after7.length}: ${after7.map(describe).join(' | ')}`)
    const debug8 = join(arena.home, 'resume-switch.debug.log')
    const r8 = await run(arena, ['run', 'opus once more after a resume', '--model', OPUS, '--allowed-tools', 'Read', '--resume', SID, '--log-file', debug8])
    check('§2 the resumed turn that switches to Opus exits 0 and is answered', r8.exit === 0 && r8.stdout.includes('SN-O3'), `exit=${r8.exit} ${r8.stderr.slice(0, 200)}`)
    const receipts8 = debugReceipts(debug8)
    check(`§2 a real switch across a resume paints exactly one receipt, naming the Fable blocks and ${OPUS_WORD}`, receipts8.length === 1 && receipts8[0]!.includes(`written by ${FABLE_WORD} stay out of the requests to ${OPUS_WORD}`), j(receipts8))
    const records8 = readRecords(arena.home, SID)
    const after8 = receiptsOf(records8)
    const prompt8 = promptOf(records8, 'opus once more after a resume')
    const answer8 = firstOutputAfter(records8, prompt8)
    const third = after8.find(r => prompt8 !== undefined && r.line > prompt8.line)
    check('§2 RED ON THE BASE: the one-shot road writes its receipt too — three in the file, the third between its prompt and its answer', after8.length === 3 && third !== undefined && prompt8 !== undefined && answer8 !== undefined && prompt8.line < third.line && third.line < answer8.line, `${after8.length}: ${after8.map(describe).join(' | ')} · prompt ${describe(prompt8)} · answer ${describe(answer8)}`)
    const wire = fixture.messageRequests().map(q => (q.body as Body).model)
    check('§2 the wire carried fable for the same-model resume and opus for the switching one', j(wire.slice(6)) === j([FABLE, OPUS]), j(wire))
    await fixture.close()
  }
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`SWITCH-NOTICE-LANDS: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`SWITCH-NOTICE-LANDS: all ${checks} checks passed`)
process.exit(0)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP', 'MERCURY_SPAWNED_ENV']) {
  delete process.env[ambient]
}
const home = mkdtempSync(join(tmpdir(), 'seat-live-lookup-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'seat-live-lookup-cwd-')))
mkdirSync(join(home, '.mercury'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(home, '.mercury')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { answerOf, isOutcome } from '../lib/rows.ts'
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
const SONNET = 'claude-sonnet-5-5'
const SID = 'c0ffee00-0000-4000-8000-00000000a1e6'
const ISO_CLOCK = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/
const LOCAL_CLOCK = /^\s{2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)\s{2}/

const pad = (n: number): string => String(n).padStart(2, '0')
function localWords(iso: string): string {
  const d = new Date(iso)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
}

const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown; content?: unknown }>) {
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    if (block.type === 'tool_result') out.push(...textsOf(block.content))
  }
  return out
}

section('§1 the seat page speaks local time, names /model, and the Read tool points the seat at it')
{
  const seat = await import('../../src/services/resources/adapters/seat.ts')
  const startAt = '2026-10-12T09:00:04.000Z'
  const switchAt = '2026-10-12T09:04:06.193Z'
  const text = seat.seatReferenceText({
    model: SONNET,
    effort: 'high',
    posture: seat.seatPostureWords('default'),
    engines: [
      { model: FABLE, at: startAt },
      { model: SONNET, at: switchAt },
    ],
  })
  const lines = text.split('\n')
  const engineRows = lines.filter(line => LOCAL_CLOCK.test(line))
  check('each engine row carries the ledger time in LOCAL time with the zone in brackets (RED on the base: the raw ISO UTC string)', engineRows.length === 2 && !ISO_CLOCK.test(text), j(lines.filter(line => line.includes(FABLE) || line.includes(SONNET))))
  check('…the start row and the switch row read the clock of this machine, not UTC', text.includes(`  ${localWords(startAt)}  ${FABLE}`) && text.includes(`  ${localWords(switchAt)}  ${SONNET}`), text)
  check('the engines heading says the times are local and that the first row is the start', text.includes('local time, the zone in brackets') && text.includes('the first row is the start'), lines.find(line => line.startsWith('engines this session')) ?? '')
  check('the page says in its own words where the switch is made: /model for the model, /effort for the effort (RED on the base: no command named)', text.includes('switches the model with /model') && text.includes('the effort with /effort'), text)
  check('…and that it is read live, so a switch already shows', text.includes('read live'), text)
  check('the evidence sentence rules out an earlier reply, an environment variable (MERCURY_MODEL) and an earlier copy of the ledger', text.includes('an earlier reply') && text.includes('MERCURY_MODEL') && text.includes('copy of the ledger'), text)
  check('the live model still leads the page with its name', lines[0] === `model this turn runs on: ${SONNET} (Sonnet 5.5)`, lines[0])

  const { readTargetPromptLines } = await import('../../src/tools/FileReadTool/readTarget.ts')
  const readLines = readTargetPromptLines()
  check('the Read tool (always loaded) tells the seat that mercury://seat is its own reference and what it holds (RED on the base: only the Inspect prompt did, and Inspect is deferred)', readLines.includes('mercury://seat is this seat\'s own reference') && readLines.includes('the model this turn runs on'), readLines)
  check('…and to answer "which model" from it, never from an earlier reply, an environment variable or the ledger file', readLines.includes('asked which model runs you, read it and answer from it') && readLines.includes('an environment variable') && readLines.includes('the ledger file'), readLines)
  const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
  check('the Inspect tool is deferred, which is why the pointer must ride Read', (InspectTool as { shouldDefer?: boolean }).shouldDefer === true)
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    section('§2 the session runner — two switches, a seat read after each: the live engine, every switch in local time, and the session stamp follows the switch')
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'SL-F1', model: FABLE },
      { kind: 'tool_use', name: 'Read', input: { file_path: 'mercury://seat' }, id: 'toolu_seat_o1', model: OPUS },
      { kind: 'text', text: 'SL-O1', model: OPUS },
      { kind: 'tool_use', name: 'Bash', input: { command: 'echo "stamp=$MERCURY_MODEL"', inherit_session_env: true }, id: 'toolu_stamp_s1', model: SONNET },
      { kind: 'tool_use', name: 'Read', input: { file_path: 'mercury://seat' }, id: 'toolu_seat_s1', model: SONNET },
      { kind: 'text', text: 'SL-S1', model: SONNET },
    ]
    const fixture = await startFixtureApi(turns, { apiChecks: true })
    const { stampSpawnReceipt } = await import('../../src/substrate/envStamps.ts')
    const env: Record<string, string | undefined> = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_MODEL: FABLE,
    }
    stampSpawnReceipt(env, ['MERCURY_MODEL'])
    const host = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', FABLE, '--allowed-tools', 'Read,Bash', '--session-id', SID], cwd, env, home: env.MERCURY_CONFIG_DIR })
    host.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'allow' }))
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 150_000)
    let turnsSent = 0
    const turn = async (prompt: string, marker: string): Promise<void> => {
      const ordinal = ++turnsSent
      await host.prompt(prompt)
      await host.waitFor(`turn ${ordinal} ("${prompt}") settled on the fixture's ${marker}`, row => isOutcome(row) && row.turn === ordinal && answerOf(row).includes(marker), 60_000)
    }
    let error = ''
    try {
      await host.initialize({})
      await turn('first on fable', 'SL-F1')
      await host.request('session/set_model', { model: OPUS })
      await turn('which model are you running on?', 'SL-O1')
      await host.request('session/set_model', { model: SONNET })
      await turn('and now?', 'SL-S1')
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    check('the three turns settled (two through a Read of mercury://seat, one through a Bash echo of the stamp)', error === '', error || host.stderr().slice(-800))
    const requests = fixture.messageRequests().map(r => r.body as { model?: string; messages?: Array<{ content?: unknown }> })
    const seatTextsIn = (index: number): string =>
      ((requests[index]?.messages ?? [])
        .flatMap(m => textsOf(m.content))
        .filter(text => text.includes('model this turn runs on'))
        .at(-1) ?? '')
        .split('\n')
        .map(line => line.replace(/^\d+\t/, ''))
        .join('\n')
    const firstSeat = seatTextsIn(2)
    check('after the first switch the request dispatches on the new model', requests[2]?.model === OPUS, j(requests.map(r => r.model)))
    check('the seat page read after the first switch names the LIVE engine', firstSeat.includes(`model this turn runs on: ${OPUS}`) && !firstSeat.includes(`model this turn runs on: ${FABLE}`), firstSeat)
    const firstRows = firstSeat.split('\n').filter(line => LOCAL_CLOCK.test(line))
    check('…and lists the start engine and the switch, each in local time with the zone (RED on the base: ISO UTC)', firstRows.length === 2 && firstRows[0]!.includes(FABLE) && firstRows[1]!.includes(OPUS) && !ISO_CLOCK.test(firstSeat), firstSeat)
    check('…and names /model as the place the switch is made', firstSeat.includes('/model'), firstSeat)
    const stampTexts = (requests[4]?.messages ?? []).flatMap(m => textsOf(m.content)).filter(text => text.includes('stamp='))
    check('the session stamp a Bash call inherits names the engine running NOW, not the one the session started on (RED on the base: the start model for the session\'s life)', stampTexts.some(text => text.includes(`stamp=${SONNET}`)) && !stampTexts.some(text => text.includes(`stamp=${FABLE}`)), j(stampTexts))
    const secondSeat = seatTextsIn(5)
    check('the seat page read after the second switch names the live engine again', secondSeat.includes(`model this turn runs on: ${SONNET}`), secondSeat)
    const secondRows = secondSeat.split('\n').filter(line => LOCAL_CLOCK.test(line))
    check('…and lists all three engines in order, the start and both switches, in local time', secondRows.length === 3 && secondRows[0]!.includes(FABLE) && secondRows[1]!.includes(OPUS) && secondRows[2]!.includes(SONNET), secondSeat)
    const firstSystem = requests[0]?.messages === undefined ? '' : JSON.stringify((requests[0] as { system?: unknown }).system ?? '')
    check('the system prompt carries no engine stamp for the model to quote', !firstSystem.includes('the model you run through Mercury is'), firstSystem.slice(0, 200))
    clearTimeout(killer)
    await host.stop(5_000).catch(() => null)
    await fixture.close()
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)

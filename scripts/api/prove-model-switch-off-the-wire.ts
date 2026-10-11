#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'model-switch-wire-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

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
const CAVEAT_MARK = '<local-command-caveat>'
const MODEL_COMMAND_MARK = '<command-name>/model</command-name>'
const STDOUT_MARK = 'Set model to'

const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []))
}
const wireTexts = (messages: ReadonlyArray<{ message: { content: unknown } }>): string[] => messages.flatMap(m => textsOf(m.message.content))
const has = (texts: string[], needle: string): boolean => texts.some(text => text.includes(needle))

section('§1 the wire plan — the /model rows are the operator\'s record, never the model\'s view; a caveat with no rows under it never leaves')
{
  const { createModelSwitchBreadcrumbs, createSyntheticUserCaveatMessage, createUserMessage, formatCommandInputTags } = await import('../../src/utils/messages/factories.ts')
  const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')
  const prompt = (text: string) => createUserMessage({ content: text, permissionMode: 'default' })
  const reply = (id: string, text: string) => ({ type: 'assistant' as const, uuid: id, timestamp: '2026-10-11T00:00:00.000Z', message: { id, model: FABLE, role: 'assistant' as const, type: 'message' as const, content: [{ type: 'text' as const, text, citations: [] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const rows = createModelSwitchBreadcrumbs(OPUS, 'Opus 5')
  check('the three /model rows are born as the transcript\'s own (isVirtual) — the caveat, the command row and the stdout row', rows.length === 3 && rows.every(row => row.isVirtual === true), j(rows.map(row => [row.isVirtual, String(row.message.content).slice(0, 40)])))
  check('the rows still read as the /model record for the operator (the command row and the stdout row carry their words)', String(rows[1]!.message.content).includes(MODEL_COMMAND_MARK) && String(rows[2]!.message.content).includes(`${STDOUT_MARK} Opus 5`), j(rows.map(row => row.message.content)))
  for (const geometry of ['anthropic', 'family'] as const) {
    const conversation = [prompt('first'), reply('a1', 'one'), ...rows, prompt('second')] as never[]
    const sent = wireTexts(requestConversationPlan(conversation, [], geometry).messages)
    check(`${geometry}: the request after a switch carries no caveat, no /model command row and no "Set model to" (RED on the base: all three rode)`, !sent.some(text => text.includes(CAVEAT_MARK) || text.includes(MODEL_COMMAND_MARK) || text.includes(STDOUT_MARK)), j(sent))
    check(`${geometry}: the operator's words are untouched around the gap`, has(sent, 'first') && has(sent, 'second'), j(sent))
  }
  const caveat = () => createSyntheticUserCaveatMessage()
  const helpRow = createUserMessage({ content: formatCommandInputTags('help', '') })
  const helpOut = createUserMessage({ content: '<local-command-stdout>the help text</local-command-stdout>' })
  for (const geometry of ['anthropic', 'family'] as const) {
    const orphan = [prompt('first'), reply('a1', 'one'), caveat(), prompt('what are you?')] as never[]
    const orphanSent = wireTexts(requestConversationPlan(orphan, [], geometry).messages)
    check(`${geometry}: a caveat followed by the operator's next prompt (the rows under it rewound away) leaves the view (RED on the base: it stood over the question)`, !has(orphanSent, CAVEAT_MARK) && has(orphanSent, 'what are you?'), j(orphanSent))
    const kept = [prompt('first'), reply('a1', 'one'), caveat(), helpRow, helpOut, prompt('next')] as never[]
    const keptSent = wireTexts(requestConversationPlan(kept, [], geometry).messages)
    check(`${geometry}: a caveat with its command rows under it stands as before, the rows with it`, keptSent.filter(text => text.includes(CAVEAT_MARK)).length === 1 && has(keptSent, '<command-name>/help</command-name>') && has(keptSent, 'the help text'), j(keptSent))
    const refusal = [prompt('first'), reply('a1', 'one'), caveat(), createUserMessage({ content: 'Unknown skill: foo' }), prompt('next')] as never[]
    const refusalSent = wireTexts(requestConversationPlan(refusal, [], geometry).messages)
    check(`${geometry}: a caveat over a command refusal line stands (the line is a record too)`, refusalSent.filter(text => text.includes(CAVEAT_MARK)).length === 1 && has(refusalSent, 'Unknown skill: foo'), j(refusalSent))
    const tail = [prompt('first'), reply('a1', 'one'), caveat()] as never[]
    check(`${geometry}: a caveat as the last row has nothing under it and leaves`, !wireTexts(requestConversationPlan(tail, [], geometry).messages).some(text => text.includes(CAVEAT_MARK)))
    const beforeAnswer = [prompt('first'), caveat(), reply('a1', 'one'), prompt('next')] as never[]
    check(`${geometry}: a caveat followed by an answer has nothing under it and leaves`, !wireTexts(requestConversationPlan(beforeAnswer, [], geometry).messages).some(text => text.includes(CAVEAT_MARK)))
    const doubled = [prompt('first'), reply('a1', 'one'), caveat(), caveat(), helpRow, helpOut, prompt('next')] as never[]
    check(`${geometry}: of two caveats in a row only the one over the rows stands`, wireTexts(requestConversationPlan(doubled, [], geometry).messages).filter(text => text.includes(CAVEAT_MARK)).length === 1)
  }
  const untouched = [prompt('first'), reply('a1', 'one'), caveat(), helpRow, helpOut, prompt('next')] as never[]
  const plan = (await import('../../src/utils/messages/apiPlan.ts')) as { withoutOrphanCaveats?: (rows: unknown[]) => unknown[] }
  check('a view with no orphan comes back as the same array (render layers bail on identity)', typeof plan.withoutOrphanCaveats === 'function' && plan.withoutOrphanCaveats(untouched) === untouched)
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    section('§2 the session runner — /model through session/set_model: the next request carries none of the three rows; the session file keeps them for the operator')
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'MS-F1', model: FABLE },
      { kind: 'text', text: 'MS-O1', model: OPUS },
      { kind: 'text', text: 'MS-O2', model: OPUS },
    ]
    const fixture = await startFixtureApi(turns, { apiChecks: true })
    const home = mkdtempSync(join(tmpdir(), 'model-switch-wire-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'model-switch-wire-cwd-'))
    mkdirSync(join(home, '.mercury'), { recursive: true })
    const env = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
    }
    const SID = 'c0ffee00-0000-4000-8000-00000000a1d4'
    const host = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', FABLE, '--allowed-tools', 'Read', '--session-id', SID], cwd, env, home: env.MERCURY_CONFIG_DIR })
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
    let turnsSent = 0
    const turn = async (prompt: string, marker: string): Promise<void> => {
      const ordinal = ++turnsSent
      await host.prompt(prompt)
      await host.waitFor(`turn ${ordinal} ("${prompt}") settled on the fixture's ${marker}`, row => isOutcome(row) && row.turn === ordinal && answerOf(row).includes(marker), 60_000)
    }
    let seatError = ''
    let switchAnswer: unknown = null
    try {
      await host.initialize({})
      await turn('first on fable', 'MS-F1')
      switchAnswer = await host.request('session/set_model', { model: OPUS })
      await turn('what are you running on now?', 'MS-O1')
    } catch (error) {
      seatError = error instanceof Error ? error.message : String(error)
    }
    check('the two turns settled and the switch verb answered', seatError === '' && switchAnswer !== null && (switchAnswer as { model?: string }).model === OPUS, seatError || j(switchAnswer))
    const requests = fixture.messageRequests()
    const second = requests[1]?.body as { model?: string; messages?: Array<{ role?: string; content?: unknown }> } | undefined
    const secondTexts = (second?.messages ?? []).flatMap(m => textsOf(m.content))
    check('the request after the switch dispatches on the new model', second?.model === OPUS, j(second?.model))
    check('that request carries no local-command caveat, no /model command row and no "Set model to" (RED on the base: the three rows rode in it)', !secondTexts.some(text => text.includes(CAVEAT_MARK) || text.includes(MODEL_COMMAND_MARK) || text.includes(STDOUT_MARK)), j(secondTexts))
    check('the operator\'s question rides whole', secondTexts.some(text => text.includes('what are you running on now?')), j(secondTexts))
    const commandRows = host.rows.filter(row => row.type === 'command_output' && typeof row.text === 'string' && row.text.includes(STDOUT_MARK))
    check('the host still receives the /model receipt as a command-output row (the operator sees the switch)', commandRows.length === 1, j(commandRows.map(row => row.text)))
    const walk = (dir: string): string[] => {
      const out: string[] = []
      if (!existsSync(dir)) return out
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === `${SID}.jsonl`) out.push(full)
      }
      return out
    }
    const files = walk(join(home, '.mercury', 'projects'))
    const recorded = files.flatMap(file => readFileSync(file, 'utf8').split('\n'))
    const recordedCommand = recorded.filter(line => line.includes(MODEL_COMMAND_MARK))
    const recordedStdout = recorded.filter(line => line.includes(STDOUT_MARK))
    const recordedCaveat = recorded.filter(line => line.includes(CAVEAT_MARK))
    check('the session file keeps the three rows as the operator\'s record', files.length === 1 && recordedCommand.length === 1 && recordedStdout.length === 1 && recordedCaveat.length === 1, j({ files, command: recordedCommand.length, stdout: recordedStdout.length, caveat: recordedCaveat.length }))
    check('each recorded row is marked as the transcript\'s own (isVirtual) so a resume keeps it off the wire too', [...recordedCommand, ...recordedStdout, ...recordedCaveat].every(line => /"isVirtual":\s*true/.test(line)), recordedCommand[0]?.slice(0, 400))
    clearTimeout(killer)
    await host.stop(5_000).catch(() => null)

    section('§3 the resumed session — the record comes back with the rows for the operator and still sends none of them')
    const resumed = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', OPUS, '--allowed-tools', 'Read', '--resume', SID], cwd, env, home: env.MERCURY_CONFIG_DIR })
    const resumeKiller = setTimeout(() => resumed.child.kill('SIGKILL'), 120_000)
    let resumeError = ''
    try {
      await resumed.initialize({})
      await resumed.prompt('and after the resume?')
      await resumed.waitFor('the resumed turn settled on the fixture\'s MS-O2', row => isOutcome(row) && answerOf(row).includes('MS-O2'), 60_000)
    } catch (error) {
      resumeError = error instanceof Error ? error.message : String(error)
    }
    check('the resumed runner took a turn', resumeError === '', resumeError)
    const third = fixture.messageRequests()[2]?.body as { messages?: Array<{ content?: unknown }> } | undefined
    const thirdTexts = (third?.messages ?? []).flatMap(m => textsOf(m.content))
    check('the resumed session\'s request carries the earlier turns but none of the three /model rows (RED on the base: the record dropped the mark and the rows rode again)', has(thirdTexts, 'first on fable') && has(thirdTexts, 'and after the resume?') && !thirdTexts.some(text => text.includes(CAVEAT_MARK) || text.includes(MODEL_COMMAND_MARK) || text.includes(STDOUT_MARK)), j(thirdTexts.map(text => text.slice(0, 80))))
    clearTimeout(resumeKiller)
    await resumed.stop(5_000).catch(() => null)
    await fixture.close()
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)

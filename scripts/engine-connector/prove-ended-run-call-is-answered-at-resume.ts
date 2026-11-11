#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ended-run-call-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'ended-run-call-daemon-'))
delete process.env.MERCURY_HOME

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { ENDED_RUN_TOOL_RESULT } = await import('../../src/utils/messages/rejectionText.ts')
const { buildAwayRecap } = await import('../../src/utils/cockpit/awaySummary.ts')
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.js')
const { ResumeRecapCard } = await import('../../src/components/messages/ResumeRecapCard.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
type Message = import('../../src/types/message.ts').Message

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the proof exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

type Facts = { schema: 1; sessionId: string; atMs: number; busy: boolean; runnerGeneration: number; queue: unknown[]; pendingModel: null; turnStartedAt?: number }
type Guts = { attached: boolean; tick: () => Promise<void>; paint: () => void; facts: Facts | null; factsBusy: boolean; carrierGoneAtFactsMs: number | null }

const sid = bootstrap.getSessionId()
const file = getTranscriptPathForSession(sid)
const connector = new DaemonSessionConnector({ sessionId: sid, home: dirname(file), workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
const g = connector as unknown as Guts
const write = async (rows: unknown[]): Promise<void> => {
  await recordTranscript(rows as never)
  await flushSessionStorage()
  g.attached = true
  await g.tick.call(connector)
  g.attached = false
}
const told = (facts: Facts | null, carrierGone = false): readonly Message[] => {
  g.facts = facts
  g.factsBusy = facts?.busy ?? false
  g.carrierGoneAtFactsMs = carrierGone ? (facts?.atMs ?? 0) : null
  g.paint.call(connector)
  return connector.records()
}
const facts = (busy: boolean, atMs: number, turnStartedAt?: number): Facts => ({ schema: 1, sessionId: sid, atMs, busy, runnerGeneration: 1, queue: [], pendingModel: null, ...(turnStartedAt !== undefined ? { turnStartedAt } : {}) })

const READ = 'toolu_read_note'
const BUILD = 'toolu_run_build'
type Block = { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean; id?: string }
const blocksOf = (row: Message): Block[] => (row.type === 'user' || row.type === 'assistant') && Array.isArray(row.message.content) ? (row.message.content as unknown as Block[]) : []
const answersTo = (rows: readonly Message[], id: string): Array<{ row: Message; block: Block }> => rows.flatMap(row => row.type === 'user' ? blocksOf(row).filter(block => block.type === 'tool_result' && block.tool_use_id === id).map(block => ({ row, block })) : [])
const callAt = (rows: readonly Message[], id: string): number => rows.findIndex(row => row.type === 'assistant' && blocksOf(row).some(block => block.type === 'tool_use' && block.id === id))
const tail = (rows: readonly Message[]): string => rows.slice(-3).map(row => `${row.type}[${blocksOf(row).map(block => block.type).join(',') || 'text'}]`).join(' ')

async function rowFrame(rows: readonly Message[]): Promise<string> {
  const answered = answersTo(rows, BUILD)
  const lookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(answered.map(({ row }) => [BUILD, row] as const)),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: rows.length,
    resolvedToolUseIDs: new Set(answered.length > 0 ? [BUILD] : []),
    erroredToolUseIDs: new Set(answered.some(({ block }) => block.is_error === true) ? [BUILD] : []),
    deniedToolUseIDs: new Set(),
  }
  const node = React.createElement(AppStateProvider as never, {}, React.createElement(AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id: BUILD, name: 'Bash', input: { command: 'sleep 20', description: 'Run the build' } },
    tools: [BashTool],
    verbose: false,
    inProgressToolUseIDs: new Set(),
    shouldAnimate: false,
    shouldShowDot: true,
    lookups: lookups as never,
  } as never))
  return stripAnsi(await renderToAnsiString(node as never, 92)).replace(/\s+$/, '')
}
async function cardFrame(rows: readonly Message[]): Promise<string> {
  const recap = buildAwayRecap(rows as Message[], Date.now(), null)
  if (recap === null) return '(no card)'
  const metadata = { endedOnError: recap.endedOnError, turns: recap.turns, filesTouched: recap.filesTouched, ...(recap.toolFailures > 0 ? { toolFailures: recap.toolFailures } : {}), topTools: recap.topTools }
  const node = React.createElement(AppStateProvider as never, {}, React.createElement(ResumeRecapCard as never, { metadata, addMargin: false } as never))
  return stripAnsi(await renderToAnsiString(node as never, 92)).replace(/\s+$/, '')
}
const show = (title: string, frame: string): void => console.log(`  ┌ ${title}\n${frame.split('\n').map(line => `  │ ${line}`).join('\n')}`)

section('the record of a run that ended inside a call: the note was read, the build call never returned')
await write([
  createUserMessage({ content: 'read the note, then run the build' }),
  createAssistantMessage({ content: [{ type: 'text', text: 'Reading the note, then running the build.' }, { type: 'tool_use', id: READ, name: 'Read', input: { file_path: '/tmp/note.txt' } }] as never }),
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: READ, content: 'the note says: run the build' }] as never, toolUseResult: 'the note says: run the build' as never }),
  createAssistantMessage({ content: [{ type: 'tool_use', id: BUILD, name: 'Bash', input: { command: 'sleep 20', description: 'Run the build' } }] as never }),
])
const onDisk = readFileSync(file, 'utf8')
const raw = told(null)
const replyAt = Date.parse(String((raw[callAt(raw, BUILD)] as { timestamp?: string } | undefined)?.timestamp))
check('the scene: the record holds the build call and no result for it', callAt(raw, BUILD) >= 0 && answersTo(raw, BUILD).length === 0 && answersTo(raw, READ).length === 1 && Number.isFinite(replyAt), tail(raw))

section('A — not known yet, and a turn that is live: the call paints as it does today')
{
  const unknown = told(null)
  check('A1 before the runner has said anything the call has no result painted', answersTo(unknown, BUILD).length === 0, tail(unknown))
  const live = told(facts(true, replyAt + 500, replyAt - 2_000))
  check('A2 a live turn that began before the call was written: the call is its own, and nothing is painted for it', answersTo(live, BUILD).length === 0, tail(live))
  const liveUnstamped = told(facts(true, replyAt + 500))
  check('A3 a busy runner that does not say when its turn began: nothing is painted', answersTo(liveUnstamped, BUILD).length === 0, tail(liveUnstamped))
  const stale = told(facts(false, replyAt - 2_000))
  check('A4 an idle answer older than the call (the turn that wrote it began since): nothing is painted', answersTo(stale, BUILD).length === 0, tail(stale))
  const frame = await rowFrame(live)
  show('the build call in a live turn', frame)
  check('A5 the frame of the live call is the frame of the call with nothing known', frame === await rowFrame(unknown) && frame.includes('sleep 20'), frame)
}

section('B — the runner answers idle after the call was written: its run ended, and the window paints the result the resume gives it')
{
  const before = await rowFrame(told(null))
  const beforeCard = await cardFrame(told(null))
  const idle = told(facts(false, replyAt + 1_000))
  const answers = answersTo(idle, BUILD)
  check('B1 the call is answered once', answers.length === 1, tail(idle))
  check("B2 …by the loader's own sentence, as a failed call", answers[0]?.block.content === ENDED_RUN_TOOL_RESULT && answers[0]?.block.is_error === true, JSON.stringify(answers[0]?.block))
  check('B3 …on the row right behind the call', answers.length === 1 && idle.indexOf(answers[0]!.row) === callAt(idle, BUILD) + 1, tail(idle))
  const again = told(facts(false, replyAt + 9_000))
  check('B4 a second paint gives the same row (one key, one object, no new row each paint)', answersTo(again, BUILD)[0]?.row === answers[0]?.row && answersTo(again, BUILD).length === 1, `${answers[0]?.row.uuid} then ${answersTo(again, BUILD)[0]?.row.uuid}`)
  const next = told(facts(true, replyAt + 20_000, replyAt + 15_000))
  check('B5 the next turn begins: the call of the ended run stays answered', answersTo(next, BUILD).length === 1 && answersTo(next, BUILD)[0]?.row.uuid === answers[0]?.row.uuid, tail(next))
  check('B6 the record on disk is as it was: the window wrote nothing', readFileSync(file, 'utf8') === onDisk && !onDisk.includes(ENDED_RUN_TOOL_RESULT))
  const after = await rowFrame(idle)
  show('the build call at the resume, before', before)
  show('the build call at the resume, here', after)
  check('B7 the frame: the call no longer waits', before.includes('waiting…') && !after.includes('waiting…') && after.includes('sleep 20'), JSON.stringify({ before, after }))
  const afterCard = await cardFrame(idle)
  show('the card at the resume, before', beforeCard)
  show('the card at the resume, here', afterCard)
  check('B8 the card: it says a call failed, in its own words, where it said resumed clean', beforeCard.includes('resumed clean') && afterCard.includes('resumed — 1 tool call failed') && !afterCard.includes('resumed clean'), JSON.stringify({ beforeCard, afterCard }))
}

section('C — the daemon that carried the session is gone: the same')
{
  const gone = told(null, true)
  check('C1 the call is answered once, by the same sentence', answersTo(gone, BUILD).length === 1 && answersTo(gone, BUILD)[0]?.block.content === ENDED_RUN_TOOL_RESULT, tail(gone))
}

section('D — older damage: a call left open in the middle of a conversation that went on is painted as today')
{
  await write([createUserMessage({ content: 'what happened to the build?' }), createAssistantMessage({ content: 'The build call has no recorded result.' })])
  const later = told(facts(false, Date.now() + 60_000))
  check('D1 the call stands in the transcript with no result painted for it', callAt(later, BUILD) >= 0 && answersTo(later, BUILD).length === 0, tail(later))
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'ended-run-call-is-answered-at-resume: ALL LAWS HOLD' : `ended-run-call-is-answered-at-resume: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

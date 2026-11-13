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
const { publishSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
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

type Facts = { schema: 1; sessionId: string; atMs: number; busy: boolean; runnerGeneration: number; queue: unknown[]; pendingModel: null; turnStartedAt?: number; transcriptStoreFailing?: string }
type Guts = { attached: boolean; tick: () => Promise<void>; readFacts: () => void; settleCarrierGone: () => void }

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
const answer = {
  model: { effective: 'claude-opus-4-8', setting: null },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default' as const,
  workspace: { cwd: '/tmp', originalCwd: '/tmp', projectRoot: '/tmp', instructionRoots: [] },
}
let paints = 0
connector.subscribeRecords(() => {
  paints++
})
const told = (facts: Facts): readonly Message[] => {
  publishSessionFacts({ ...answer, ...facts } as never)
  g.readFacts.call(connector)
  return connector.records()
}
const paintsOver = (reads: Facts[]): number => {
  const before = paints
  for (const read of reads) told(read)
  return paints - before
}
const carrierGone = (): readonly Message[] => {
  g.settleCarrierGone.call(connector)
  return connector.records()
}
const facts = (busy: boolean, atMs: number, turnStartedAt?: number): Facts => ({ schema: 1, sessionId: sid, atMs, busy, runnerGeneration: 1, queue: [], pendingModel: null, ...(turnStartedAt !== undefined ? { turnStartedAt } : {}) })
const moreAnswers = (count: number, from: number, turnStartedAt?: number): Facts[] => Array.from({ length: count }, (_, at) => facts(turnStartedAt !== undefined, from + (at + 1) * 400, turnStartedAt))

const READ = 'toolu_read_note'
const BUILD = 'toolu_run_build'
type Block = { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean; id?: string }
const blocksOf = (row: Message): Block[] => (row.type === 'user' || row.type === 'assistant') && Array.isArray(row.message.content) ? (row.message.content as unknown as Block[]) : []
const answersTo = (rows: readonly Message[], id: string): Array<{ row: Message; block: Block }> => rows.flatMap(row => row.type === 'user' ? blocksOf(row).filter(block => block.type === 'tool_result' && block.tool_use_id === id).map(block => ({ row, block })) : [])
const callAt = (rows: readonly Message[], id: string): number => rows.findIndex(row => row.type === 'assistant' && blocksOf(row).some(block => block.type === 'tool_use' && block.id === id))
const tail = (rows: readonly Message[]): string => rows.slice(-3).map(row => `${row.type}[${blocksOf(row).map(block => block.type).join(',') || 'text'}]`).join(' ')

async function rowFrame(rows: readonly Message[], id = BUILD, command = 'sleep 20', description = 'Run the build'): Promise<string> {
  const answered = answersTo(rows, id)
  const lookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(answered.map(({ row }) => [id, row] as const)),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: rows.length,
    resolvedToolUseIDs: new Set(answered.length > 0 ? [id] : []),
    erroredToolUseIDs: new Set(answered.some(({ block }) => block.is_error === true) ? [id] : []),
    deniedToolUseIDs: new Set(),
  }
  const node = React.createElement(AppStateProvider as never, {}, React.createElement(AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id, name: 'Bash', input: { command, description } },
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
const raw = connector.records()
const replyAt = Date.parse(String((raw[callAt(raw, BUILD)] as { timestamp?: string } | undefined)?.timestamp))
check('the scene: the record holds the build call and no result for it', callAt(raw, BUILD) >= 0 && answersTo(raw, BUILD).length === 0 && answersTo(raw, READ).length === 1 && Number.isFinite(replyAt), tail(raw))

section('A — not known yet, and a turn that is live: the call paints as it does today')
{
  g.readFacts.call(connector)
  const unknown = connector.records()
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
  const painted = paintsOver(moreAnswers(6, replyAt + 500, replyAt - 2_000))
  console.log(`  paints over six reads of a live turn's facts: ${painted}`)
  check('A6 six more answers from the runner inside that turn, each later than the last: the facts are read six times and nothing is painted', painted === 0 && answersTo(connector.records(), BUILD).length === 0, `paints=${painted}`)
}

section('B — the runner answers idle after the call was written: its run ended, and the window paints the result the resume gives it')
{
  const unknown = told(facts(false, replyAt - 2_000))
  const before = await rowFrame(unknown)
  const beforeCard = await cardFrame(unknown)
  const paintsBefore = paints
  const idle = told(facts(false, replyAt + 1_000))
  const answers = answersTo(idle, BUILD)
  console.log(`  paints at the read where the answer first moves: ${paints - paintsBefore}`)
  check('B1 the call is answered once, by the read of the facts alone', answers.length === 1 && paints - paintsBefore === 1, `${tail(idle)} paints=${paints - paintsBefore}`)
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
  const painted = paintsOver(moreAnswers(6, replyAt + 30_000))
  console.log(`  paints over six more idle reads: ${painted}`)
  check('B9 six more idle answers, each later than the last: nothing is painted again, and the call stays answered by the one row', painted === 0 && answersTo(connector.records(), BUILD)[0]?.row === answers[0]?.row, `paints=${painted}`)
}

section('C — the daemon that carried the session is gone: the same')
{
  const stale = told(facts(false, replyAt - 2_000))
  const gone = carrierGone()
  check('C1 from an answer that left the call open, the call is answered once, by the same sentence', answersTo(stale, BUILD).length === 0 && answersTo(gone, BUILD).length === 1 && answersTo(gone, BUILD)[0]?.block.content === ENDED_RUN_TOOL_RESULT, tail(gone))
}

section('D — older damage: a call left open in the middle of a conversation that went on is painted as today')
{
  await write([createUserMessage({ content: 'what happened to the build?' }), createAssistantMessage({ content: 'The build call has no recorded result.' })])
  const later = told(facts(false, Date.now() + 60_000))
  check('D1 the call stands in the transcript with no result painted for it', callAt(later, BUILD) >= 0 && answersTo(later, BUILD).length === 0, tail(later))
}

section("E — the same run goes on and its record cannot be written: a call whose result did not reach the record is not an ended run's")
{
  const DEPLOY = 'toolu_run_deploy'
  const UNWRITABLE = 'the session transcript store is unwritable (/tmp/p): EACCES: permission denied'
  const turnAt = Date.now()
  told(facts(true, turnAt, turnAt))
  await write([
    createUserMessage({ content: 'now deploy it' }),
    createAssistantMessage({ content: [{ type: 'tool_use', id: DEPLOY, name: 'Bash', input: { command: 'sleep 30', description: 'Deploy' } }] as never }),
  ])
  const open = connector.records()
  const deployAt = Date.parse(String((open[callAt(open, DEPLOY)] as { timestamp?: string } | undefined)?.timestamp))
  const deployFrame = (rows: readonly Message[]): Promise<string> => rowFrame(rows, DEPLOY, 'sleep 30', 'Deploy')
  const liveFrame = await deployFrame(open)
  const ended = told(facts(false, deployAt + 1_000))
  const endedFrame = await deployFrame(ended)
  const endedCard = await cardFrame(ended)
  check('E1 the scene: the record ends on the deploy call with no result, and an idle runner that says nothing of its store reads as an ended run, as in B', answersTo(open, DEPLOY).length === 0 && Number.isFinite(deployAt) && answersTo(ended, DEPLOY).length === 1 && answersTo(ended, DEPLOY)[0]?.block.content === ENDED_RUN_TOOL_RESULT && !endedFrame.includes('waiting…') && endedCard.includes('1 tool call failed'), tail(ended))
  const failing = told({ ...facts(false, deployAt + 1_000), transcriptStoreFailing: UNWRITABLE })
  check('E2 the same idle answer from a runner that says its record cannot be written: the run is alive, and nothing is painted for the call', answersTo(failing, DEPLOY).length === 0, JSON.stringify(answersTo(failing, DEPLOY).map(({ block }) => block.content)))
  const failingFrame = await deployFrame(failing)
  const failingCard = await cardFrame(failing)
  show('the deploy call when its run ended', endedFrame)
  show("the deploy call while its own run's record cannot be written", failingFrame)
  check('E3 …its frame is the frame of a live call', failingFrame === liveFrame && failingFrame.includes('waiting…'), JSON.stringify({ failingFrame, liveFrame }))
  show('the card when its run ended', endedCard)
  show("the card while its own run's record cannot be written", failingCard)
  check('E4 …and the card does not say a call failed', failingCard.includes('resumed clean') && !failingCard.includes('tool call failed'), failingCard)
  const nextTurn = told({ ...facts(true, deployAt + 20_000, deployAt + 15_000), transcriptStoreFailing: UNWRITABLE })
  check('E5 a turn that began after the call, the record still unwritable: nothing is painted', answersTo(nextTurn, DEPLOY).length === 0, tail(nextTurn))
  told({ ...facts(false, deployAt + 21_000), transcriptStoreFailing: UNWRITABLE })
  const gone = carrierGone()
  check('E6 the daemon that carried the session is gone, its last word the same: the run did end, and the call is answered as in C', answersTo(gone, DEPLOY).length === 1 && answersTo(gone, DEPLOY)[0]?.block.content === ENDED_RUN_TOOL_RESULT, tail(gone))
  await write([
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: DEPLOY, content: 'deployed' }] as never, toolUseResult: 'deployed' as never }),
    createAssistantMessage({ content: 'Deployed.' }),
  ])
  const written = told(facts(false, Date.now() + 60_000))
  const answers = answersTo(written, DEPLOY)
  check('E7 the store writes again and the rows it held back land: the call is answered once, by its own result', answers.length === 1 && answers[0]?.block.content === 'deployed' && answers[0]?.block.is_error !== true, JSON.stringify(answers.map(({ block }) => block)))
  const writtenFrame = await deployFrame(written)
  show('the deploy call once its result is in the record', writtenFrame)
  check('E8 …and its frame no longer waits', !writtenFrame.includes('waiting…') && writtenFrame.includes('sleep 30'), writtenFrame)
}

section('F — a session at rest: the facts are read and nothing is painted')
{
  const painted = paintsOver(moreAnswers(6, Date.now() + 60_000))
  console.log(`  paints over six idle reads of a session at rest: ${painted}`)
  check('F1 six idle answers to a session whose last turn ended whole: nothing is painted', painted === 0, `paints=${painted}`)
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'ended-run-call-is-answered-at-resume: ALL LAWS HOLD' : `ended-run-call-is-answered-at-resume: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

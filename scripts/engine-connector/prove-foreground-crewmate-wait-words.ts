#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { SessionLiveV1 } from '../../src/services/engine-connector/seatLive.ts'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const scratchHome = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'crewmate-wait-words-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
writeFileSync(join(scratchHome, 'settings.json'), JSON.stringify({ activity: { verbs: { mode: 'replace', verbs: ['Scuttling'] } } }))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.MERCURY_REDUCED_MOTION = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  const counts = await import(src('services/engine-connector/workCounts.ts'))
  const verbs = await import(src('utils/cockpit/toolVerb.ts'))
  const bar = await import(src('components/SwitchboardTagBar.tsx'))
  const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const { SpinnerWithVerb } = await import(src('components/Spinner.tsx'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default

  const t0 = 1_700_000_000_000
  const rows: WorkRowV1[] = [
    { id: 'agent-1', agentId: 'agent-1', kind: 'agent', name: 'the probe', status: 'running', startTime: t0 + 1, agentType: 'mercury-crew' },
    { id: 'shell-1', kind: 'shell', name: 'sleep 600', status: 'running', startTime: t0 + 2, command: 'sleep 600' },
  ]
  const landed: WorkRowV1[] = [{ ...rows[0]!, status: 'completed', endTime: t0 + 9 }]
  const WORDS = 'waiting on 1 crewmate · 1 shell'
  const lawful = typeof counts.delegationWaitWords === 'function' && typeof verbs.activeToolCall === 'function' && typeof verbs.isDelegationToolName === 'function'
  const wait = (tool: string | undefined, work: readonly WorkRowV1[]): string | null => (lawful ? counts.delegationWaitWords(tool, work) : null)

  const asst = (blocks: unknown[]): unknown => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
  const toolUse = (id: string, name: string, input: Record<string, unknown>): unknown => ({ type: 'tool_use', id, name, input })
  const crewmateTurn = [
    { type: 'user', message: { role: 'user', content: 'run the probe' } },
    asst([toolUse('t1', 'Read', { file_path: '/a/plan.md' })]),
    asst([toolUse('t2', 'Crewmate', { description: 'the probe', prompt: 'probe the world' })]),
  ]
  const readTurn = [{ type: 'user', message: { role: 'user', content: 'read' } }, asst([toolUse('t3', 'Read', { file_path: '/a/live.ts' })])]
  const workflowTurn = [asst([toolUse('t4', 'Workflow', { description: 'the pipeline' })])]
  const inFlight = new Set(['t2'])

  section('W1 the law: a delegation call in flight paints the roster\'s wait words; any other tool keeps its verb')
  {
    check('the pieces exist (delegationWaitWords · activeToolCall · isDelegationToolName)', lawful)
    check('a foreground Crewmate with a crewmate and a shell running reads the background wait\'s words', wait('Crewmate', rows) === WORDS, String(wait('Crewmate', rows)))
    check('a Workflow call reads its kind', wait('Workflow', [{ id: 'wf-1', kind: 'workflow', name: 'the pipeline', status: 'running', startTime: t0 }]) === 'waiting on 1 workflow', String(wait('Workflow', [])))
    check('a Read in flight paints no wait words (its verb stands)', wait('Read', rows) === null)
    check('no tool in flight paints no wait words', wait(undefined, rows) === null)
    check('a delegation call with nothing running answers null (the verb Waiting stands)', wait('Crewmate', []) === null && wait('Crewmate', landed) === null)
    check('a parked ask rides the words', wait('Crewmate', [{ ...rows[0]!, pendingAsks: 1 }]) === 'waiting on 1 crewmate · 1 ask', String(wait('Crewmate', [{ ...rows[0]!, pendingAsks: 1 }])))
    const active = lawful ? verbs.activeToolCall(crewmateTurn, inFlight) : undefined
    check('the newest in-flight call is the Crewmate (the Read before it settled)', active?.name === 'Crewmate' && active.input?.description === 'the probe', JSON.stringify(active))
    check('the delegation names: Crewmate and Workflow, nothing else', lawful && verbs.isDelegationToolName('Crewmate') && verbs.isDelegationToolName('Workflow') && !verbs.isDelegationToolName('Read') && !verbs.isDelegationToolName(undefined))
    check('the verb law is unchanged beneath it', verbs.activeToolVerb(crewmateTurn, inFlight) === 'Waiting' && verbs.activeToolVerb(readTurn, new Set(['t3'])) === 'Reading live.ts')
    check('the background wait keeps its own words', bar.waitingStatusWords({ ...IDLE_LIVE, inFlight: true, phase: 'waiting', agentsWaiting: 1, waitingOn: counts.workCounts(rows), inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: t0 }) === WORDS)
  }

  section('W2 the working strip paints both cases with the same words')
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
    }
  }
  async function paint(live: SessionLiveV1, messages: readonly unknown[], work: readonly WorkRowV1[], waitingOnCrewmates = live.phase === 'waiting'): Promise<string> {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const overrideMessage = null
    const spinner = React.createElement(SpinnerWithVerb, {
      mode: live.phase === 'tool' ? 'tool-use' : 'requesting',
      loadingStartTimeRef: { current: Date.now() - 18 * 60_000 },
      totalPausedMsRef: { current: 0 },
      pauseStartTimeRef: { current: null },
      spinnerTip: null,
      responseLengthRef: { current: 0 },
      outputTokensRef: { current: 1_700 },
      overrideColor: null,
      overrideShimmerColor: null,
      overrideMessage,
      still: false,
      spinnerSuffix: null,
      verbose: false,
      hasActiveTools: live.inProgressToolUseIDs.size > 0,
      activeToolCount: live.inProgressToolUseIDs.size,
      activeToolLabel: verbs.activeToolVerb(messages, live.inProgressToolUseIDs) ?? null,
      waitingOnCrewmates,
      leaderIsIdle: false,
    } as never)
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, spinner))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolvePaint => { painted = resolvePaint })
    const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
    instance.unmount()
    instance.cleanup()
    stream.destroy()
    return frame
  }
  const foreground: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'tool', agentsWaiting: 0, inProgressToolUseIDs: inFlight, turnStartedAtMs: t0 }
  const background: SessionLiveV1 = { ...IDLE_LIVE, inFlight: true, phase: 'waiting', agentsWaiting: 1, waitingOn: counts.workCounts(rows), inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: t0 }
  const foregroundFrame = await paint(foreground, crewmateTurn, rows)
  console.log(`  foreground crewmate: ${JSON.stringify(foregroundFrame.trim())}`)
  check('the foreground delegation reads Waiting with its output count', foregroundFrame.includes('Waiting…') && foregroundFrame.includes('↓ 1.7k') && !foregroundFrame.includes('waiting on'), foregroundFrame.trim())
  const backgroundFrame = await paint(background, crewmateTurn, rows)
  console.log(`  background wait:     ${JSON.stringify(backgroundFrame.trim())}`)
  check('the background wait reads Waiting with its existing count, not a sentence', backgroundFrame.includes('Waiting…') && backgroundFrame.includes('↓ 1.7k') && !backgroundFrame.includes('waiting on'), backgroundFrame.trim())
  const thinkingFrame = await paint(background, crewmateTurn, rows, false)
  console.log(`  the same row, thinking: ${JSON.stringify(thinkingFrame.trim())}`)
  check('the waiting row differs from the thinking row only in the verb', thinkingFrame.includes('Scuttling…') && thinkingFrame.replace('Scuttling', 'Waiting') === backgroundFrame, JSON.stringify({ thinking: thinkingFrame.trim(), waiting: backgroundFrame.trim() }))
  const bareFrame = await paint(foreground, crewmateTurn, [])
  console.log(`  nothing on the roster: ${JSON.stringify(bareFrame.trim())}`)
  check('a delegation call with no running row keeps the verb Waiting…', bareFrame.includes('Waiting…'), bareFrame.trim())
  const readFrame = await paint({ ...foreground, inProgressToolUseIDs: new Set(['t3']) }, readTurn, rows)
  console.log(`  a Read in flight:      ${JSON.stringify(readFrame.trim())}`)
  check('a Read in flight beside a running shell keeps its own verb', readFrame.includes('Reading live.ts…') && !readFrame.includes('waiting on'), readFrame.trim())
  const workflowFrame = await paint({ ...foreground, inProgressToolUseIDs: new Set(['t4']) }, workflowTurn, [{ id: 'wf-1', kind: 'workflow', name: 'the pipeline', status: 'running', startTime: t0 }])
  console.log(`  a Workflow in flight:  ${JSON.stringify(workflowFrame.trim())}`)
  check('a foreground workflow keeps its tool verb and output count', workflowFrame.includes('…') && workflowFrame.includes('↓ 1.7k') && !workflowFrame.includes('waiting on'), workflowFrame.trim())

  section('W3 the wiring: the Chat composes the words as the proof did, over the focused roster')
  {
    const repl = read('src/screens/Chat.tsx')
    const connector = read('src/services/engine-connector/daemonConnector.ts')
    check('the Chat no longer composes a duplicate delegation-wait sentence', !repl.includes('viewDelegationWait') && !repl.includes('const viewAgentWait ='))
    check('the spinner override is reserved for compaction and attention', repl.includes('viewCompacting ? FOLD_ROW_HEAD : null}'))
    check('compact attention still uses the real status facts', repl.includes('statusRowWarns(seatLive, compactSeatStatus)') && repl.includes('statusLine(seatLive, compactSeatStatus, null, true)'))
    check('a running tool keeps the tool phase in the connector (the foreground case never reads as a bare wait)', connector.includes("this.liveStateWord === 'waiting-on-agents' && this.liveState.phase !== 'tool'"))
  }

  console.log(`\n${checks} checks, ${failures} failed`)
  console.log(failures === 0 ? 'GREEN: a foreground crewmate paints the counts the background wait paints' : `RED: ${failures} check(s) failed`)
}

try {
  await main()
} finally {
  rmSync(scratchHome, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'loop-guard-chant-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-chant-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'loop-guard-chant-teams-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'MERCURY_SCRIPTED_STREAM',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const settingsRoad = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — loop-guard chant prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

function setStopKey(value: boolean | null): void {
  const path = settingsRoad.getSettingsFilePathForSource('userSettings')!
  if (value === null) rmSync(path, { force: true })
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ loopGuardStopEnabled: value }, null, 2))
  }
  resetSettingsCache()
}

const NUDGE = 'Loop notice: your last reply repeated the same stretch of text'
const NOTICE = 'Loop guard: the reply repeated the same 50-character stretch'
const STOP = 'The loop guard ended the turn: the reply repeated the same stretch of text'
const ANY_NOTICE = /Loop (check|notice|guard)/

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

type Run = { calls: unknown[][]; yields: AnyMsg[]; terminal: Record<string, unknown> }

async function runReplies(replies: string[]): Promise<Run> {
  const calls: unknown[][] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push([...req.messages])
    const reply = replies[idx] ?? 'the script is exhausted'
    for (const m of textTurn(reply)) yield m as never
  }
  const gen = query({
    messages: [createUserMessage({ content: 'please write the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    toolUseContext: makeCtx() as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    r = await gen.next()
  }
  return { calls, yields, terminal: r.value }
}

const requestText = (run: Run, i: number): string => JSON.stringify(run.calls[i] ?? [])
const rows = (run: Run): Array<{ level?: string; content?: string }> =>
  run.yields.filter(m => m.type === 'system' && ANY_NOTICE.test(String((m as { content?: unknown }).content ?? ''))) as never
const stops = (run: Run): Array<Record<string, unknown>> =>
  run.yields.filter(m => m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'loop_stopped').map(m => (m as { attachment: Record<string, unknown> }).attachment)

const SENTENCE = 'I will now check the configuration file again for the setting. '
const CHANT = `Here is what I found so far.\n\n${SENTENCE.repeat(14)}`
const HONEST = 'The configuration file carries the setting on line 12; the value is true, so the feature is on. Nothing else in the file bears on it.'

section('P1 — a plain long reply and a reply whose repeats live in a code fence or a list never trip the guard')
{
  setStopKey(null)
  const plain = await runReplies([`${HONEST} `.repeat(12)])
  check('a long reply of varied prose completes with no notice', plain.terminal.reason === 'completed' && plain.calls.length === 1 && rows(plain).length === 0, `calls=${plain.calls.length} rows=${rows(plain).length}`)
  const fenced = await runReplies([`Here is the log:\n\n\`\`\`\n${SENTENCE.repeat(14)}\n\`\`\`\n\nThat is the log.`])
  check('the same stretch repeated fourteen times inside a code fence is not chanting', fenced.terminal.reason === 'completed' && fenced.calls.length === 1 && rows(fenced).length === 0, `calls=${fenced.calls.length}`)
  const listed = await runReplies([`Steps:\n${Array.from({ length: 14 }, () => `- ${SENTENCE}`).join('\n')}`])
  check('a list whose items repeat is not chanting', listed.terminal.reason === 'completed' && listed.calls.length === 1 && rows(listed).length === 0, `calls=${listed.calls.length}`)
}

section('P2 — DEFAULT (no key): a chanting reply is cut once with the loop nudge and the model continues; a second chant lets the reply stand')
{
  setStopKey(null)
  const once = await runReplies([CHANT, HONEST])
  check('the model was called twice: the chant, then the continuation', once.calls.length === 2, `calls=${once.calls.length}`)
  check('the nudge rode into the second request as a system reminder naming the repeated stretch', requestText(once, 1).includes(NUDGE) && requestText(once, 1).includes('I will now check the configuration file'), requestText(once, 1).slice(-400))
  check('the operator got a warning row saying the reply repeated itself and the model was asked to continue', rows(once).length === 1 && rows(once)[0]?.level === 'warning' && String(rows(once)[0]?.content).startsWith(NOTICE) && /continuation 1 of 1/.test(String(rows(once)[0]?.content)), JSON.stringify(rows(once)))
  check('the turn completed on the continuation\'s own words, no loop_stopped', once.terminal.reason === 'completed' && stops(once).length === 0, JSON.stringify(once.terminal))
  const twice = await runReplies([CHANT, CHANT])
  check('a second chant after the nudge is not cut again: two model calls, the reply stands, the turn completes', twice.calls.length === 2 && twice.terminal.reason === 'completed' && stops(twice).length === 0, `calls=${twice.calls.length} ${JSON.stringify(twice.terminal)}`)
  check('the operator got the continuation row and then the row saying the reply stands', rows(twice).length === 2 && /the reply stands and the turn ends on the model's own words/.test(String(rows(twice)[1]?.content)), JSON.stringify(rows(twice).map(r => r.content)))
}

section('P3 — KEY ON (loopGuardStopEnabled: true): the second chant ends the turn typed as loop_stopped')
{
  setStopKey(true)
  const run = await runReplies([CHANT, CHANT, HONEST])
  check('two model calls, never a third: the second chant ended the turn', run.calls.length === 2, `calls=${run.calls.length}`)
  check('the turn ended typed as loop_stopped for the reply', run.terminal.reason === 'loop_stopped' && JSON.stringify((run.terminal as { cycle?: unknown }).cycle) === JSON.stringify(['reply']), JSON.stringify(run.terminal))
  const stop = stops(run)
  check('one loop_stopped attachment was yielded with the stop text naming the repeated stretch', stop.length === 1 && String(stop[0]?.message).startsWith(STOP) && String(stop[0]?.message).includes('I will now check the configuration file'), JSON.stringify(stop))
  check('the operator got the continuation row and then the warning row naming the key', rows(run).length === 2 && rows(run).every(r => r.level === 'warning') && /loopGuardStopEnabled/.test(String(rows(run)[1]?.content)), JSON.stringify(rows(run).map(r => r.content)))
  const single = await runReplies([CHANT, HONEST])
  check('with the key on, a single chant is still only cut once and the continuation completes the turn', single.calls.length === 2 && single.terminal.reason === 'completed' && stops(single).length === 0, `calls=${single.calls.length} ${JSON.stringify(single.terminal)}`)
  setStopKey(null)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`LOOP-GUARD-CHANT: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`LOOP-GUARD-CHANT: all ${checks} checks passed`)
process.exit(0)

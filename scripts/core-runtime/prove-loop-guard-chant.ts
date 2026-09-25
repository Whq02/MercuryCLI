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
const { createAssistantAPIErrorMessage, createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
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

function makeCtx(agentId?: string): Record<string, unknown> {
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
    agentId,
  }
}

function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}
const CAPPED = '\u0000capped'
const REFUSED = '\u0000refused'
function refusedTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  ;(m as { refusedToolCalls?: unknown[] }).refusedToolCalls = [{ id: 'call_refused_1', name: 'Grpe', argumentsRaw: '{}', code: 'unknown-tool', reason: 'no tool of that name' }]
  return [m]
}
function cappedTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'max_tokens'
  const cap = createAssistantAPIErrorMessage({
    content: "API Error: Mercury's response exceeded the 8192 output token maximum.",
    apiError: 'max_output_tokens',
    error: 'max_output_tokens',
  })
  cap.message.id = m.message.id
  return [m, cap]
}

type Run = { calls: unknown[][]; yields: AnyMsg[]; terminal: Record<string, unknown> }

async function runReplies(replies: string[], agentId?: string): Promise<Run> {
  const calls: unknown[][] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push([...req.messages])
    const reply = replies[idx] ?? 'the script is exhausted'
    const turn = reply.endsWith(CAPPED) ? cappedTurn(reply.slice(0, -CAPPED.length)) : reply.endsWith(REFUSED) ? refusedTurn(reply.slice(0, -REFUSED.length)) : textTurn(reply)
    for (const m of turn) yield m as never
  }
  const gen = query({
    messages: [createUserMessage({ content: 'please write the thing' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    toolUseContext: makeCtx(agentId) as never,
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
  check('the operator got the continuation row and then the row saying the reply stands, claiming no end', rows(twice).length === 2 && /the reply stands, and the loop guard ends no turn without loopGuardStopEnabled/.test(String(rows(twice)[1]?.content)) && !/turn ends/.test(String(rows(twice)[1]?.content)), JSON.stringify(rows(twice).map(r => r.content)))
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

section('P4 — a chant cut by the output cap takes the chant road, not the resume road (both roads)')
{
  setStopKey(null)
  const once = await runReplies([CHANT + CAPPED, HONEST])
  check('DEFAULT: two model calls — the capped chant, then the continuation on the chant nudge', once.calls.length === 2 && once.terminal.reason === 'completed', `calls=${once.calls.length} ${JSON.stringify(once.terminal)}`)
  check('the second request carries the chant nudge and no "Resume directly" resume nudge', requestText(once, 1).includes(NUDGE) && !/Resume directly/.test(requestText(once, 1)), requestText(once, 1).slice(-300))
  check('one chant warning row, no output-cap notice row', rows(once).length === 1 && String(rows(once)[0]?.content).startsWith(NOTICE) && !once.yields.some(m => m.type === 'system' && /Output token limit/.test(String((m as { content?: unknown }).content ?? ''))), JSON.stringify(rows(once).map(r => r.content)))
  const twice = await runReplies([CHANT + CAPPED, CHANT + CAPPED, HONEST])
  check('DEFAULT: a second capped chant stands — two model calls, never a resume, the turn completes', twice.calls.length === 2 && twice.terminal.reason === 'completed' && !/Resume directly/.test(requestText(twice, 1)) && stops(twice).length === 0, `calls=${twice.calls.length} ${JSON.stringify(twice.terminal)}`)
  setStopKey(true)
  const ended = await runReplies([CHANT + CAPPED, CHANT + CAPPED, HONEST])
  check('KEY ON: the second capped chant ends the turn typed as loop_stopped for the reply', ended.calls.length === 2 && ended.terminal.reason === 'loop_stopped' && stops(ended).length === 1, `calls=${ended.calls.length} ${JSON.stringify(ended.terminal)}`)
  setStopKey(null)
}

section('P5 — KEY ON: a sub-agent ended for chanting settles to its parent as a typed failure, and the chant is never returned as its report')
{
  setStopKey(true)
  const { finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const run = await runReplies([CHANT, CHANT, HONEST], 'agent-rig-chant')
  check('the sub-agent turn ended typed as loop_stopped for the reply', run.terminal.reason === 'loop_stopped' && stops(run).length === 1, JSON.stringify(run.terminal))
  const collected = run.yields.filter(m => m.type === 'assistant' || m.type === 'user' || m.type === 'attachment')
  const finalized = finalizeAgentTool(collected as never, 'agent-rig-chant', { prompt: 'write', resolvedAgentModel: MODEL, isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: false })
  check('the finalized outcome is a typed failure with the loop-stopped reason', finalized.outcome?.status === 'failed' && (finalized.outcome as { reason?: string }).reason === 'loop-stopped', JSON.stringify(finalized.outcome))
  check('the finalized content carries none of the chant', (finalized.content ?? []).length === 0, JSON.stringify(finalized.content).slice(0, 200))
  const block = AgentTool.mapToolResultToToolResultBlockParam({ status: 'failed', prompt: 'write', error: (finalized.outcome as { error?: string }).error, ...finalized } as never, 'tu_parent') as { is_error?: boolean; content?: Array<{ text?: string }> }
  const parentText = (block.content ?? []).map(b => b.text ?? '').join('\n')
  check('the parent receives is_error, the failure names the loop guard, and the chant sentence appears nowhere in it', block.is_error === true && /Agent execution failed: The loop guard ended the turn/.test(parentText) && !parentText.includes(SENTENCE.trim()), parentText.slice(0, 400))
  setStopKey(null)
}

section('P6 — a chanting reply that also carries a wire-refused tool call takes the refusal correction first; the chant road judges the reply after it')
{
  setStopKey(null)
  const withRefusal = await runReplies([CHANT + REFUSED, HONEST])
  check('the refusal correction ("None of these calls ran") rides in the second request', /None of these calls ran|was refused before execution|refused/.test(requestText(withRefusal, 1)) && withRefusal.calls.length === 2, requestText(withRefusal, 1).slice(-500))
  check('the chant nudge does not displace the correction on that request', !requestText(withRefusal, 1).includes(NUDGE), requestText(withRefusal, 1).slice(-300))
  const chantThenRefused = await runReplies([CHANT, CHANT + REFUSED, HONEST])
  const rowTexts = rows(chantThenRefused).map(r => String(r.content))
  check('chant, then chant plus a refused call: the correction follows and a third request is made', chantThenRefused.calls.length === 3 && /refused/.test(requestText(chantThenRefused, 2)), `calls=${chantThenRefused.calls.length}`)
  check('no operator row claims that the turn ends on the model\'s own words while the turn carries on', rowTexts.every(t => !/turn ends on the model/.test(t)), JSON.stringify(rowTexts))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`LOOP-GUARD-CHANT: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`LOOP-GUARD-CHANT: all ${checks} checks passed`)
process.exit(0)

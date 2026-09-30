#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-service-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>

type FixtureMode = { kind: 'text'; text: string } | { kind: 'refuse'; status: number; message: string } | { kind: 'think'; tokens: number; text: string }
let fixture: FixtureMode = { kind: 'text', text: 'Verify the pin on the base before you cut.' }
const wire: Array<{ path: string; body: Raw }> = []
const FIXTURE_USAGE = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 14 }
const VENDOR_OUTPUT_CAP = 128_000
const NOTE_TOKENS = 60
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
function anthropicText(text: string, model: string): string {
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_advisor_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: FIXTURE_USAGE } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: FIXTURE_USAGE }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}
function anthropicThinkFirst(mode: { tokens: number; text: string }, maxTokens: number, model: string): string {
  const start = { input_tokens: 884, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const out: string[] = [
    sse('message_start', { type: 'message_start', message: { id: 'msg_advisor_think', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: start } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing the four decisions against each other before writing.' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (maxTokens < mode.tokens + NOTE_TOKENS) {
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: maxTokens, output_tokens_details: { thinking_tokens: maxTokens } } }))
    out.push(sse('message_stop', { type: 'message_stop' }))
    return out.join('')
  }
  out.push(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  out.push(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: mode.text } }))
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: mode.tokens + NOTE_TOKENS, output_tokens_details: { thinking_tokens: mode.tokens } } }))
  out.push(sse('message_stop', { type: 'message_stop' }))
  return out.join('')
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Raw = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Raw
    } catch {
      body = {}
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      wire.push({ path, body })
      if (fixture.kind === 'refuse') {
        res.writeHead(fixture.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: fixture.message } }))
        return
      }
      if (fixture.kind === 'think') {
        const maxTokens = Number(body.max_tokens)
        if (!Number.isFinite(maxTokens) || maxTokens > VENDOR_OUTPUT_CAP) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > ${VENDOR_OUTPUT_CAP}, which is the maximum allowed number of output tokens for ${String(body.model)}` } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicThinkFirst(fixture, maxTokens, String(body.model ?? 'fixture')))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicText(fixture.text, String(body.model ?? 'fixture')))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

const { setIsInteractive } = await import(join(ROOT, 'src/bootstrap/state.ts'))
setIsInteractive(false)
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const state = await import(join(ROOT, 'src/bootstrap/state.ts'))
const config = await import(join(ROOT, 'src/utils/config.ts'))
const advisor = await import(join(ROOT, 'src/services/advisor/index.ts'))
const slots = await import(join(ROOT, 'src/utils/model/subModelSlots.ts'))
const workload = await import(join(ROOT, 'src/utils/workloadContext.ts'))
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const text = await import(join(ROOT, 'src/utils/messages/text.ts'))
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages/factories.ts'))
const { getTranscriptPath } = await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
const storage = await import(join(ROOT, 'src/utils/sessionStorage.ts'))
const { calculateTokenWarningState, getEffectiveContextWindowSize } = await import(join(ROOT, 'src/services/compact/autoCompact.ts'))
const { getMaxOutputTokensForModel } = await import(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'))
const { modelThinkingAlwaysOn } = await import(join(ROOT, 'src/utils/model/capabilities.ts'))

const ADVISOR_MODEL = 'claude-opus-4-8'
const AGENT = 'agent-fixture-1'
const DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-context-'))
const ON5 = { enabled: true, minutes: 5 }
const T0 = Date.parse('2026-06-19T09:00:00.000Z')
const clock = { now: T0 }
const now = (): number => clock.now
const tick = (minutes: number): void => {
  clock.now += minutes * 60_000
}
const MINUTE = 60_000
const afterInterval = async (id: string, transcript: Raw[], road: Raw): Promise<unknown> => {
  const first = await advisor.advisorTurnSettled(id, transcript as never, road as never)
  if (first !== null) return first
  tick((road.settings as { minutes?: number } | undefined)?.minutes ?? advisor.readAdvisorSettings().minutes)
  return advisor.advisorTurnSettled(id, transcript as never, road as never)
}

type CallRecord = { model: string; system: string; prompt: string; effort?: string }
const makeCall = (answers: string[] | ((n: number) => string)): { call: (args: CallRecord) => Promise<Raw>; calls: CallRecord[] } => {
  const calls: CallRecord[] = []
  return {
    calls,
    call: async (args: CallRecord): Promise<Raw> => {
      calls.push(args)
      const answer = typeof answers === 'function' ? answers(calls.length) : (answers[calls.length - 1] ?? answers[answers.length - 1] ?? 'carry on')
      return { ok: true, text: answer }
    },
  }
}
const uuidAt = (n: number): string => `a5b6c7d8-0000-4000-8000-${String(n).padStart(12, '0')}`
const operatorRow = (n: number, words: string): Raw => createUserMessage({ content: words, uuid: uuidAt(n) as never }) as unknown as Raw
const replyRow = (n: number, words: string): Raw => ({ ...(createAssistantMessage({ content: words }) as unknown as Raw), uuid: uuidAt(n) })
const toolRow = (n: number, name: string, input: Raw): Raw => ({
  ...(createAssistantMessage({ content: [{ type: 'tool_use', id: `tu_${n}`, name, input }] as never }) as unknown as Raw),
  uuid: uuidAt(n),
})
const resultRow = (n: number, id: string, out: string, isError = false): Raw =>
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: out, ...(isError ? { is_error: true } : {}) }] as never, uuid: uuidAt(n) as never }) as unknown as Raw
const metaRow = (n: number, words: string): Raw => createUserMessage({ content: words, isMeta: true, uuid: uuidAt(n) as never }) as unknown as Raw

section('§0 the settings: off by default, ten minutes, a trim-to-defaults writer beside the JEV row, the model through the /submodels store')
{
  const fresh = advisor.readAdvisorSettings()
  check('the switch is off by default, every 10 minutes, and the settings carry no crewmate switch any more (red on the base: a crewmates key beside enabled)', fresh.enabled === false && fresh.minutes === 10 && advisor.ADVISOR_DEFAULT_MINUTES === 10 && !('crewmates' in fresh) && !('seats' in fresh) && j(Object.keys(fresh).sort()) === j(['enabled', 'minutes']), j(fresh))
  check('nothing stored for the defaults', config.getGlobalConfig().advisor === undefined)
  const on = advisor.setAdvisorEnabled(true)
  check('advisor:on lands as the one key', on.enabled && j(config.getGlobalConfig().advisor) === j({ enabled: true }), j(config.getGlobalConfig().advisor))
  check('a saved crewmates key from an older build never reads back and the writer never keeps it (red on the base: it opted crewmates in)', !('crewmates' in advisor.advisorSettingsFromStored({ enabled: true, crewmates: true } as never)) && typeof (advisor as Record<string, unknown>).setAdvisorCrewmates === 'undefined')
  const twenty = advisor.setAdvisorMinutes(20)
  check('advisor minutes:20 lands beside it under the minutes key', twenty.minutes === 20 && j(config.getGlobalConfig().advisor) === j({ enabled: true, minutes: 20 }), j(config.getGlobalConfig().advisor))
  const ten = advisor.setAdvisorMinutes(10)
  check('the default interval trims back out of the file', ten.minutes === 10 && j(config.getGlobalConfig().advisor) === j({ enabled: true }), j(config.getGlobalConfig().advisor))
  let refused = ''
  try {
    advisor.setAdvisorMinutes(0)
  } catch (error) {
    refused = String(error)
  }
  check('the floor is one minute: 0 is refused typed, the file untouched', refused.includes('1 or more') && refused.includes('minutes') && j(config.getGlobalConfig().advisor) === j({ enabled: true }), refused)
  check('a hand-edited off-floor interval reads as the default', advisor.advisorSettingsFromStored({ enabled: true, minutes: 0 }).minutes === 10 && advisor.advisorSettingsFromStored({ minutes: 2.5 }).minutes === 10)
  check("a saved turn count from an older build is not an interval: the reader never reads `seats`", advisor.advisorSettingsFromStored({ enabled: true, seats: 5 } as never).minutes === 10)
  const off = advisor.setAdvisorEnabled(false)
  check('advisor off again removes the block entirely', !off.enabled && config.getGlobalConfig().advisor === undefined, j(config.getGlobalConfig().advisor))
  check('the ladder the /config row cycles is 10 · 20 · 30 · 45 · 60 minutes (red on the base: 5 · 10 · 20 · 50 turns)', j(advisor.ADVISOR_MINUTES_LADDER) === j([10, 20, 30, 45, 60]) && advisor.ADVISOR_MINUTES_FLOOR === 1 && advisor.ADVISOR_SEATS_LADDER === undefined)
  check("the advisor is a second sub-model container beside the console, with its own env pin", j(slots.SUB_MODEL_CONTAINERS) === j(['console', 'advisor']) && slots.subModelEnvVar('advisor') === 'MERCURY_ADVISOR_MODEL' && slots.subModelEnvVar('console') === 'MERCURY_CONSOLE_MODEL', j(slots.SUB_MODEL_CONTAINERS))
  check('unpinned, the advisor model is UNSET and answers the /submodels hint', advisor.resolveAdvisorModel().origin === 'unset')
  process.env.MERCURY_ADVISOR_MODEL = ` ${ADVISOR_MODEL}[1m] `
  const pinned = advisor.resolveAdvisorModel()
  check('the env pin reads the way resolveSubModel reads: canonical id, the var named, LOCKED for the picker', pinned.origin === 'env' && pinned.model === ADVISOR_MODEL && pinned.envVar === 'MERCURY_ADVISOR_MODEL' && pinned.route === 'anthropic', j(pinned))
  const write = slots.setSubModel('advisor', ADVISOR_MODEL)
  check('the picker refuses a write while the var pins it, naming the var', !write.ok && write.reason.includes('MERCURY_ADVISOR_MODEL'), j(write))
  delete process.env.MERCURY_ADVISOR_MODEL
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: ADVISOR_MODEL } }))
  const saved = advisor.resolveAdvisorModel()
  check('the saved /submodels pick is the second rung', saved.origin === 'saved' && saved.model === ADVISOR_MODEL, j(saved))
  const identity = slots.subModelIdentityLine('advisor', saved as never)
  check('the identity line names the advisor and the model, never the operator as its audience', identity.includes('the Advisor') && identity.includes(ADVISOR_MODEL) && identity.includes('never the operator'), identity)
  const consoleIdentity = slots.subModelIdentityLine('console', { origin: 'saved', model: ADVISOR_MODEL, route: 'anthropic' } as never)
  check("the console's identity line is untouched", consoleIdentity.includes('the Console, the side-question assistant'))
  check("the advisor's effort context says its calls run with thinking off; the console's stays the session's", j(slots.subModelEffortContext('advisor')) === j({ thinkingEnabled: false }) && j(slots.subModelEffortContext('console')) === j({}))
  check('the workload vocabulary carries the advisor beside cron', workload.WORKLOAD_ADVISOR === 'advisor' && workload.WORKLOAD_CRON === 'cron')
  check('the receipt words name the state and the model', advisor.advisorReceiptWords({ enabled: true, minutes: 5 }).includes('every 5 minutes') && advisor.advisorReceiptWords({ enabled: false, minutes: 10 }).startsWith('Advisor off'))
  check('the interval words: minutes, one of them singular', advisor.advisorIntervalWords(10) === 'every 10 minutes' && advisor.advisorIntervalWords(1) === 'every 1 minute' && advisor.advisorValueWords({ enabled: true, minutes: 10 }) === 'on · every 10 minutes · /advise turns it on per chat' && advisor.advisorValueWords({ enabled: false, minutes: 10 }) === 'off')
}

section('§0b seat admission: the main chat follows Advisor; crewmates and workflow agents never get the advisor, whatever the settings say (red on the base: a crewmate opt-in)')
{
  for (const enabled of [false, true]) {
    const settings = { enabled, minutes: 1 }
    for (const seat of ['main', 'crewmate', 'workflow'] as const) {
      const allowed = enabled && seat === 'main'
      const id = `scope-${seat}-${enabled}`
      const { call, calls } = makeCall(['Check the base before the next edit.'])
      const road = { seat, chat: true, settings, call: call as never, model: ADVISOR_MODEL, dir: DIR, persist: false, now }
      const transcript = [operatorRow(1, 'which seam?')] as never
      await advisor.advisorTurnSettled(id, transcript, road)
      tick(1)
      const note = await advisor.advisorTurnSettled(id, transcript, road)
      const ask = await advisor.askAdvisor(id, 'which seam?', transcript, road)
      check(`${seat}, settings=${enabled}, chat on: notes and asks share admission`, allowed ? note !== null && ask.ok && calls.length === 2 : note === null && !ask.ok && calls.length === 0, j({ note, ask, calls: calls.length }))
      if (!allowed) check(`${id}: refusal opens no advisor context`, advisor.peekAdvisorContext(id) === undefined)
    }
  }
  check('the refusals name their reason: crewmates and workflow agents are never served, and the settings switch is /config → Advisor', advisor.advisorSeatRefusal('crewmate', { enabled: true, minutes: 1 }, true) === advisor.ADVISOR_CREWMATE_REFUSAL && advisor.ADVISOR_CREWMATE_REFUSAL.includes('not available to crewmates') && advisor.advisorSeatRefusal('workflow', { enabled: true, minutes: 1 }, true) === advisor.ADVISOR_WORKFLOW_REFUSAL && advisor.advisorSeatRefusal('main', { enabled: false, minutes: 1 }, true) === advisor.ADVISOR_SETTINGS_OFF_REFUSAL && advisor.ADVISOR_SETTINGS_OFF_REFUSAL.includes('/config'), j([advisor.ADVISOR_CREWMATE_REFUSAL, advisor.ADVISOR_WORKFLOW_REFUSAL, advisor.ADVISOR_SETTINGS_OFF_REFUSAL]))
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorMinutes(20)
  check('the switch and the interval persist together, nothing else', j(config.getGlobalConfig().advisor) === j({ enabled: true, minutes: 20 }))
  config.saveGlobalConfig(c => ({ ...c, advisor: { enabled: true, crewmates: true, minutes: 20 } as never }))
  check('a crewmates key written by hand never changes a crewmate\'s answer', advisor.advisorSeatRefusal('crewmate', undefined, true) === advisor.ADVISOR_CREWMATE_REFUSAL)
  advisor.setAdvisorMinutes(30)
  check('the next save drops the crewmates key from the file', j(config.getGlobalConfig().advisor) === j({ enabled: true, minutes: 30 }), j(config.getGlobalConfig().advisor))
  advisor.setAdvisorEnabled(false)
  advisor.setAdvisorMinutes(10)
  check('returning the switch and the interval to defaults trims the whole block', config.getGlobalConfig().advisor === undefined)
}

section("§0c THE EFFECTIVE TEST: the advisor runs for a chat only when the settings are on AND the chat's own switch is on — a new chat starts off even with the settings on; /advise on turns it on for this chat alone; /config → Advisor off stops every chat at once; the settings back on turn no chat on (red on the base: the settings alone ran every session)")
{
  const ON = { enabled: true, minutes: 10 }
  const OFF = { enabled: false, minutes: 10 }
  check("a fresh session's own switch is off, so the main chat is refused with the settings on, naming /advise on", storage.advisorSwitchOfSession() === false && advisor.advisorChatSwitch() === false && advisor.advisorSeatRefusal('main', ON) === advisor.ADVISOR_CHAT_OFF_REFUSAL && advisor.ADVISOR_CHAT_OFF_REFUSAL.includes('/advise on'), j(advisor.advisorSeatRefusal('main', ON)))
  check('with the settings off the refusal names the settings first, whatever the chat says', advisor.advisorSeatRefusal('main', OFF, true) === advisor.ADVISOR_SETTINGS_OFF_REFUSAL && advisor.advisorSeatRefusal('main', OFF, false) === advisor.ADVISOR_SETTINGS_OFF_REFUSAL)
  check('a chat whose switch is on with the settings on is served', advisor.advisorSeatRefusal('main', ON, true) === undefined)
  const { call, calls } = makeCall(['never for a chat that did not ask'])
  const transcript = [operatorRow(1, 'hello'), replyRow(2, 'hi')]
  const offRoad = { settings: ON, call: call as never, model: ADVISOR_MODEL, dir: DIR, persist: false, now }
  const first = await advisor.advisorTurnSettled('chat-off', transcript as never, offRoad)
  tick(10)
  const second = await advisor.advisorTurnSettled('chat-off', transcript as never, offRoad)
  const askOff = await advisor.askAdvisor('chat-off', 'anyone?', transcript as never, offRoad)
  check("the settings on alone spend nothing: two boundaries ten minutes apart, no call, no note, no context, and the ask refuses naming this chat's switch", first === null && second === null && calls.length === 0 && advisor.peekAdvisorContext('chat-off') === undefined && !askOff.ok && askOff.reason === advisor.ADVISOR_CHAT_OFF_REFUSAL, j({ first, second, calls: calls.length, askOff }))
  storage.saveAdvisorSwitch(true)
  check("/advise on: the session's own record reads on and the main chat is served", storage.advisorSwitchOfSession() === true && advisor.advisorChatSwitch() === true && advisor.advisorSeatRefusal('main', ON) === undefined)
  const onRoad = { settings: ON, call: call as never, model: ADVISOR_MODEL, dir: DIR, persist: false, now }
  await advisor.advisorTurnSettled('chat-on', transcript as never, onRoad)
  tick(10)
  const served = await advisor.advisorTurnSettled('chat-on', transcript as never, onRoad)
  check('once the chat is on, the same boundaries compose the note', served !== null && calls.length === 1, j({ served, calls: calls.length }))
  advisor.setAdvisorEnabled(true)
  check('advisorEnabled() — the tool gate — is the same effective test through the live settings', advisor.advisorEnabled() === true)
  advisor.setAdvisorEnabled(false)
  const stopped = await advisor.advisorTurnSettled('chat-on', [...transcript, replyRow(3, 'more')] as never, { call: call as never, model: ADVISOR_MODEL, dir: DIR, persist: false, now })
  check('/config → Advisor off stops a chat that is on: the live settings refuse, no call, and the tool gate closes', advisor.advisorEnabled() === false && stopped === null && calls.length === 1 && advisor.advisorSeatRefusal('main') === advisor.ADVISOR_SETTINGS_OFF_REFUSAL)
  storage.saveAdvisorSwitch(false)
  advisor.setAdvisorEnabled(true)
  check("the settings back on turn no chat on: this chat's switch stands off as it was", advisor.advisorEnabled() === false && advisor.advisorSeatRefusal('main') === advisor.ADVISOR_CHAT_OFF_REFUSAL)
  advisor.setAdvisorEnabled(false)
  const unpinned = { origin: 'unset', hint: 'x' } as never
  const pinned = { origin: 'saved', model: ADVISOR_MODEL, route: 'anthropic' } as never
  check('the bare /advise line: on or off for this chat, the model, the minutes — and when the settings are off, that /config → Advisor must be on for any chat to get notes', advisor.advisorChatLine({ chat: true, settings: ON, model: pinned }) === `advisor on for this chat · ${ADVISOR_MODEL} · every 10 minutes` && advisor.advisorChatLine({ chat: false, settings: { enabled: true, minutes: 20 }, model: pinned }) === `advisor off for this chat — /advise on turns it on · ${ADVISOR_MODEL} · every 20 minutes` && advisor.advisorChatLine({ chat: true, settings: OFF, model: unpinned }) === 'advisor on for this chat · no advisor model pinned — /submodels sets one · every 10 minutes · off in the settings — /config → Advisor must be on for any chat to get notes', j([advisor.advisorChatLine({ chat: true, settings: ON, model: pinned }), advisor.advisorChatLine({ chat: false, settings: { enabled: true, minutes: 20 }, model: pinned }), advisor.advisorChatLine({ chat: true, settings: OFF, model: unpinned })]))
  const { runAdviseCommand, ADVISE_USAGE, parseAdviseArg } = await import(join(ROOT, 'src/commands/advise/advise.ts'))
  check('the command parses on, off, bare and nothing else', parseAdviseArg(' ON ') === 'on' && parseAdviseArg('off') === 'off' && parseAdviseArg('') === 'show' && parseAdviseArg('maybe') === 'unknown' && runAdviseCommand('maybe') === ADVISE_USAGE && ADVISE_USAGE.includes('/advise on|off'))
  advisor.setAdvisorEnabled(true)
  check("/advise on writes this chat's switch and answers the state line; /advise alone says the same; /advise off turns it off", runAdviseCommand('on').startsWith('advisor on for this chat') && storage.advisorSwitchOfSession() === true && runAdviseCommand('') === runAdviseCommand('on') && runAdviseCommand('off').startsWith('advisor off for this chat — /advise on turns it on') && storage.advisorSwitchOfSession() === false, runAdviseCommand(''))
  advisor.setAdvisorEnabled(false)
  check('the command is a session-seat local command that the headless runner may execute, curated under model & effort in /help', await (async () => {
    const command = (await import(join(ROOT, 'src/commands/advise/index.ts'))).default as { type: string; name: string; supportsNonInteractive: boolean; seat?: string; argumentHint?: string }
    const { commandSeat, builtinCommands } = await import(join(ROOT, 'src/commands.ts'))
    const { COMMAND_DOMAINS } = await import(join(ROOT, 'src/components/HelpV2/commandDomains.ts'))
    return command.type === 'local' && command.name === 'advise' && command.supportsNonInteractive === true && command.argumentHint === '[on|off]' && commandSeat(command as never) === 'session' && builtinCommands().some((c: { name: string }) => c.name === 'advise') && COMMAND_DOMAINS.some((d: { key: string; names: readonly string[] }) => d.key === 'model' && d.names.includes('advise'))
  })())
  storage.saveAdvisorSwitch(true)
}

section("§1 off by default: with advisor.enabled false nothing runs — no context, no call, no note")
{
  const { call, calls } = makeCall(['a note that must never be asked for'])
  let note: unknown = 'unset'
  for (let boundary = 1; boundary <= 12; boundary++) {
    tick(10)
    note = await advisor.advisorTurnSettled(AGENT, [operatorRow(1, 'hello')] as never, { call: call as never, dir: DIR, now })
  }
  check('twelve boundaries two hours apart with the advisor off: no note and no call', note === null && calls.length === 0, `note=${j(note)} calls=${calls.length}`)
  check('no advisor context was opened', advisor.peekAdvisorContext(AGENT) === undefined)
  check('no file was written', !existsSync(advisor.advisorContextPath(AGENT, DIR)))
}

section('§2 THE MINUTES CLOCK: a note falls due once `minutes` have passed since the last look and not before, and is composed at the next boundary; the digest carries only the new rows; the note lands with the advisor origin (red on the base: a turn counter)')
{
  advisor.resetAdvisorContextsForTests()
  clock.now = T0
  const { call, calls } = makeCall(['Verify the pin on the base before you cut.', 'The second note.'])
  const transcript: Raw[] = []
  const notes: Array<{ minute: number; note: Raw }> = []
  let n = 0
  const road = { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now }
  for (let minute = 0; minute <= 12; minute++) {
    if (minute > 0) tick(1)
    transcript.push(operatorRow(++n, `operator line ${minute}`))
    transcript.push(replyRow(++n, `reply ${minute}`))
    const note = await advisor.advisorTurnSettled(AGENT, transcript as never, road)
    if (note !== null) notes.push({ minute, note: note as unknown as Raw })
    if (minute < 5) check(`minute ${minute}: no note yet, no call`, note === null && calls.length === 0, `note=${j(note)} calls=${calls.length}`)
  }
  check('notes at exactly minutes 5 and 10 of the thirteen boundaries — five minutes after the context opened, then five after the first note (red on the base: turns)', j(notes.map(x => x.minute)) === j([5, 10]) && calls.length === 2, j(notes.map(x => x.minute)))
  const opened = advisor.peekAdvisorContext(AGENT)!
  check('the context records when it was opened and the last look, both on the seam clock', opened.openedAt === T0 && opened.lookedAt === T0 + 10 * MINUTE && advisor.advisorClockStart(opened) === T0 + 10 * MINUTE, j({ openedAt: opened.openedAt, lookedAt: opened.lookedAt }))
  check('the due test by the seam: not due at 4 minutes 59 seconds, due at 5 minutes, and a one-minute floor', !advisor.advisorNoteDue(opened, 5, T0 + 15 * MINUTE - 1000) && advisor.advisorNoteDue(opened, 5, T0 + 15 * MINUTE) && advisor.advisorNoteDue(opened, 0, T0 + 11 * MINUTE) && !advisor.advisorNoteDue(opened, 0, T0 + 11 * MINUTE - 1))
  const first = calls[0]!
  check("the first digest carries the twelve rows of minutes 0–5, rendered as the transcript reads", first.prompt.includes('[operator] operator line 0') && first.prompt.includes('[agent] reply 5') && !first.prompt.includes('operator line 6'), first.prompt.slice(0, 400))
  check('the first call carries the fixed system prompt, addressed to the agent, never the operator', first.system === advisor.ADVISOR_SYSTEM_PROMPT && first.system.includes('never address the operator') && first.system.includes(`at most ${advisor.ADVISOR_NOTE_MAX_LINES} lines`))
  check('the first call has no earlier notes to show', first.prompt.includes('no earlier notes'))
  const second = calls[1]!
  check('the second digest carries ONLY the rows since the first note (minutes 6–10), never minutes 0–5 again', second.prompt.includes('[operator] operator line 6') && second.prompt.includes('[agent] reply 10') && !second.prompt.includes('operator line 5') && !second.prompt.includes('reply 1\n'), second.prompt.slice(0, 600))
  check("the second call shows the advisor its own first note as memory", second.prompt.includes('[your note') && second.prompt.includes('Verify the pin on the base before you cut.'), second.prompt.slice(0, 600))
  const note1 = notes[0]!.note
  const origin = note1.origin as Raw
  check("the note's words are the fixture's answer, clamped to the line cap", note1.text === 'Verify the pin on the base before you cut.', j(note1))
  check("the note's origin: { kind: 'advisor', model, minutes, at } — a MessageOrigin member the guard admits, the stamp on the seam clock", rows.isAdvisorOrigin(origin) && origin.kind === 'advisor' && origin.model === ADVISOR_MODEL && origin.minutes === 5 && origin.seats === undefined && origin.at === new Date(T0 + 5 * MINUTE).toISOString() && !rows.isSaturnOrigin(origin), j(origin))
  check('the guard refuses the other origins and a bare kind', !rows.isAdvisorOrigin({ kind: 'advisor' }) && !rows.isAdvisorOrigin({ kind: 'saturn', fire: 'wake', firedAt: 'x' }) && !rows.isAdvisorOrigin(undefined))
  const { getAdvisorNoteAttachments } = await import(join(ROOT, 'src/utils/attachments/queuedCommands.ts'))
  advisor.setAdvisorEnabled(true)
  advisor.stashAdvisorNote(String(state.getSessionId()), note1 as never)
  const drained = getAdvisorNoteAttachments({ agentId: undefined }, { querySource: 'sdk' }) as Raw[]
  advisor.setAdvisorEnabled(false)
  check("the note's one road on every seat is the attachment drain: a queued_command attachment carrying the note and its origin, never isMeta, no command mode, no uuid of a prompt — and no prompt road exists any more (red on the base: a queued prompt at later)", drained.length === 1 && drained[0]!.type === 'queued_command' && drained[0]!.prompt === note1.text && j(drained[0]!.origin) === j(origin) && drained[0]!.isMeta === undefined && drained[0]!.commandMode === undefined && drained[0]!.source_uuid === undefined && advisor.advisorNoteQueueCommand === undefined, j(drained))
  const context = advisor.peekAdvisorContext(AGENT)!
  check('the advisor context holds digest+note pairs for both notes, with the cursor on the last row shown', context.rows.map(r => r.kind).join(',') === 'digest,note,digest,note' && context.cursor === uuidAt(22), j({ kinds: context.rows.map(r => r.kind), cursor: context.cursor }))
  check('the rows carry no turn number any more (the memory has no turn counter to record)', context.rows.every(r => !('turn' in r)), j(context.rows.map(r => Object.keys(r))))
  const mid = text.wrapCommandText(note1.text, origin as never)
  check("a mid-turn drain frames the note as advice from the advisor, never as 'the operator sent a new message'", mid.startsWith(text.ADVISOR_NOTE_HEAD) && mid.includes(note1.text) && mid.endsWith(text.ADVISOR_NOTE_TAIL) && !mid.includes('The operator sent a new message'), mid.slice(0, 200))
  check("the head says it is not the operator; the tail says it is advice, never an instruction", text.ADVISOR_NOTE_HEAD.includes('not the operator') && text.ADVISOR_NOTE_TAIL.includes('advice, not an instruction'))
  const human = text.wrapCommandText('x', undefined)
  check("the operator's own mid-turn framing is untouched", human.startsWith('The operator sent a new message while you were working:'))
}

section('§2b the digest: tool calls with their results clipped, meta rows and advisor rows skipped, the cursor advancing past every row')
{
  const long = 'x'.repeat(2000)
  const messages = [
    operatorRow(1, 'read the file'),
    toolRow(2, 'Read', { file_path: '/tmp/a.ts' }),
    resultRow(3, 'tu_2', long),
    resultRow(4, 'tu_2', 'boom', true),
    metaRow(5, 'a hidden system nudge'),
    { ...operatorRow(6, 'an earlier advisor note'), origin: { kind: 'advisor', model: 'm', minutes: 5, at: 'now' } },
    replyRow(7, 'done'),
  ]
  const digest = advisor.renderAgentDigest(messages as never, undefined)
  const lines = digest.text.split('\n')
  check('one line per row kind: operator · tool · result · result error · agent', lines.length === 5 && lines[0]!.startsWith('[operator] read the file') && lines[1]!.startsWith('[tool] Read {"file_path":"/tmp/a.ts"}') && lines[2]!.startsWith('[result] xxxx') && lines[3]!.startsWith('[result error] boom') && lines[4] === '[agent] done', j(lines.map(l => l.slice(0, 40))))
  check(`a result is clipped to ${advisor.DIGEST_RESULT_CLIP} characters with an ellipsis`, lines[2]!.length === '[result] '.length + advisor.DIGEST_RESULT_CLIP + 1 && lines[2]!.endsWith('…'), String(lines[2]!.length))
  check('the meta row and the advisor row are not in the digest', !digest.text.includes('hidden system nudge') && !digest.text.includes('earlier advisor note'))
  check('the cursor is the last row, the digest counts the rows that spoke', digest.cursor === uuidAt(7) && digest.count === 5, j({ cursor: digest.cursor, count: digest.count }))
  const since = advisor.renderAgentDigest(messages as never, uuidAt(3))
  check('a digest since a cursor carries only the rows after it', since.text === '[result error] boom\n[agent] done' && since.count === 2, since.text)
  const none = advisor.renderAgentDigest(messages as never, uuidAt(7))
  check('nothing new ⇒ an empty digest, count 0, the cursor kept', none.count === 0 && none.text === '' && none.cursor === uuidAt(7))
  const gone = advisor.renderAgentDigest(messages as never, 'no-such-uuid')
  check('a cursor the list no longer holds (a compacted agent) reads the whole list again', gone.count === 5)
  const slashRows = [
    operatorRow(8, '<command-message>advise is running…</command-message>\n<command-name>/advise</command-name>\n<command-args>on</command-args>'),
    operatorRow(9, '<local-command-stdout>advisor on for this chat · m · every 10 minutes</local-command-stdout>'),
  ]
  const slashOnly = advisor.renderAgentDigest(slashRows as never, undefined)
  check("a slash command's own rows — the echo and its stdout — are not the agent's conversation: no digest line, a count of nothing new, the cursor past them (so /advise itself never earns a note)", slashOnly.count === 0 && slashOnly.text === '' && slashOnly.cursor === uuidAt(9), j(slashOnly))
  const mixed = advisor.renderAgentDigest([...slashRows, operatorRow(10, 'a real line')] as never, undefined)
  check('the operator line after them is the one line the advisor reads', mixed.count === 1 && mixed.text === '[operator] a real line', mixed.text)
}

section('§3 the memory on disk: beside the transcript under <session>/advisor/<agentId>.jsonl; a fresh load reads the rows and the cursor back')
{
  const path = advisor.advisorContextPath(AGENT)
  const transcript = getTranscriptPath()
  check('the path law: the session dir beside the transcript, then advisor/, then the agent id', path === join(dirname(transcript), String(state.getSessionId()), 'advisor', `${AGENT}.jsonl`) && path.startsWith(process.env.MERCURY_CONFIG_DIR!), path)
  const file = advisor.advisorContextPath(AGENT, DIR)
  check('the fixture dir file exists after the notes', existsSync(file), file)
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
  check('one head line, then one line per row, JSON each', lines.length === 5 && (JSON.parse(lines[0]!) as Raw).kind === 'head' && lines.slice(1).every(l => typeof (JSON.parse(l) as Raw).text === 'string'), j(lines.map(l => (JSON.parse(l) as Raw).kind)))
  advisor.resetAdvisorContextsForTests()
  const resumed = await advisor.loadAdvisorContext(AGENT, { dir: DIR, now })
  check('a fresh process reads the four rows back with the cursor on the last row shown', resumed.rows.length === 4 && resumed.cursor === uuidAt(22) && resumed.rows[3]!.text === 'The second note.', j({ rows: resumed.rows.length, cursor: resumed.cursor }))
  check("the clock resumes from the last note's own stamp on disk, not from the moment the context was opened (red on the base: a turn counter starting again)", resumed.openedAt === clock.now && resumed.lookedAt === undefined && advisor.advisorLastNoteAt(resumed) === T0 + 10 * MINUTE && advisor.advisorClockStart(resumed) === T0 + 10 * MINUTE, j({ openedAt: resumed.openedAt, start: advisor.advisorClockStart(resumed) }))
  const { call, calls } = makeCall(['note after resume'])
  const more = [operatorRow(23, 'after the resume'), replyRow(24, 'ok')]
  const road = { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now }
  const early = await advisor.advisorTurnSettled(AGENT, more as never, road)
  check('two minutes after the last note the resumed context is not due: no call', clock.now === T0 + 12 * MINUTE && early === null && calls.length === 0, `${clock.now - T0} ms`)
  tick(3)
  await advisor.advisorTurnSettled(AGENT, more as never, road)
  check('five minutes after it the advisor remembers its earlier notes and reads only the rows after its cursor', calls.length === 1 && calls[0]!.prompt.includes('The second note.') && calls[0]!.prompt.includes('[operator] after the resume') && !calls[0]!.prompt.includes('operator line 1'), calls[0]?.prompt.slice(0, 500))
}

section('§4 TWO CLOCKS: the advisor context compacts on ITS gauge (the advisor model\'s window), never the agent\'s — agent 8k, advisor 64k')
{
  advisor.resetAdvisorContextsForTests()
  const context = await advisor.loadAdvisorContext('agent-fold', { dir: DIR })
  const big = 'row '.repeat(3000)
  for (let i = 0; i < 4; i++) {
    await advisor.appendAdvisorRow(context, { kind: 'digest', at: `t${i}`, text: big, cursor: uuidAt(100 + i) })
    await advisor.appendAdvisorRow(context, { kind: 'note', at: `t${i}`, text: `note ${i}` })
  }
  const tokens = advisor.advisorGaugeTokens(context)
  check('the gauge reads about 12k tokens of memory', tokens > 11_000 && tokens < 13_500, String(tokens))
  check('at an 8k window the fold would fire; at 64k it does not — the same rows, two windows, two verdicts', advisor.advisorShouldFold(tokens, 8_000) && !advisor.advisorShouldFold(tokens, 64_000), j({ tokens, at8k: advisor.advisorFoldThreshold(8_000), at64k: advisor.advisorFoldThreshold(64_000) }))
  check('the fold threshold keeps the reserve for the digest and the note, never below half the window', advisor.advisorFoldThreshold(64_000) === 44_000 && advisor.advisorFoldThreshold(8_000) === 4_000 && advisor.advisorFoldThreshold(200_000) === 180_000)
  const agentLevel = calculateTokenWarningState(tokens, ADVISOR_MODEL).level
  check("the agent's own clock is the main compaction law, untouched: 12k tokens on a 200k model is 'ok'", agentLevel === 'ok', agentLevel)
  const summaries: Array<{ systemPrompt: string; transcript: string; modelId: string }> = []
  const summarize = async (args: { systemPrompt: string; transcript: string; modelId: string }): Promise<string> => {
    summaries.push(args)
    return 'the summary of the older memory'
  }
  const keptAt64k = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 64_000, summarize })
  check('on the 64k advisor gauge the advisor keeps every row — no summarizer call', keptAt64k.compacted === 0 && context.rows.length === 8 && summaries.length === 0 && keptAt64k.window === 64_000, j(keptAt64k))
  const foldedAt8k = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 8_000, summarize })
  check('on an 8k gauge the fold fires: the two oldest rows fold into one summary, the newest six stay verbatim', foldedAt8k.compacted === 2 && context.rows.length === 7 && context.rows[0]!.kind === 'summary' && context.rows[0]!.text === 'the summary of the older memory' && context.rows[0]!.folded === 2 && context.rows[6]!.text === 'note 3', j({ ...foldedAt8k, kinds: context.rows.map(r => r.kind) }))
  check("the summarizer was handed the advisor's own fold prompt, the model, and the folded rows only", summaries.length === 1 && summaries[0]!.systemPrompt === advisor.advisorCompactSummaryPrompt() && summaries[0]!.modelId === 'fixture-advisor' && summaries[0]!.transcript.includes('[your note to the agent] note 0') && !summaries[0]!.transcript.includes('note 1'), summaries[0]?.transcript.slice(-200))
  check('the fold prompt is about an advisor\'s memory, three sections, no invention', advisor.advisorCompactSummaryPrompt().includes("advisor's own memory") && advisor.advisorCompactSummaryPrompt().includes('Advice given'))
  const lines = readFileSync(advisor.advisorContextPath('agent-fold', DIR), 'utf8').split('\n').filter(l => l.trim() !== '')
  check('the fold APPENDS its summary row — the file stays append-only like the transcript (no whole-file rewrite route): head + the eight rows + the summary last', lines.length === 10 && (JSON.parse(lines[9]!) as Raw).kind === 'summary' && (JSON.parse(lines[9]!) as Raw).folded === 2, j(lines.map(l => (JSON.parse(l) as Raw).kind)))
  const readBack = advisor.parseAdvisorContextLines('agent-fold', readFileSync(advisor.advisorContextPath('agent-fold', DIR), 'utf8'))
  check('a fresh read applies the fold: the summary stands first for the two oldest rows, the six kept rows follow verbatim', readBack.length === 7 && readBack[0]!.kind === 'summary' && readBack[0]!.folded === 2 && readBack[1]!.text === context.rows[1]!.text && readBack[6]!.text === 'note 3', j(readBack.map(r => r.kind)))
  check('the cursor survives the fold on the kept rows', context.cursor === uuidAt(103))
  const small = getEffectiveContextWindowSize(ADVISOR_MODEL)
  const large = getEffectiveContextWindowSize(`${ADVISOR_MODEL}[1m]`)
  const gauge = await advisor.advisorWindowOf(`${ADVISOR_MODEL}[1m]`)
  check("the live gauge is the ADVISOR model's effective window: a 1M advisor over a 200k agent keeps the longer memory", gauge === large && large > small && small > 100_000, j({ small, large, gauge }))
  const refusing = async (): Promise<string> => {
    throw new Error('the summary road is down')
  }
  const before = context.rows.length
  const refused = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 2_000, summarize: refusing })
  check('a refused fold leaves the rows untouched and says why', refused.compacted === 0 && typeof refused.refused === 'string' && refused.refused.includes('the summary road is down') && context.rows.length === before, j(refused))
}

section('§5 THE ASK ROAD: the agent\'s question plus the digest since the last note → one reply, recorded like a note')
{
  advisor.resetAdvisorContextsForTests()
  const { call, calls } = makeCall(['Check the base first: run the pin on 89017923b before you edit.'])
  const transcript = [operatorRow(1, 'fix the flaky pin'), replyRow(2, 'I will start with the seam')]
  const off = await advisor.askAdvisor('agent-ask', 'am I on the right seam?', transcript as never, { call: call as never, settings: { enabled: false, minutes: 10 }, model: ADVISOR_MODEL, dir: DIR, now })
  check('with the advisor off the ask answers a typed refusal and spends nothing', !off.ok && off.reason.includes('off') && calls.length === 0, j(off))
  const empty = await advisor.askAdvisor('agent-ask', '   ', transcript as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now })
  check('an empty question is refused typed', !empty.ok && empty.reason.includes('empty'))
  const asked = await advisor.askAdvisor('agent-ask', 'am I on the right seam?', transcript as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now })
  check("the reply is the fixture's answer, with the model named", asked.ok && asked.reply === 'Check the base first: run the pin on 89017923b before you edit.' && asked.model === ADVISOR_MODEL, j(asked))
  const prompt = calls[0]!.prompt
  check('the prompt carries the digest since the last note and the question, under the same system prompt', prompt.includes('[operator] fix the flaky pin') && prompt.includes('<the_agents_question>\nam I on the right seam?') && calls[0]!.system === advisor.ADVISOR_SYSTEM_PROMPT && prompt.includes(advisor.ADVISOR_ASK_PROMPT_TAIL), prompt.slice(0, 400))
  const context = advisor.peekAdvisorContext('agent-ask')!
  check('the ask is recorded in the advisor context like a note: digest · question · reply, the cursor advanced', context.rows.map(r => r.kind).join(',') === 'digest,question,reply' && context.cursor === uuidAt(2), j(context.rows.map(r => r.kind)))
  check("an ask is not a look: the interval's clock still runs from the context's opening, so the ask neither delays nor hastens the next note", context.lookedAt === undefined && advisor.advisorClockStart(context) === context.openedAt)
  const { call: call2, calls: calls2 } = makeCall(['note after the ask'])
  const road2 = { call: call2 as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now }
  tick(5)
  const nothingNew = await advisor.advisorTurnSettled('agent-ask', transcript as never, road2)
  check('the due note sees nothing new after the ask consumed the rows: no call, and the look is not stamped — the ask and the clock share one cursor', nothingNew === null && calls2.length === 0 && context.lookedAt === undefined)
  transcript.push(replyRow(3, 'after the ask'))
  await advisor.advisorTurnSettled('agent-ask', transcript as never, road2)
  check('"due" stayed true until a row appeared: the very next boundary with a new row composes the note, remembering the question and the reply (red on the base: a counter that had to fill again)', calls2.length === 1 && context.lookedAt === clock.now && calls2[0]!.prompt.includes('[the agent asked') && calls2[0]!.prompt.includes('[your reply') && calls2[0]!.prompt.includes('[agent] after the ask'), calls2[0]?.prompt.slice(0, 500))
}

section("§6 THE LIVE CALL through the one routing seam: the workload bucket carries the advisor's tokens; a refused model is silent")
{
  state.resetCostState()
  wire.length = 0
  fixture = { kind: 'text', text: 'Line one.\nLine two.' }
  const reply = await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('the live call answers the fixture\'s text', reply.ok && reply.text === 'Line one.\nLine two.', j(reply))
  check('one request left through the loopback fixture, no tools, the model named, the digest as the one user row', wire.length === 1 && wire[0]!.body.model === ADVISOR_MODEL && j((wire[0]!.body.tools as unknown[] | undefined) ?? []) === '[]' && j(wire[0]!.body.messages).includes('the digest'), j(wire[0]?.body).slice(0, 300))
  check("the request's system prompt is the advisor's, its output ceiling the model's own (the main loop's law, never a smaller cap of the advisor's)", j(wire[0]!.body.system).includes('sys') && wire[0]!.body.max_tokens === getMaxOutputTokensForModel(ADVISOR_MODEL) && wire[0]!.body.max_tokens === 128_000, j({ system: wire[0]?.body.system, max: wire[0]?.body.max_tokens, ceiling: getMaxOutputTokensForModel(ADVISOR_MODEL) }))
  const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
  const row = bucket.advisor?.[ADVISOR_MODEL]
  check("the advisor bucket carries the call's tokens (red on the base: no advisor workload) — 90 in · 14 out", row !== undefined && row.inputTokens === 90 && row.outputTokens === 14, j(bucket))
  check('the per-model ledger carries the same turn, and no other bucket exists', (state.getModelUsage() as Record<string, Raw>)[ADVISOR_MODEL]?.inputTokens === 90 && Object.keys(bucket).length === 1, j(Object.keys(bucket)))
  fixture = { kind: 'refuse', status: 401, message: 'no such key for this seat' }
  const refused = await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('a refused advisor model answers ok:false with the reason, never a throw', !refused.ok && refused.reason.length > 0, j(refused))
  advisor.resetAdvisorContextsForTests()
  const transcript = [operatorRow(1, 'hello'), replyRow(2, 'hi')]
  const road = { settings: ON5, model: ADVISOR_MODEL, dir: DIR, now }
  let note: unknown = 'unset'
  note = await afterInterval('agent-refused', transcript, road)
  check('on the clock a refused advisor is silent: no note, nothing in the agent\'s context', note === null)
  const context = advisor.peekAdvisorContext('agent-refused')!
  check('and nothing is recorded in its memory for the refused round, though the look is stamped so the refusal is not repeated at the next boundary', context.rows.length === 0 && context.lookedAt === clock.now)
  wire.length = 0
  note = await advisor.advisorTurnSettled('agent-refused', transcript as never, road)
  check('the very next boundary asks nothing: the interval runs from the refused look', note === null && wire.length === 0)
  fixture = { kind: 'text', text: 'carry on' }
  tick(5)
  note = await advisor.advisorTurnSettled('agent-refused', transcript as never, road)
  check("an advisor that answers 'carry on' lands no row in the agent's context, but its memory records the look", note === null && context.rows.map(r => r.kind).join(',') === 'digest,note', j(context.rows.map(r => r.kind)))
  advisor.resetAdvisorContextsForTests()
  config.saveGlobalConfig(c => {
    const next = { ...c.subModels }
    delete next.advisor
    return { ...c, subModels: Object.keys(next).length > 0 ? next : undefined }
  })
  const unset = advisor.setAdvisorEnabled(true)
  let unsetNote: unknown = 'unset'
  const { call, calls } = makeCall(['never'])
  for (let boundary = 1; boundary <= 3; boundary++) unsetNote = await afterInterval('agent-unset', transcript, { call: call as never, dir: DIR, now })
  check('advisor on but no model pinned: silent with a debug line, no call (the choice is the operator\'s)', unset.enabled && unsetNote === null && calls.length === 0)
  advisor.setAdvisorEnabled(false)
}

section('§7 THE CALL HAS ROOM TO ANSWER: an always-thinking advisor that thinks past the old 1,200-token cap before it writes still lands its words (red on the base: the thinking ate the budget and the note read as no text)')
{
  const THINK = 4000
  const NOTE = 'The two most dangerous: (A) plain-text passwords, one leak exposes every account; (B) the peak-hours migration with no dry run, no way back if it fails.'
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    state.resetCostState()
    wire.length = 0
    fixture = { kind: 'think', tokens: THINK, text: NOTE }
    const reply = await advisor.liveAdvisorCall({ model, system: 'sys', prompt: 'the four decisions', effort: 'max' })
    const body = wire[0]?.body ?? {}
    check(`${model}: the words come back whole after ${THINK} thinking tokens (red on the base: "the advisor answered with no text")`, reply.ok && reply.text === NOTE, j(reply))
    check(`${model}: thinking is always on for this model, so the request carries no thinking key at all (the vendor answers 400 to the disabled shape)`, modelThinkingAlwaysOn(model) && !('thinking' in body), j({ thinking: body.thinking, keys: Object.keys(body) }))
    check(`${model}: max_tokens is the model's own output ceiling, the main loop's law (red on the base: 1200)`, body.max_tokens === getMaxOutputTokensForModel(model) && body.max_tokens === 128_000, j({ max: body.max_tokens, ceiling: getMaxOutputTokensForModel(model) }))
    check(`${model}: the effort dial rides as given, never lowered to make room`, j(body.output_config) === j({ effort: 'max' }), j(body.output_config))
    const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
    check(`${model}: the advisor bucket carries the thinking spend — ${THINK + NOTE_TOKENS} output tokens`, bucket.advisor?.[model]?.outputTokens === THINK + NOTE_TOKENS, j(bucket.advisor?.[model]))
  }
  advisor.resetAdvisorContextsForTests()
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: 'claude-opus-5-5' } }))
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorMinutes(20)
  const dial = slots.setSubModelEffort('advisor', 'max')
  check("the operator's dial: the advisor container's effort set to max on claude-opus-5-5", dial.ok && advisor.advisorDispatchEffort('claude-opus-5-5') === 'max', j(dial))
  wire.length = 0
  fixture = { kind: 'think', tokens: THINK, text: NOTE }
  const transcript = [operatorRow(1, 'four decisions for the release'), replyRow(2, 'which two are the most dangerous?')]
  const note = await afterInterval('agent-dial', transcript, { dir: DIR, now })
  const landed = note as Raw | null
  check("the operator's own condition — the saved model, the saved dial, the saved twenty minutes, the real call — lands the note once the interval has passed (red on the base: null)", landed !== null && landed.text === NOTE && (landed.origin as Raw).model === 'claude-opus-5-5' && (landed.origin as Raw).minutes === 20, j(note))
  check('that request carried output_config.effort max and the 128,000 ceiling, no thinking key', wire.length === 1 && j(wire[0]!.body.output_config) === j({ effort: 'max' }) && wire[0]!.body.max_tokens === 128_000 && !('thinking' in wire[0]!.body), j({ output_config: wire[0]?.body.output_config, max: wire[0]?.body.max_tokens }))
  const callSource = readFileSync(join(ROOT, 'src/services/advisor/advisorCall.ts'), 'utf8')
  check('by source: the advisor call carries no wall clock of its own (a thinking model is never cut) and no output cap of its own', !callSource.includes('AbortSignal.timeout(') && !callSource.includes('maxOutputTokensOverride'), callSource.split('\n').filter(l => l.includes('AbortSignal.timeout(') || l.includes('maxOutputTokensOverride')).join(' | '))
  slots.setSubModelEffort('advisor', null)
  advisor.setAdvisorEnabled(false)
  config.saveGlobalConfig(c => {
    const next = { ...c.subModels }
    delete next.advisor
    return { ...c, subModels: Object.keys(next).length > 0 ? next : undefined }
  })
}

section('§8 ONCE MORE ON AN EMPTY ANSWER, THEN A QUIET ROW: an empty answer is asked once more; still empty, the round hands the chat a muted row instead of silence; a refusal is never asked twice (red on the base: one call, no note, no row)')
{
  const transcript = [operatorRow(1, 'four decisions for the release'), replyRow(2, 'which two are the most dangerous?')]
  const quiets: Raw[] = []
  const onQuiet = (quiet: unknown): void => {
    quiets.push(quiet as Raw)
  }
  advisor.resetAdvisorContextsForTests()
  const once = makeCall(['', 'The real note, on the second ask.'])
  let note: unknown = 'unset'
  note = await afterInterval('agent-once-more', transcript, { call: once.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet, now })
  check('an empty answer is asked once more and the second answer lands as the note — exactly two calls, no quiet row (red on the base: one call, an empty note)', (note as Raw | null)?.text === 'The real note, on the second ask.' && once.calls.length === 2 && quiets.length === 0, j({ note, calls: once.calls.length, quiets: quiets.length }))
  check('the second ask carries the same prompt as the first', once.calls.length === 2 && once.calls[0]!.prompt === once.calls[1]!.prompt)
  advisor.resetAdvisorContextsForTests()
  const twice = makeCall(['', '', 'never a third answer'])
  note = 'unset'
  const twiceRoad = { call: twice.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet, now }
  note = await afterInterval('agent-twice', transcript, twiceRoad)
  check('empty twice: exactly two calls, never a third, and no note (red on the base: one call)', note === null && twice.calls.length === 2, j({ note, calls: twice.calls.length }))
  const quiet = quiets[0]
  check("and the round hands the chat ONE quiet verdict with the advisor origin, marked empty, whose words say the advisor had nothing to say (red on the base: nothing)", quiets.length === 1 && quiet !== undefined && rows.isAdvisorOrigin(quiet.origin) && (quiet.origin as Raw).model === ADVISOR_MODEL && (quiet.origin as Raw).minutes === 5 && (quiet.origin as Raw).at === new Date(clock.now).toISOString() && quiet.empty === true && quiet.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && advisor.advisorQuietWords(quiet as never) === 'had nothing to say this round — answered with no text, twice', j(quiets))
  const twiceContext = advisor.peekAdvisorContext('agent-twice')!
  check("the advisor's memory records nothing for the quiet round and its cursor stays, so the next look reads the same rows again", twiceContext.rows.length === 0 && twiceContext.cursor === undefined, j({ rows: twiceContext.rows.length, cursor: twiceContext.cursor }))
  note = await advisor.advisorTurnSettled('agent-twice', transcript as never, twiceRoad)
  check('the quiet round counts as the look: the very next boundary asks nothing more and paints no second quiet row (the interval runs from the look, not from a note)', note === null && twice.calls.length === 2 && quiets.length === 1 && twiceContext.lookedAt === clock.now)
  tick(5)
  note = await advisor.advisorTurnSettled('agent-twice', transcript as never, twiceRoad)
  check('five minutes on, the same rows are read again and the advisor answers this time', (note as Raw | null)?.text === 'never a third answer' && twice.calls.length === 3 && quiets.length === 1, j({ note, calls: twice.calls.length }))
  const minted = typeof advisor.createAdvisorQuietMessage === 'function'
  check('the service mints the quiet row and its words (red on the base: no such factory)', minted)
  const row = minted ? (advisor.createAdvisorQuietMessage(quiet as never) as unknown as Raw) : ({} as Raw)
  check("the quiet row is a system record of its own subtype with the origin and the words, info level, never meta — a row the transcript keeps and the model never sees", row.type === 'system' && row.subtype === 'advisor_quiet' && minted && advisor.isAdvisorQuietMessage(row) && j(row.origin) === j(quiet!.origin) && row.content === 'had nothing to say this round — answered with no text, twice' && row.level === 'info' && row.isMeta === false && typeof row.uuid === 'string' && typeof row.timestamp === 'string', j(row))
  const { normalizeMessagesForAPI } = await import(join(ROOT, 'src/utils/messages/apiView.ts'))
  const planned = normalizeMessagesForAPI([...transcript, ...(minted ? [row] : [])] as never)
  check('the API plan leaves the quiet row out: the agent never reads it', minted && planned.length === 2 && !j(planned).includes('had nothing to say'), j(planned.map((m: Raw) => m.type)))
  quiets.length = 0
  wire.length = 0
  fixture = { kind: 'refuse', status: 401, message: 'no such key for this seat' }
  advisor.resetAdvisorContextsForTests()
  note = await afterInterval('agent-refused-quiet', transcript, { settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet, now })
  const refusalWords = minted && quiets.length === 1 ? advisor.advisorQuietWords(quiets[0] as never) : ''
  check('a refusal is asked once, never twice, and its quiet row carries the refusal words, not the empty words', note === null && wire.length === 1 && quiets.length === 1 && quiets[0]!.empty === false && refusalWords.startsWith('had nothing to say this round — ') && refusalWords.includes('no such key for this seat'), j({ wire: wire.length, quiets }))
  const long = minted ? advisor.advisorQuietWords({ origin: { kind: 'advisor', model: ADVISOR_MODEL, minutes: 5, at: 'now' }, reason: 'x'.repeat(500), empty: false } as never) : ''
  check(`a long reason is clipped to ${String(advisor.ADVISOR_QUIET_REASON_CLIP)} characters on the row`, minted && long.length === 'had nothing to say this round — '.length + advisor.ADVISOR_QUIET_REASON_CLIP + 1 && long.endsWith('…'), String(long.length))
  wire.length = 0
  fixture = { kind: 'think', tokens: 200_000, text: 'never reached' }
  const overrun = typeof advisor.callAdvisorOnceMore === 'function' ? await advisor.callAdvisorOnceMore(advisor.liveAdvisorCall, { model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' }) : await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('through the live call, a thinking-only turn that stops on max_tokens reads as empty, is asked once more, and answers the twice words — two requests on the wire (red on the base: one request, the one-ask words)', !overrun.ok && overrun.empty === true && overrun.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && wire.length === 2, j({ overrun, wire: wire.length }))
  advisor.resetAdvisorContextsForTests()
  const askOnce = makeCall(['', 'Check the base first.'])
  const asked = await advisor.askAdvisor('agent-ask-once-more', 'am I on the right seam?', transcript as never, { call: askOnce.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('the ask road asks once more too: empty then words answers ok with two calls (red on the base: refused after one)', asked.ok && asked.reply === 'Check the base first.' && askOnce.calls.length === 2, j({ asked, calls: askOnce.calls.length }))
  const askTwice = makeCall(['', ''])
  const unanswered = await advisor.askAdvisor('agent-ask-twice', 'am I on the right seam?', transcript as never, { call: askTwice.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("empty twice on the ask road names it in the reason the tool result carries — the agent is told, never left in silence", !unanswered.ok && unanswered.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && askTwice.calls.length === 2, j(unanswered))
  const crew = makeCall(['a note no crewmate may receive'])
  const crewRoad = { seat: 'crewmate' as const, call: crew.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, now }
  const crewVerdict = await advisor.advisorRound('agent-crew-never', transcript as never, () => {}, crewRoad)
  tick(5)
  const crewLater = await advisor.advisorRound('agent-crew-never', transcript as never, () => {}, crewRoad)
  check("a crewmate's round reads off at every boundary, opens no context, calls nothing and stashes no note — there is no crewmate road any more (red on the base: waiting, then a note)", crewVerdict === 'off' && crewLater === 'off' && crew.calls.length === 0 && advisor.peekAdvisorContext('agent-crew-never') === undefined && advisor.peekAdvisorNotes('agent-crew-never').length === 0 && typeof (advisor as Record<string, unknown>).advisorAgentRound === 'undefined', j({ crewVerdict, crewLater, calls: crew.calls.length }))
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advisor service: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

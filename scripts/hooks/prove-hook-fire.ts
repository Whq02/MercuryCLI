#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-fire-'))
const home = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('FAIL — the fire proof wedged past 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { refreshHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { fireHooks, prepareHooks, answeredNothing } = await import('../../src/utils/hooks/fire.ts')
const { forgetSpentHooks } = await import('../../src/utils/hooks/matching.ts')
const { subscribeHookExecutionEvents, withHookRunContext } = await import('../../src/utils/hooks/hookEvents.ts')
const { takeBackgroundHookOutcomes, backgroundHooksRunning, endBackgroundHooks, resetBackgroundHooksForTesting } = await import('../../src/utils/hooks/background.ts')
const { hookRowsOfResult } = await import('../../src/utils/hooks/rows.ts')
const { HOOK_CUT_BUDGET_MS } = await import('../../src/utils/hooks/contract.ts')
const { hookEndingSentence, HOOK_ENDING_CLASSES } = await import('../../src/rows/vocabulary.ts')
const { dequeueAll } = await import('../../src/utils/messageQueueManager.ts')

type Entry = Record<string, unknown>
const install = (hooks: Record<string, Entry[]>): void => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks } }))
  refreshHooksSnapshot()
  forgetSpentHooks()
}
const scope = { sessionId: 'fire-session-1', cwd }
const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const say = (json: Entry): string => `echo ${q(JSON.stringify(json))}`
const turnStart = () => fireHooks('turn.start', { turn_id: 'turn-1', prompt: 'hello' }, { scope })

{
  install({ 'turn.start': [{ name: 'quiet', run: 'exit 0' }, { name: 'plain', run: 'echo a plain line' }, { name: 'shaped', run: say({ context: 'shaped context', notice: 'a notice' }) }] })
  const result = await turnStart()
  const by = Object.fromEntries(result.outcomes.map(o => [o.name, o.state]))
  check('exit 0 with nothing on stdout answers nothing', by.quiet?.kind === 'answered' && Object.keys((by.quiet as { answer: object }).answer).length === 0)
  check('exit 0 with plain words is plain text, read as context on turn.start', by.plain?.kind === 'text' && result.answer.contexts.includes('a plain line'))
  check('exit 0 with a JSON object is the answer, its fields folded', by.shaped?.kind === 'answered' && result.answer.contexts.includes('shaped context') && result.answer.notices.includes('a notice'))
  check('every outcome carries the entry name, the event, the source and a duration', result.outcomes.every(o => o.event === 'turn.start' && o.source.kind === 'settings' && typeof o.durationMs === 'number' && ['quiet', 'plain', 'shaped'].includes(o.name)))
  const rows = hookRowsOfResult(result)
  check('the rows: one context row per context, one notice row, and the plain text as a context row on a context event', rows.filter(r => r.outcome === 'context').length === 2 && rows.filter(r => r.outcome === 'notice').length === 1 && rows.every(r => r.type === 'hook' && r.event === 'turn.start'), JSON.stringify(rows))
}

{
  install({ 'turn.start': [{ name: 'gate', run: 'echo not today >&2; exit 2' }, { name: 'mute gate', run: 'exit 2' }, { name: 'broken', run: 'echo it broke >&2; exit 1' }] })
  const result = await turnStart()
  const by = Object.fromEntries(result.outcomes.map(o => [o.name, o.state]))
  check('exit 2 blocks with the words on stderr', by.gate?.kind === 'answered' && (by.gate as { answer: { block?: string } }).answer.block === 'not today')
  check('exit 2 without a word still blocks, and the row says so', by['mute gate']?.kind === 'answered' && (by['mute gate'] as { answer: { block?: string } }).answer.block === 'mute gate blocked turn.start without a word')
  check('the blocks fold into one, joined by newlines', result.answer.block === 'not today\nmute gate blocked turn.start without a word', String(result.answer.block))
  const brokenLine = by.broken?.kind === 'failed' ? (by.broken as { line: string }).line : ''
  check('any other exit is a failed hook: one sentence from the row vocabulary naming the hook, the event, the code and stderr', by.broken?.kind === 'failed' && brokenLine === hookEndingSentence({ status: 'failed', class: 'exit', exit_code: 1, detail: 'it broke' }, { name: 'broken', event: 'turn.start' }) && brokenLine.includes('broken') && brokenLine.includes('turn.start') && brokenLine.includes('it broke'), brokenLine)
  const rows = hookRowsOfResult(result)
  check('a failed hook is a failed row, a block a block row', rows.some(r => r.outcome === 'failed' && r.name === 'broken') && rows.filter(r => r.outcome === 'block').length === 2)
}

{
  install({ 'turn.start': [{ name: 'stranger', run: say({ permission: 'allow' }) }, { name: 'not an object', run: 'echo "[1,2]"' }, { name: 'bad json', run: 'echo "{not json"' }, { name: 'wrong type', run: say({ context: 7 }) }] })
  const result = await turnStart()
  const by = Object.fromEntries(result.outcomes.map(o => [o.name, o.state as { kind: string; line?: string }]))
  check('a field the event does not read is refused loudly, naming the fields it reads', by.stranger.kind === 'failed' && String(by.stranger.line).includes('`permission` is not an answer turn.start reads') && String(by.stranger.line).includes('`block`'), String(by.stranger.line))
  check('stdout that does not open a brace is plain words, even when it is JSON (an array is context on turn.start)', by['not an object'].kind === 'text' && result.answer.contexts.includes('[1,2]'))
  check('stdout opening a brace that does not parse is a failed hook, never silent', by['bad json'].kind === 'failed' && String(by['bad json'].line).includes('does not parse'), String(by['bad json'].line))
  check('a field of the wrong type is refused with its path', by['wrong type'].kind === 'failed' && String(by['wrong type'].line).includes('`context`'), String(by['wrong type'].line))
  check('the refusal lines use the answer ending class of the row vocabulary, and a refused hook adds no context', HOOK_ENDING_CLASSES.includes('answer' as never) && result.answer.contexts.length === 1)
}

{
  install({ 'tool.after': [{ name: 'texty', run: 'echo plain after words' }, { name: 'setter one', run: say({ output: 'first' }) }, { name: 'setter two', run: say({ output: 'second' }) }] })
  const result = await fireHooks('tool.after', { call_id: 'c1', tool: 'Read', input: {}, ok: true, output: 'x', cut: false }, { scope })
  check('plain text on an event the model does not read from stdout is kept as text, not context', result.outcomes.some(o => o.state.kind === 'text') && result.answer.contexts.length === 0)
  check('two hooks setting one single-setter field: the later wins and the conflict is a notice row', result.answer.output === 'second' && result.answer.conflicts.length === 1 && result.answer.conflicts[0]!.winner === 'setter two' && hookRowsOfResult(result).some(r => r.outcome === 'notice' && r.words.includes('setter two wins')), JSON.stringify(result.answer.conflicts))
  const rows = hookRowsOfResult(result, { callId: 'c1' })
  check('the text row rides as text with the call id, so the transcript can hang it on its call', rows.some(r => r.outcome === 'text' && r.callId === 'c1'))
}

{
  install({ 'permission.ask': [{ name: 'allow it', run: say({ permission: 'allow' }) }, { name: 'ask me', run: say({ permission: 'ask', rules: [{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' }] }) }, { name: 'allow again', run: say({ permission: 'allow', rules: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }] }) }] })
  const result = await fireHooks('permission.ask', { call_id: 'c2', tool: 'Read', input: {} }, { scope })
  check('on permission.ask an ask beats every allow, and the rules of all the hooks concatenate', result.answer.permission === 'ask' && (result.answer.rules?.length ?? 0) === 2, JSON.stringify(result.answer))
}

{
  install({ 'turn.start': [{ name: 'only once', run: 'echo once-ran >> ' + q(join(root, 'once.log')), once: true }, { name: 'every time', run: 'echo every-ran >> ' + q(join(root, 'every.log')) }] })
  await turnStart()
  await turnStart()
  const otherScope = await fireHooks('turn.start', { turn_id: 'turn-x', prompt: 'hi' }, { scope: { sessionId: 'fire-session-2', cwd } })
  const onceRuns = readFileSync(join(root, 'once.log'), 'utf8').trim().split('\n').length
  const everyRuns = readFileSync(join(root, 'every.log'), 'utf8').trim().split('\n').length
  check('`once` runs once per session: the second fire skips it, the other hook runs every time', onceRuns === 2 && everyRuns === 3 && otherScope.outcomes.some(o => o.name === 'only once'), `once ${onceRuns} every ${everyRuns} other ${otherScope.outcomes.map(o => o.name).join(',')}`)
}

{
  install({ 'turn.start': [{ name: 'slow', run: 'sleep 20', timeout: 10 }] })
  const started = Date.now()
  const result = await fireHooks('turn.start', { turn_id: 'turn-1', prompt: 'hello' }, { scope, budgetMs: HOOK_CUT_BUDGET_MS })
  const took = Date.now() - started
  const state = result.outcomes[0]!.state as { kind: string; line?: string }
  check('a budget on the fire caps every hook clock: the slow hook is ended inside the cut budget and its line names the 1.5s it had', state.kind === 'failed' && String(state.line).includes('1.5s') && took < HOOK_CUT_BUDGET_MS + 4_000, `${took}ms ${state.line}`)
}

{
  install({ 'turn.start': [{ name: 'strange kind', question: 'is it fine?' }] })
  const result = await turnStart()
  const state = result.outcomes[0]!.state as { kind: string; line?: string }
  check('a question hook fired where no model seat is at hand fails loudly instead of running', state.kind === 'failed' && String(state.line).includes('needs a model seat'), String(state.line))
  install({ 'session.end': [{ name: 'asks at the end', question: 'what?' }, { name: 'runs at the end', run: 'echo ok' }] })
  const result2 = await fireHooks('session.end', { reason: 'quit' }, { scope })
  check('a kind an event does not run (a question on session.end) never loads from the settings; the run hook beside it does', result2.outcomes.length === 1 && result2.outcomes[0]!.name === 'runs at the end', result2.outcomes.map(o => o.name).join(','))
}

{
  resetBackgroundHooksForTesting()
  install({ 'turn.start': [
    { name: 'bg fine', run: 'sleep 0.3; ' + say({ notice: 'done in the back' }), background: true },
    { name: 'bg blocker', run: 'echo late no >&2; exit 2', background: true },
    { name: 'bg wrong field', run: 'sleep 0.2; ' + say({ block: 'x' }), background: true },
    { name: 'bg waker', run: 'echo wake up >&2; exit 2', wake: true },
  ] })
  const result = await turnStart()
  check('background hooks come back at once as background outcomes and never block the event', result.outcomes.every(o => o.state.kind === 'background') && result.answer.block === undefined && backgroundHooksRunning() > 0)
  check('a background fire answers nothing in the foreground', answeredNothing(result))
  const rows = hookRowsOfResult(result)
  check('a background start writes no row', rows.length === 0)
  await new Promise(resolve => setTimeout(resolve, 1_500))
  const settled = takeBackgroundHookOutcomes()
  const by = Object.fromEntries(settled.map(o => [o.name, o.state as { kind: string; line?: string; answer?: Record<string, unknown> }]))
  check('a finished background hook delivers its notice when the attachments next ask', by['bg fine']?.kind === 'answered' && by['bg fine'].answer?.notice === 'done in the back', JSON.stringify(by['bg fine']))
  check('a background hook cannot block: its exit 2 is a failed line saying what `wake` would do', by['bg blocker']?.kind === 'failed' && String(by['bg blocker'].line).includes('cannot block') && String(by['bg blocker'].line).includes('`wake`'), String(by['bg blocker']?.line))
  check('a background hook answering a foreground field is refused, naming the two it may answer', by['bg wrong field']?.kind === 'failed' && String(by['bg wrong field'].line).includes('context and notice'), String(by['bg wrong field']?.line))
  const woke = dequeueAll().map(n => ({ value: typeof n.value === 'string' ? n.value : JSON.stringify(n.value) }))
  check('a `wake` hook that blocks wakes the model with its words as a notification, and leaves a notice', by['bg waker']?.kind === 'answered' && String(by['bg waker'].answer?.notice).includes('wake up') && woke.some(n => n.value.includes('bg waker') && n.value.includes('wake up')), JSON.stringify({ waker: by['bg waker'], woke }))
  check('the settled outcomes are taken once', takeBackgroundHookOutcomes().length === 0)
  install({ 'turn.start': [{ name: 'bg long', run: 'sleep 30', background: true }] })
  await turnStart()
  const started = Date.now()
  await endBackgroundHooks()
  check('the session end kills what still runs in the background and waits for it', backgroundHooksRunning() === 0 && Date.now() - started < 5_000)
}

{
  install({ 'turn.start': [{ name: 'marked', run: 'echo marked-output' }] })
  const marks: Array<{ type: string; hookName: string; hookEvent: string }> = []
  const unsubscribe = subscribeHookExecutionEvents(event => { marks.push({ type: event.type, hookName: event.hookName, hookEvent: event.hookEvent }) })
  await turnStart()
  unsubscribe()
  check('every run emits a started mark and a response mark naming the hook and the event, for the task rows outside a turn', marks.map(m => m.type).join(',') === 'started,response' && marks.every(m => m.hookName === 'marked' && m.hookEvent === 'turn.start'), JSON.stringify(marks))
}

{
  install({ 'turn.start': [{ name: 'reads payload', run: `cat > ${q(join(root, 'payload.json'))}` }] })
  await withHookRunContext({ sessionId: 'daemon-worker-7', cwd, transcriptPath: join(root, 'worker.jsonl') }, () => fireHooks('turn.start', { turn_id: 't-7', prompt: 'from the daemon' }, { scope: { sessionId: 'ignored-when-context-rules' }, permissionMode: 'default' }))
  const payload = JSON.parse(readFileSync(join(root, 'payload.json'), 'utf8')) as Record<string, unknown>
  check('the payload carries the base fields and the event fields, nothing more', JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['cwd', 'event', 'permission_mode', 'prompt', 'session_id', 'transcript_path', 'turn_id']), JSON.stringify(payload))
  check('under the daemon run context the session id, cwd and transcript path are the worker data, not the process', payload.session_id === 'daemon-worker-7' && payload.cwd === cwd && payload.transcript_path === join(root, 'worker.jsonl'), JSON.stringify(payload))
  check('the event is named in the payload as the event word', payload.event === 'turn.start')
}

{
  install({ 'turn.start': [{ name: 'prepared', run: 'echo prepared-ran >> ' + q(join(root, 'prepared.log')) }] })
  const prepared = await prepareHooks('turn.start', { turn_id: 't', prompt: 'p' }, { scope })
  check('prepareHooks names what will run before running it', prepared.names.join(',') === 'prepared' && !existsSync(join(root, 'prepared.log')))
  await prepared.run()
  check('…and runs it on demand', existsSync(join(root, 'prepared.log')))
  install({ 'tool.before': [{ name: 'matched', run: 'echo m', match: 'Read' }, { name: 'unmatched', run: 'echo u', match: 'Bash' }, { name: 'any tool', run: 'echo a' }], 'turn.start': [{ name: 'no match field here', run: 'echo t', match: 'goodbye' }] })
  const matched = await prepareHooks('tool.before', { call_id: 'c', tool: 'Read', input: {} }, { scope })
  check('match reads the event\'s match field (the tool on tool.before) as a pattern; an entry without one matches every call', matched.names.join(',') === 'matched,any tool', matched.names.join(','))
  const unmatchable = await prepareHooks('turn.start', { turn_id: 't', prompt: 'hello there' }, { scope })
  check('`match` on an event that has no match field is refused at the door: the entry never loads', unmatchable.names.length === 0, unmatchable.names.join(','))
  process.env.MERCURY_BARE = '1'
  const bare = await prepareHooks('turn.start', { turn_id: 't', prompt: 'hello there' }, { scope })
  delete process.env.MERCURY_BARE
  check('a bare session fires nothing', bare.names.length === 0)
}

{
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  const { resetTrustDialogAcceptedCacheForTesting } = await import('../../src/utils/config/trust.ts')
  const { workspaceUntrustedForHooks } = await import('../../src/utils/hooks/fire.ts')
  install({ 'turn.start': [{ name: 'trust probe', run: 'echo trusted-ran >> ' + q(join(root, 'trust.log')) }] })
  delete process.env.MERCURY_TRUST_DIALOG_ACCEPTED
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  setIsInteractive(true)
  const untrusted = await prepareHooks('turn.start', { turn_id: 't', prompt: 'p' }, { scope })
  check('the cockpit runs nothing until the workspace is trusted', workspaceUntrustedForHooks() && untrusted.names.length === 0 && !existsSync(join(root, 'trust.log')), `untrusted ${workspaceUntrustedForHooks()} names ${untrusted.names.join(',')}`)
  setIsInteractive(false)
  const headless = await prepareHooks('turn.start', { turn_id: 't', prompt: 'p' }, { scope })
  check('the headless road is gated by its own layer law, not the cockpit dialog', headless.names.length === 1, headless.names.join(','))
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
  setIsInteractive(true)
  const trusted = await prepareHooks('turn.start', { turn_id: 't', prompt: 'p' }, { scope })
  check('once trusted, the cockpit runs its hooks', trusted.names.length === 1, trusted.names.join(','))
  setIsInteractive(false)
}

clearTimeout(watchdog)
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'HOOK FIRE GREEN' : `${failures} HOOK FIRE FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

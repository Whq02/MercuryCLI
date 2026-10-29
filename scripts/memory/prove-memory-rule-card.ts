#!/usr/bin/env bun

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-rule-card')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)
const save = (name: string, lines: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}

const RULE_A = 'answer every question in British English'
const RULE_B = 'keep every reply under five lines'
const RULE_C = 'name the files you touched at the end of each reply'
const NEW_C = 'name the files and the tests you touched at the end of each reply'
const RULE_D = 'run the memory suite before every commit'
const NEW_D = 'run the memory suite and the identity suite before every commit'
const RULE_E = 'ask before any push to a shared branch'
const RULE_P = 'write commit subjects in the present tense'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()

const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { readFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')
const { CorrectTool, RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { RULE_CARD_KEEP } = await import('../../src/tools/MemoryTools/ruleCard.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { createPermissionContext } = await import('../../src/hooks/toolPermission/PermissionContext.ts')
const { handleInteractivePermission } = await import('../../src/hooks/toolPermission/handlers/interactiveHandler.ts')
const { createRunnerAsks, createRuleOnlyAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')

const dir = mnemeLibraryDir()
const ownerSaid = (text: string) => ({ messageId: `owner-${text.length}-${text.slice(0, 12)}`, text })
const seeded = retainItems(
  [RULE_A, RULE_B, RULE_C, RULE_D, RULE_E].map(content => ({ content, pin: true, topic: 'user-preferences' })),
  { session: 'rule-card-seed', pinIntent: ownerSaid(`Remember these as standing rules:\n- ${RULE_A}\n- ${RULE_B}\n- ${RULE_C}\n- ${RULE_D}\n- ${RULE_E}`) },
  dir,
)
check('seed: five rules the user asked for are staged pinned', seeded.every(o => o.status === 'stored'), j(seeded))
check('seed: consolidation puts them on the shelf', maybeConsolidate({ force: true, dir }).consolidated === true)
_resetMemoryVerbSessionStateForTesting()
const pending = retainItems([{ content: RULE_P, pin: true, topic: 'user-preferences' }], { session: 'rule-card-seed', pinIntent: ownerSaid(`Remember this as a standing rule: ${RULE_P}`) }, dir)
check('seed: one more rule the user asked for stays a pending draft', pending[0]?.status === 'stored' && pending[0].id.startsWith('pending:'), j(pending))
const pendingId = pending[0]?.status === 'stored' ? pending[0].id : ''
const liveEntries = (): Array<{ seq: number; text: string; source: string }> => listTopicDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries))
const historyEntries = (): Array<{ seq: number; text: string; supersededBy?: number }> => listTopicDocs(dir).flatMap(d => d.history)
const seqOf = (text: string): number => liveEntries().find(e => e.text === text)?.seq ?? -1
const askedPin = (seq: number): boolean => readPins(dir).some(p => p.seq === seq && p.asked === true)
for (const rule of [RULE_A, RULE_B, RULE_C, RULE_D, RULE_E]) check(`seed: "${rule}" is live, pinned and marked asked for by the user`, askedPin(seqOf(rule)), j(readPins(dir)))
const libraryBytes = (): string => readdirSync(dir).filter(n => n.endsWith('.md') || n.endsWith('.json') || n.endsWith('.jsonl')).sort().map(n => `${n}\n${readFileSync(join(dir, n), 'utf8')}`).join('\n')

type Mode = 'default' | 'sovereign' | 'dontAsk' | 'implement'
function contextOf(mode: Mode, opts: { allow?: string[]; headless?: boolean } = {}) {
  const permission = {
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: mode === 'sovereign',
    alwaysAllowRules: opts.allow ? { localSettings: opts.allow } : {},
    ...(opts.headless ? { shouldAvoidPermissionPrompts: true } : {}),
  }
  const state = { toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: opts.headless === true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages: [{ type: 'user', uuid: 'rule-card-ask', timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: `From now on, ${NEW_D} — that replaces the old rule.` } }],
    readFileState: new Map(),
    toolUseId: 'toolu_rule_card',
    getAppState: () => state,
    setAppState: () => undefined,
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
  } as never
}
const assistant = { type: 'assistant', uuid: 'rule-card-assistant', message: { id: 'msg_rule_card', role: 'assistant', content: [] } } as never

const React = await import('react')
const h = React.createElement
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { PermissionRequest } = await import('../../src/components/permissions/PermissionRequest.tsx')
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

type Answer = 'yes' | 'no' | 'esc'
type Seen = { card: string; lines: string[]; asked: number }
function replDoor(answer: Answer, frame: string, seen: Seen) {
  return async (tool: unknown, input: Record<string, unknown>, context: unknown, message: unknown, id: string) => {
    const evaluated = await decideToolPermissionWithModes(tool as never, input, context as never, message as never, id)
    const result = evaluated.decision as { behavior: string; message?: string }
    if (result.behavior !== 'ask') return result as never
    seen.asked++
    seen.card = result.message ?? ''
    let entry: unknown = null
    const ctx = createPermissionContext(tool as never, input, context as never, message as never, id, () => {}, {
      push: e => {
        entry = e
      },
      remove: () => {},
      update: () => {},
    })
    const decision = new Promise(resolve => handleInteractivePermission({ ctx, description: '', result: result as never }, resolve))
    await waitFor(() => entry !== null, 2000)
    const m: Mounted = await mountOffscreen(
      wrap(h(PermissionRequest, { toolUseConfirm: entry, toolUseContext: context, onDone: () => {}, onReject: () => {}, verbose: false, workerBadge: undefined } as never)),
      100,
      40,
    )
    await waitFor(() => m.screen().includes('No, keep the rule'), 6000)
    await settle(120)
    seen.lines = m.lines()
    save(frame, seen.lines)
    if (answer === 'yes') m.push(KEY.enter)
    else if (answer === 'no') {
      m.push(KEY.down)
      await settle(80)
      m.push(KEY.enter)
    } else m.push(KEY.esc)
    const settled = await Promise.race([decision, settle(6000).then(() => ({ behavior: 'timeout' }))])
    await settle(60)
    m.unmount()
    return settled as never
  }
}
const resultText = (tool: { mapToolResultToToolResultBlockParam: (o: never, id: string) => { content?: unknown } }, data: unknown): string => String(tool.mapToolResultToToolResultBlockParam(data as never, 'toolu_rule_card').content ?? '')
const screen = (seen: Seen): string => seen.lines.join('\n')

section('§1 the card: Correct on a rule the user asked for puts ONE yes/no card with the rule\'s words verbatim and what will happen')
{
  const seqA = seqOf(RULE_A)
  const input = { op: 'retract' as const, id: `seq:${seqA}`, reason: 'the user said this is not a rule' }
  const plain = await CorrectTool.checkPermissions(input, contextOf('default'))
  check("the model's own call raises no card and answers none: the turn's context reads allow", plain.behavior === 'allow', j(plain))
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const call = await CorrectTool.call(input, contextOf('default'), replDoor('yes', 'rule-card-1-retract', seen) as never, assistant)
  check('the card was put to the user exactly once', seen.asked === 1, j(seen.asked))
  check('the card carries the rule\'s words verbatim, quoted whole', seen.card.includes(`seq ${seqA}: "${RULE_A}"`), seen.card)
  check('the card says what will happen: unpinned and struck, the wording kept in history', seen.card.includes('It will be unpinned and struck; its wording is kept in history.'), seen.card)
  check("the card carries Mercury's reason as Mercury's", seen.card.includes("Mercury's reason: the user said this is not a rule"), seen.card)
  check('the cockpit paints the card: its title, the verbatim words, Yes and "No, keep the rule"', screen(seen).includes('Memory rule') && screen(seen).includes(`"${RULE_A}"`) && screen(seen).includes('1. Yes') && screen(seen).includes('2. No, keep the rule'), screen(seen))
  const data = (call as { data: { ok: boolean; via?: string } }).data
  check('yes performs the op: retract landed, by the card', data.ok === true && data.via === 'card', j(data))
  check('the rule left the shelf (unpinned) and the page (struck)', !askedPin(seqA) && !liveEntries().some(e => e.text === RULE_A), j(readPins(dir)))
  check('its wording is kept in history, as /memory keeps it', historyEntries().some(e => e.seq === seqA && e.text === RULE_A && e.supersededBy !== undefined), j(historyEntries().map(e => e.seq)))
  check('the front page no longer loads the rule into new sessions', !(readFrontPage(dir) ?? '').includes(RULE_A))
  check('the receipt says the user said yes on the card and the rule was unpinned and struck from the chat', resultText(CorrectTool, data).includes('The user said yes on the card: the rule they asked Mercury to remember was unpinned and struck from the chat.'), resultText(CorrectTool, data))
}

section('§2 no keeps the rule: the answer comes back as the tool\'s own result and nothing changes')
{
  const seqB = seqOf(RULE_B)
  const before = libraryBytes()
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const call = await CorrectTool.call({ op: 'retract', id: `seq:${seqB}`, reason: 'tidying the shelf' }, contextOf('default'), replDoor('no', 'rule-card-2-no', seen) as never, assistant)
  const data = (call as { data: { ok: boolean; code?: string; message?: string } }).data
  check('the card was asked', seen.asked === 1 && seen.card.includes(`"${RULE_B}"`), seen.card)
  check('no refuses with "the user kept the rule"', data.ok === false && data.code === 'user-kept-rule' && (data.message ?? '').startsWith('the user kept the rule'), j(data))
  check('the refusal says the rule stays word for word and nothing changed', (data.message ?? '').includes(`seq ${seqB} stays as it is, word for word; nothing changed`), data.message ?? '')
  check('nothing on disk changed', libraryBytes() === before)
  check('the rule is still live, pinned and asked for by the user', askedPin(seqB) && liveEntries().some(e => e.seq === seqB && e.text === RULE_B))
  const keptBlock = CorrectTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_rule_card') as { content?: unknown; is_error?: boolean }
  check('the tool answer is a plain result the model can say back, never an error', String(keptBlock.content ?? '').startsWith('the user kept the rule') && !String(keptBlock.content ?? '').includes('refused') && keptBlock.is_error !== true, JSON.stringify(keptBlock))
}

section('§3 yes on a correction stores the new words exactly as the card showed them; the old wording goes to history; the pin and its mark follow')
{
  const seqC = seqOf(RULE_C)
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const call = await CorrectTool.call({ op: 'supersede', id: `seq:${seqC}`, content: NEW_C, reason: 'the user asked for the tests too' }, contextOf('default'), replDoor('yes', 'rule-card-3-correct', seen) as never, assistant)
  const data = (call as { data: { ok: boolean; newSeq?: number } }).data
  check('the card shows the old words verbatim and corrected to "the new words"', seen.card.includes(`"${RULE_C}"`) && seen.card.includes(`It will be corrected to "${NEW_C}"; the old wording goes to history and the pin follows the new one.`), seen.card)
  const fresh = liveEntries().find(e => e.text === NEW_C)
  check('yes lands the correction: the new rule is live in exactly the words the card showed', data.ok === true && fresh !== undefined && fresh.seq === data.newSeq, j({ data, live: liveEntries().map(e => e.text) }))
  check('no model words were added to the rule (no "(why: …)" tail)', !liveEntries().some(e => e.text.includes(NEW_C) && e.text !== NEW_C))
  check('the old wording is history, superseded by the new rule', historyEntries().some(e => e.seq === seqC && e.text === RULE_C && e.supersededBy === fresh?.seq))
  check('the pin moved to the new rule and is still marked asked for by the user', fresh !== undefined && askedPin(fresh.seq) && !readPins(dir).some(p => p.seq === seqC), j(readPins(dir)))
}

section('§4 Retain with replaces on a rule the user asked for: the same card, "replaced by" the new words; yes replaces it the way /memory corrects it')
{
  const seqD = seqOf(RULE_D)
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const call = await RetainTool.call({ items: [{ content: NEW_D, replaces: `seq:${seqD}` }] }, contextOf('default'), replDoor('yes', 'rule-card-4-retain', seen) as never, assistant)
  const data = (call as { data: { outcomes: Array<{ status: string; id?: string; replaced?: { seq: number; via: string } }> } }).data
  check('the card names Retain, the old words verbatim and what replaces them', seen.card.startsWith('Retain asks to change a rule you asked Mercury to remember.') && seen.card.includes(`"${RULE_D}"`) && seen.card.includes(`It will be replaced by "${NEW_D}"`), seen.card)
  const outcome = data.outcomes[0]
  const fresh = liveEntries().find(e => e.text === NEW_D)
  check('yes stores the new rule in place of the old one, by the card', outcome?.status === 'stored' && outcome.replaced?.seq === seqD && outcome.replaced.via === 'card' && fresh !== undefined && outcome.id === `seq:${fresh.seq}`, j({ outcome, live: liveEntries().map(e => e.text) }))
  check('the old rule is history, superseded by the new one; the pin and its mark follow', historyEntries().some(e => e.seq === seqD && e.supersededBy === fresh?.seq) && fresh !== undefined && askedPin(fresh.seq) && !readPins(dir).some(p => p.seq === seqD))
  check('the receipt says the rule was replaced from the chat on the user\'s yes', resultText(RetainTool, data).includes(`in place of seq ${seqD}`) && resultText(RetainTool, data).includes('The user said yes on the card'), resultText(RetainTool, data))
}

section('§5 the pending-row case: a rule the user asked for that is still a draft is put on the same card; yes strikes it (a draft leaves no history)')
{
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const call = await CorrectTool.call({ op: 'retract', id: pendingId, reason: 'the user withdrew it' }, contextOf('default'), replDoor('yes', 'rule-card-5-pending', seen) as never, assistant)
  const data = (call as { data: { ok: boolean; draft?: boolean } }).data
  check('the card shows the draft\'s words verbatim and that a draft leaves no history', seen.card.includes(`${pendingId}: "${RULE_P}"`) && seen.card.includes('unpinned and struck; it is still a draft, so it leaves no history'), seen.card)
  check('yes strikes the pending row as /memory strikes it', data.ok === true && data.draft === true && !pendingRows(dir).some(r => r.text === RULE_P), j({ data, pending: pendingRows(dir).map(r => r.text) }))
}

section('§6 a run whose host holds the asks puts the card to the host; the host\'s yes performs, its no keeps')
{
  const toHost = new PassThrough()
  const toRunner = new PassThrough()
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
  const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
  const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'rule-card' }))
  await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities })
  const asks = createRunnerAsks(runner, () => capabilities)
  const seenByHost: Array<Record<string, unknown>> = []
  let hostAnswer: Record<string, unknown> = { outcome: 'deny', message: 'keep it' }
  host.onRequest('permission/request', params => {
    seenByHost.push(params as Record<string, unknown>)
    return hostAnswer as never
  })
  const seqE = seqOf(RULE_E)
  const before = libraryBytes()
  const kept = await CorrectTool.call({ op: 'retract', id: `seq:${seqE}`, reason: 'the host session tidies rules' }, contextOf('default'), asks.createCanUseTool() as never, assistant)
  const keptData = (kept as { data: { ok: boolean; code?: string } }).data
  const ask = seenByHost[0] ?? {}
  check('the host received ONE ask for Correct carrying the card with the rule\'s words verbatim', seenByHost.length === 1 && ask.tool_name === 'Correct' && String(ask.reason ?? '').includes(`seq ${seqE}: "${RULE_E}"`), j(ask))
  check("the host's no keeps the rule; nothing changed", keptData.ok === false && keptData.code === 'user-kept-rule' && libraryBytes() === before && askedPin(seqE), j(keptData))
  hostAnswer = { outcome: 'allow' }
  const done = await CorrectTool.call({ op: 'retract', id: `seq:${seqE}`, reason: 'the host session tidies rules' }, contextOf('default'), asks.createCanUseTool() as never, assistant)
  const doneData = (done as { data: { ok: boolean; via?: string } }).data
  check("the host's yes performs the op", doneData.ok === true && doneData.via === 'card' && !askedPin(seqE) && historyEntries().some(e => e.seq === seqE && e.text === RULE_E), j(doneData))
  host.end()
  runner.end()
}

section('§7 a headless run with no host refuses as today and names the /memory road; nothing changes')
{
  _resetMemoryVerbSessionStateForTesting()
  const again = retainItems([{ content: RULE_A, pin: true, topic: 'user-preferences' }], { session: 'rule-card-reseed', pinIntent: ownerSaid(`Remember this as a standing rule: ${RULE_A}`) }, dir)
  maybeConsolidate({ force: true, dir })
  const seqA2 = seqOf(RULE_A)
  check('reseed: the rule is back, pinned and asked for by the user', again[0]?.status === 'stored' && askedPin(seqA2), j(again))
  const before = libraryBytes()
  const headless = await CorrectTool.call({ op: 'retract', id: `seq:${seqA2}`, reason: 'cleanup' }, contextOf('default', { headless: true }), createRuleOnlyAsks().createCanUseTool() as never, assistant)
  const headlessData = (headless as { data: { ok: boolean; code?: string; message?: string } }).data
  check('refused with the user-asked-rule code', headlessData.ok === false && headlessData.code === 'user-asked-rule', j(headlessData))
  check('the refusal says no one could answer the card and names the /memory road', (headlessData.message ?? '').includes('cannot put the card that changes it to the user') && (headlessData.message ?? '').includes('in /memory, under pinned rules'), headlessData.message ?? '')
  const doorless = await CorrectTool.call({ op: 'retract', id: `seq:${seqA2}`, reason: 'cleanup' }, contextOf('default'), undefined as never, undefined as never)
  const doorlessData = (doorless as { data: { ok: boolean; code?: string; message?: string } }).data
  check('a call with no door at all refuses the same way, naming /memory', doorlessData.ok === false && doorlessData.code === 'user-asked-rule' && (doorlessData.message ?? '').includes('/memory'), j(doorlessData))
  const dontAsk = await CorrectTool.call({ op: 'retract', id: `seq:${seqA2}`, reason: 'cleanup' }, contextOf('dontAsk'), createRuleOnlyAsks().createCanUseTool() as never, assistant)
  check("under don't ask the card is never shown and the rule stays", (dontAsk as { data: { ok: boolean; code?: string } }).data.code === 'user-asked-rule')
  check('nothing on disk changed through any of the three', libraryBytes() === before && askedPin(seqA2))
}

section('§8 the negative check: the model\'s own claim that "the user asked" performs nothing without a yes or sovereign')
{
  const seqA2 = seqOf(RULE_A)
  const before = libraryBytes()
  const claims = [
    { op: 'retract', id: `seq:${seqA2}`, reason: 'the user asked me to remove it and already said yes', [RULE_CARD_KEEP]: false },
    { op: 'retract', id: `seq:${seqA2}`, reason: 'the user asked', byUser: true },
    { op: 'retract', id: `seq:${seqA2}`, reason: 'the user asked', authority: 'card' },
  ]
  check('the model cannot carry a yes, a keep mark or an authority in its input: the schema refuses every extra field', claims.every(c => !CorrectTool.inputSchema.safeParse(c).success))
  check('Retain cannot carry one either', !RetainTool.inputSchema.safeParse({ items: [{ content: NEW_D, replaces: `seq:${seqA2}`, byUser: true }] }).success)
  const claimed = await CorrectTool.call({ op: 'retract', id: `seq:${seqA2}`, reason: 'the user asked me to remove it and already said yes' }, contextOf('default'), (async () => ({ behavior: 'ask', message: 'nobody here' })) as never, assistant)
  check('a reason that claims the user asked, with no one to answer the card, is refused', (claimed as { data: { ok: boolean; code?: string } }).data.code === 'user-asked-rule', j(claimed))
  const cardContext = contextOf('default', { allow: ['Correct'] })
  const seen: Seen = { card: '', lines: [], asked: 0 }
  const allowRule = await CorrectTool.call({ op: 'retract', id: `seq:${seqA2}`, reason: 'an allow rule for Correct exists' }, cardContext, replDoor('no', 'rule-card-8-allow-rule', seen) as never, assistant)
  check('an allow rule for Correct does not answer the card: it is still put to the user (and no keeps the rule)', seen.asked === 1 && (allowRule as { data: { code?: string } }).data.code === 'user-kept-rule', j({ asked: seen.asked, allowRule }))
  const replace = await RetainTool.call({ items: [{ content: NEW_D, replaces: `seq:${seqA2}`, context: 'the user asked for this replacement' }] }, contextOf('default'), (async () => ({ behavior: 'ask', message: 'nobody here' })) as never, assistant)
  const replaced = (replace as { data: { outcomes: Array<{ status: string; reason?: string }> } }).data.outcomes[0]
  check('Retain replaces with no one to answer is refused, naming /memory', replaced?.status === 'refused' && (replaced.reason ?? '').includes('/memory'), j(replaced))
  check('nothing on disk changed through any of the claims', libraryBytes() === before && askedPin(seqA2))
}

section("§9 the cockpit's re-check after a mode change re-asks the card, never answers it")
{
  const seqA2 = seqOf(RULE_A)
  const input = { op: 'retract', id: `seq:${seqA2}`, reason: 'probe' }
  let recheck: { behavior?: string } = {}
  const probe = async (tool: unknown, toolInput: Record<string, unknown>, context: { getAppState: () => { toolPermissionContext: { mode: string } } }, message: unknown, id: string) => {
    context.getAppState().toolPermissionContext.mode = 'implement'
    recheck = (await decideToolPermissionWithModes(tool as never, toolInput, context as never, message as never, id)).decision as { behavior?: string }
    return { behavior: 'allow', updatedInput: { ...toolInput, [RULE_CARD_KEEP]: true } }
  }
  await CorrectTool.call(input as never, contextOf('default'), probe as never, assistant)
  check('the same card context under another asking mode still reads ask', recheck.behavior === 'ask', j(recheck))
}

section('§10 the words: the Correct and Retain descriptions, prompts and field say the road (the card; sovereign); the manual says it; no word still says the model is refused outright')
{
  const { CORRECT_DESCRIPTION, CORRECT_PROMPT, RETAIN_DESCRIPTION, RETAIN_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
  const { z } = await import('zod/v4')
  const retainSchema = JSON.stringify(z.toJSONSchema(RetainTool.inputSchema as never))
  const manual = readFileSync(join(REPO, 'docs/MNEME.md'), 'utf8')
  const { RECALL_DESCRIPTION, REFLECT_DESCRIPTION } = await import('../../src/tools/MemoryTools/prompt.ts')
  check('the four description() lines that the memory-rule card and the Fallback card print are unchanged from .36 (each one line, so printed whole)', RETAIN_DESCRIPTION === 'Store durable facts into project memory; a rule the user asks Mercury to remember about how to work with them is pinned in their words and on the shelf at once (a project convention about the code goes to the instruction file instead). Replacing a rule the user asked for puts a yes/no card to them first (under sovereign, no card). Per-item outcomes — a failed store is reported, never swallowed.' && CORRECT_DESCRIPTION === 'Correct project memory: supersede a fact with a new truth, amend its wording (after reading the full record), or retract it with a reason. A consolidated fact keeps its history; a pending row is a draft and is struck or replaced. A rule the user asked Mercury to remember changes only on their yes to a card (under sovereign, no card).' && RECALL_DESCRIPTION === 'Search project memory for pointers — facts, pinned rulings, the sessions of this project and the handoffs they left — each an id, a one-line title and footnotes (which session, which ruling, superseded by what). Read one full record by id.' && REFLECT_DESCRIPTION === 'Synthesize an answer over recalled memory with citations to the records used. Costs one model call; falls back to raw recall when synthesis cannot be grounded.')
  check('the Correct description: a rule the user asked for changes only on their yes to a card; under sovereign no card', CORRECT_DESCRIPTION.includes('A rule the user asked Mercury to remember changes only on their yes to a card (under sovereign, no card).'), CORRECT_DESCRIPTION)
  check('the Retain description: replacing a rule the user asked for puts a yes/no card first; under sovereign no card', RETAIN_DESCRIPTION.includes('Replacing a rule the user asked for puts a yes/no card to them first (under sovereign, no card).'), RETAIN_DESCRIPTION)
  check('the Correct prompt says the card, its two answers, sovereign, and the /memory road when no one can answer', CORRECT_PROMPT.includes("the tool puts one card to them with the rule's words as stored and what will happen") && CORRECT_PROMPT.includes('No returns "the user kept the rule" and nothing changes') && CORRECT_PROMPT.includes('Under the sovereign permission mode the op runs without the card') && CORRECT_PROMPT.includes('A session with no one to answer the card refuses') && /↵ opens the rule and c corrects it/.test(CORRECT_PROMPT), CORRECT_PROMPT)
  check('the Retain prompt says the card, sovereign, and the /memory road when no one can answer', RETAIN_PROMPT.includes('puts one yes/no card to the user') && RETAIN_PROMPT.includes('Under the sovereign permission mode it is replaced without the card') && RETAIN_PROMPT.includes('A session with no one to answer the card refuses') && /↵ opens the rule and c corrects it/.test(RETAIN_PROMPT), RETAIN_PROMPT)
  check('the replaces field says the card and sovereign', retainSchema.includes('the user answers a yes/no card first (under sovereign, no card)'), retainSchema.slice(retainSchema.indexOf('replaces'), retainSchema.indexOf('replaces') + 500))
  check('the manual says the card, its answers, sovereign and its mark in /memory, and the /memory road', manual.includes('it puts one\ncard to you first') && manual.includes('No\nkeeps the rule as it is') && manual.includes('Under the sovereign permission mode the change runs') && manual.includes('made from the chat under\nsovereign') && manual.includes('`↵` opens the rule and `c` corrects it'), manual.slice(manual.indexOf('A rule you asked for'), manual.indexOf('A rule you asked for') + 900))
  check('no word still says the model is refused outright on a rule the user asked for', !CORRECT_PROMPT.includes('every op on it is refused') && !RETAIN_PROMPT.includes('is never replaced by you') && !retainSchema.includes('Refused for a rule marked asked for by the user') && !manual.includes('the model cannot correct, replace or'))
}

section('§11 the daemon-hosted cockpit gets the same card: the reason survives the wire and routes to the memory card with the words verbatim')
{
  const { encodeDecisionReasonForWire, decodeDecisionReasonFromWire } = await import('../../src/utils/permissions/decisionReasonWire.ts')
  const { isMemoryRuleCard, memoryRuleCardText } = await import('../../src/components/permissions/MemoryRulePermissionRequest/MemoryRulePermissionRequest.tsx')
  const card = `Correct asks to change a rule you asked Mercury to remember.\nseq 9: "${RULE_B}"\nIt will be unpinned and struck; its wording is kept in history.`
  const decoded = decodeDecisionReasonFromWire(JSON.parse(JSON.stringify(encodeDecisionReasonForWire({ type: 'safetyCheck', reason: card, operatorOnly: true }))))
  const relayed = { permissionResult: { behavior: 'ask', message: 'Correct asks to run', ...(decoded === undefined ? {} : { decisionReason: decoded }) }, description: 'Correct asks to run' }
  check('the wire-encoded card reason decodes to the same operator-only reason', decoded?.type === 'safetyCheck' && decoded.reason === card && decoded.operatorOnly === true, j(decoded))
  check('the relayed card routes to the memory card and paints the words verbatim', isMemoryRuleCard(relayed as never) && memoryRuleCardText(relayed as never) === card)
  check('any other ask of Correct or Retain keeps the general card', !isMemoryRuleCard({ permissionResult: { behavior: 'ask', message: 'Using Correct requires approval', decisionReason: { type: 'other', reason: 'an ask rule' } } } as never))
}

console.log(`\nmemory rule card: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)

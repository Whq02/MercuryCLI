#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'drop-notice-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const binding = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { classifyThinkingDrops, describeThinkingDrops, prefixMarkOf, resetThinkingDropStates } = binding

type Entry = { type: string; path: string; reason: string }
type Block = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: 'sig-' + text })
const TEXT = (text: string): Block => ({ type: 'text', text })
let seq = 0
function user(content: Block[] | string): Record<string, unknown> {
  seq++
  return { type: 'user', uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content } }
}
function assistant(content: Block[]): Record<string, unknown> {
  seq++
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: '2026-09-01T00:00:00.000Z',
    requestId: `req_${seq}`,
    message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  }
}
const blocksOf = (m: unknown): Block[] => {
  const content = (m as { message?: { content?: unknown } } | undefined)?.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const hasThinking = (m: unknown): boolean => blocksOf(m).some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
const DROP = (path: string, reason = 'prefix_binding_mismatch'): Entry => ({ type: 'thinking_dropped', path, reason })
const mark = (over: Partial<ReturnType<typeof prefixMarkOf>> = {}): ReturnType<typeof prefixMarkOf> => ({
  firstRow: 'row-1',
  compactBoundary: null,
  modelTransition: null,
  rosterTransition: null,
  rosterChange: null,
  model: 'claude-fable-5-1',
  settings: 'mode=default;profile=balanced',
  thinkingClearActive: false,
  contextEditActive: false,
  ...over,
})

section('§1 the classifier')
{
  resetThinkingDropStates()
  const none = classifyThinkingDrops('main', [], mark())
  check('an empty list is no drop', none.kind === 'none' && none.count === 0, j(none))
  const first = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark())
  check('a drop after a no-drop response is a first drop (run 1)', first.kind === 'first' && first.consecutive === 1 && first.count === 1 && first.path === 'messages.1.content.0', j(first))
  const second = classifyThinkingDrops('main', [DROP('messages.1.content.0'), DROP('messages.3.content.0')], mark())
  check('a drop after a drop with unchanged marks is recurrent (run 2, the count is this response\'s)', second.kind === 'recurrent' && second.consecutive === 2 && second.count === 2, j(second))
  const third = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark())
  check('…and the run keeps counting (3)', third.kind === 'recurrent' && third.consecutive === 3, j(third))
  check('the first drop paints the one warning of its episode; no recurrent drop paints', first.paint === true && second.paint === false && third.paint === false, `${first.paint} ${second.paint} ${third.paint}`)
  check('…the words follow: a sentence for the first, null for every recurrent', (describeThinkingDrops([DROP('messages.1.content.0')], first) ?? '').includes('dropped 1 thinking block') && describeThinkingDrops([DROP('messages.1.content.0')], second) === null && describeThinkingDrops([DROP('messages.1.content.0')], third) === null)
  const fourth = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark())
  check('…and the run keeps counting for the ledger while nothing paints (4)', fourth.kind === 'recurrent' && fourth.consecutive === 4 && fourth.paint === false, j(fourth))
  const quiet = classifyThinkingDrops('main', [], mark())
  const again = classifyThinkingDrops('main', [DROP('messages.5.content.0')], mark())
  check('a no-drop response resets the run; the next drop is a first drop again', quiet.kind === 'none' && again.kind === 'first' && again.consecutive === 1, j(again))

  resetThinkingDropStates()
  classifyThinkingDrops('main', [], mark())
  const folded = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row' }))
  check('a drop after the first row moved (compaction) is lawful', folded.kind === 'lawful' && folded.lawful === 'compaction' && folded.consecutive === 1, j(folded))
  const boundary = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row', compactBoundary: 'cb-2' }))
  check('a drop after a new compact boundary is lawful too', boundary.kind === 'lawful' && boundary.lawful === 'compaction', j(boundary))
  const afterLawful = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row', compactBoundary: 'cb-2' }))
  check('a drop right after a lawful drop with unchanged marks is a first drop (the lawful one never counts toward a run)', afterLawful.kind === 'first' && afterLawful.consecutive === 1, j(afterLawful))
  const thenRecurrent = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row', compactBoundary: 'cb-2' }))
  check('…and the one after it is recurrent (2)', thenRecurrent.kind === 'recurrent' && thenRecurrent.consecutive === 2, j(thenRecurrent))

  resetThinkingDropStates()
  classifyThinkingDrops('main', [], mark())
  const switched = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ model: 'claude-opus-5' }))
  check('a drop after the model changed is a lawful model switch', switched.kind === 'lawful' && switched.lawful === 'model-switch', j(switched))
  const transition = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ model: 'claude-opus-5', modelTransition: 'mt-1' }))
  check('a drop after a new model-transition row is a lawful model switch', transition.kind === 'lawful' && transition.lawful === 'model-switch', j(transition))
  const modelBound = classifyThinkingDrops('main', [DROP('messages.1.content.0', 'model_binding_mismatch')], mark({ model: 'claude-opus-5', modelTransition: 'mt-1' }))
  check('a model-binding drop is a model switch by the API\'s reading, whatever the marks', modelBound.kind === 'lawful' && modelBound.lawful === 'model-switch' && modelBound.reason === 'model_binding_mismatch', j(modelBound))

  resetThinkingDropStates()
  classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark())
  const other = classifyThinkingDrops('agent:1', [DROP('messages.1.content.0')], mark())
  check('conversations are independent (another owner\'s first drop is a first drop)', other.kind === 'first' && other.consecutive === 1, j(other))
  const mainAgain = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark())
  check('…while the main conversation\'s run continues (2)', mainAgain.kind === 'recurrent' && mainAgain.consecutive === 2, j(mainAgain))

  const rows = [
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1' },
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'summary' } },
    { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [] } },
    { type: 'system', subtype: 'model_transition', uuid: 'mt-1' },
    { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'next' } },
  ]
  const m = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default', responseProfile: 'balanced' })
  check('prefixMarkOf reads the first conversation row, the newest boundary and transition rows, the model and the settings', j(m) === j({ firstRow: 'u-1', compactBoundary: 'cb-1', modelTransition: 'mt-1', rosterTransition: null, rosterChange: null, model: 'claude-fable-5-1', settings: 'mode=default;profile=balanced', thinkingClearActive: false, contextEditActive: false }), j(m))
  const ctxMark = prefixMarkOf(rows as never, 'claude-fable-5-1', { permissionMode: 'default' }, { thinkingClearActive: true, contextEditActive: true })
  check('prefixMarkOf carries the context-edit signals when the caller passes them', ctxMark.thinkingClearActive === true && ctxMark.contextEditActive === true, j(ctxMark))
  const bare = prefixMarkOf([] as never, 'claude-fable-5-1')
  check('an empty history marks nulls; an unreadable mode spells ?', bare.firstRow === null && bare.compactBoundary === null && bare.modelTransition === null && bare.settings.startsWith('mode=?;profile='), bare.settings)

  const { describeSettingsMove } = binding
  check('describeSettingsMove names the moved key with both values', describeSettingsMove('mode=default;profile=balanced', 'mode=apollo;profile=balanced') === 'the permission mode (default → apollo)')
  check('…two moved keys join', describeSettingsMove('mode=default;profile=balanced', 'mode=autopilot;profile=concise') === 'the permission mode (default → autopilot) and the response profile (balanced → concise)')
  check('…nothing moved ⇒ null; an unreadable side never fakes a move', describeSettingsMove('mode=default;profile=balanced', 'mode=default;profile=balanced') === null && describeSettingsMove('mode=?;profile=balanced', 'mode=default;profile=balanced') === null && describeSettingsMove('mode=default;profile=balanced', 'mode=?;profile=balanced') === null)
  resetThinkingDropStates()
  classifyThinkingDrops('main', [], mark())
  const modeMove = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ settings: 'mode=apollo;profile=balanced' }))
  check('a drop after the permission mode changed is a lawful operator-setting change naming the mode', modeMove.kind === 'lawful' && modeMove.lawful === 'operator-setting' && modeMove.detail === 'the permission mode (default → apollo)', j(modeMove))
  const profileMove = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ settings: 'mode=apollo;profile=concise' }))
  check('a drop after the response profile changed names the profile', profileMove.kind === 'lawful' && profileMove.detail === 'the response profile (balanced → concise)', j(profileMove))
  const stillApollo = classifyThinkingDrops('main', [DROP('messages.1.content.0')], mark({ settings: 'mode=apollo;profile=concise' }))
  check('…and a drop right after it with the settings unchanged is a first drop (the lawful one never seeds a run)', stillApollo.kind === 'first', j(stillApollo))
  const words = describeThinkingDrops([DROP('messages.1.content.0')], modeMove) ?? ''
  check('the words: "after you changed the permission mode (default → apollo) — the system prompt and the tool roster moved with it", expected once', words.includes('after you changed the permission mode (default → apollo)') && words.includes('the system prompt and the tool roster moved with it') && words.includes('expected once') && !words.includes('Mercury') && !words.includes('doctor'), words)

  const { declareLawfulPrefixChange, consumeLawfulPrefixChange, pendingLawfulPrefixChange, resetLawfulPrefixChanges } = await import('../../src/services/providers/lawfulPrefixChange.ts')
  resetLawfulPrefixChanges()
  resetThinkingDropStates()
  classifyThinkingDrops('seam', [], mark())
  declareLawfulPrefixChange('seam', 'sub-agents were turned on')
  check('a declaration is pending until the next response', pendingLawfulPrefixChange('seam') === 'sub-agents were turned on')
  const declaredDrop = classifyThinkingDrops('seam', [DROP('messages.1.content.0'), DROP('messages.3.content.0')], mark())
  check('a drop after a declared change is lawful and carries the clause (marks unchanged)', declaredDrop.kind === 'lawful' && declaredDrop.lawful === 'declared' && declaredDrop.detail === 'sub-agents were turned on', j(declaredDrop))
  check('…the declaration is consumed by that response', pendingLawfulPrefixChange('seam') === null && consumeLawfulPrefixChange('seam') === null)
  const declaredWords = describeThinkingDrops([DROP('messages.1.content.0'), DROP('messages.3.content.0')], declaredDrop) ?? ''
  check('the words: "after sub-agents were turned on — the system prompt and the tool roster moved with it", expected once', declaredWords.includes('dropped 2 thinking blocks after sub-agents were turned on') && declaredWords.includes('the system prompt and the tool roster moved with it') && declaredWords.includes('expected once') && !declaredWords.includes('Mercury'), declaredWords)
  const afterDeclared = classifyThinkingDrops('seam', [DROP('messages.1.content.0')], mark())
  check('the drop after it, nothing declared, is a first drop (the declared one never seeds a run)', afterDeclared.kind === 'first', j(afterDeclared))
  declareLawfulPrefixChange('seam', 'the workflow set changed')
  const quietResponse = classifyThinkingDrops('seam', [], mark())
  check('a declaration followed by a no-drop response is consumed silently', quietResponse.kind === 'none' && pendingLawfulPrefixChange('seam') === null)
  declareLawfulPrefixChange('seam', 'first clause')
  declareLawfulPrefixChange('seam', 'newest clause')
  check('a later declaration before the next response replaces the earlier clause', pendingLawfulPrefixChange('seam') === 'newest clause')
  const twoOwners = classifyThinkingDrops('other-owner', [DROP('messages.1.content.0')], mark())
  check('another conversation is untouched by the declaration', twoOwners.kind === 'first' && pendingLawfulPrefixChange('seam') === 'newest clause')
  resetLawfulPrefixChanges()
}

section('§1b Mercury\'s own context edits are named, not read as a rewrite')
{
  const { preservedThinkingHealth } = binding
  resetThinkingDropStates()
  classifyThinkingDrops('pruned', [], mark({ contextEditActive: true }))
  const pruned = classifyThinkingDrops('pruned', [DROP('messages.102.content.0')], mark({ contextEditActive: true }))
  check('a drop while a cleared tool result rides is lawful context-edited (not first/recurrent)', pruned.kind === 'lawful' && pruned.lawful === 'context-edited' && pruned.consecutive === 1, j(pruned))
  const prunedWords = describeThinkingDrops([DROP('messages.102.content.0')], pruned) ?? ''
  check('the words name the prune, say expected once, and never accuse Mercury of a rewrite', prunedWords.includes('pruned superseded tool results') && prunedWords.includes('expected once') && !prunedWords.includes('Mercury rewrote') && !prunedWords.includes('doctor'), prunedWords)
  const pruned2 = classifyThinkingDrops('pruned', [DROP('messages.102.content.0'), DROP('messages.104.content.0')], mark({ contextEditActive: true }))
  check('the next context-edit drop stays lawful, paints no second row, and never becomes a growing recurrent run', pruned2.kind === 'lawful' && pruned2.lawful === 'context-edited' && pruned2.paint === false && pruned2.consecutive === 1, j(pruned2))
  check('…and its words are null (painted once already)', describeThinkingDrops([DROP('messages.102.content.0')], pruned2) === null)

  resetThinkingDropStates()
  classifyThinkingDrops('both', [], mark({ contextEditActive: true }))
  const byteMoved = classifyThinkingDrops('both', [DROP('messages.1.content.0')], mark({ contextEditActive: true }), { byteMoved: true })
  check('a named byte move takes precedence over the context-edit reading', byteMoved.kind === 'first' && byteMoved.lawful === null, j(byteMoved))

  resetThinkingDropStates()
  classifyThinkingDrops('idle', [], mark({ thinkingClearActive: true }))
  const cleared = classifyThinkingDrops('idle', [DROP('messages.50.content.0')], mark({ thinkingClearActive: true }))
  check('a drop while the idle thinking-clear latch is armed is lawful thinking-cleared', cleared.kind === 'lawful' && cleared.lawful === 'thinking-cleared', j(cleared))
  const clearedWords = describeThinkingDrops([DROP('messages.50.content.0')], cleared) ?? ''
  check('the words name the idle clear and never accuse a rewrite', clearedWords.includes('cleared reasoning older than the last turn after an hour idle') && !clearedWords.includes('Mercury rewrote'), clearedWords)
  resetThinkingDropStates()
  classifyThinkingDrops('bothedits', [], mark({ thinkingClearActive: true, contextEditActive: true }))
  const bothEdits = classifyThinkingDrops('bothedits', [DROP('messages.1.content.0')], mark({ thinkingClearActive: true, contextEditActive: true }))
  check('a cleared tool result is named ahead of the idle latch when both are active', bothEdits.lawful === 'context-edited', j(bothEdits))

  const now = new Date().toISOString()
  const ctxHealth = preservedThinkingHealth({ last: { at: now, kind: 'lawful', lawful: 'context-edited', reason: 'prefix_binding_mismatch', path: 'messages.102.content.0', count: 3, consecutive: 1, model: 'claude-fable-5-1' }, longestRun: 0 })
  check('the doctor row for a context-edit drop is info and names the prune', ctxHealth.status === 'info' && ctxHealth.evidence.includes("Mercury's tool-result prune"), j(ctxHealth))
  const idleHealth = preservedThinkingHealth({ last: { at: now, kind: 'lawful', lawful: 'thinking-cleared', reason: 'prefix_binding_mismatch', path: 'messages.50.content.0', count: 2, consecutive: 1, model: 'claude-fable-5-1' }, longestRun: 0 })
  check('the doctor row for an idle-clear drop is info and names the idle-hour clear', idleHealth.status === 'info' && idleHealth.evidence.includes("Mercury's idle-hour thinking clear"), j(idleHealth))
}

section('§1c the count cannot fire the prune early — a session at 88% never prunes')
{
  const { getBlockingLimit, calculateTokenWarningState, getEffectiveContextWindowSize } = await import('../../src/services/compact/autoCompact.ts')
  const model = 'claude-fable-5-1'
  const window = getEffectiveContextWindowSize(model)
  const blockingLimit = getBlockingLimit(model)
  const at88 = calculateTokenWarningState(Math.round(window * 0.88), model).level
  check('the blocking limit sits below the full window (the manual-compact buffer)', blockingLimit < window && blockingLimit > 0, `limit=${blockingLimit} window=${window}`)
  check('a session at 88% of the window is NOT blocked — the overflow ladder never arms, so the pressure prune never fires and never rewrites', at88 !== 'blocked', `88%=${Math.round(window * 0.88)} level=${at88} limit=${blockingLimit}`)
  const atLimit = calculateTokenWarningState(blockingLimit + 1, model).level
  check('a session past the blocking limit IS blocked (the prune rung is reachable only there)', atLimit === 'blocked', `level=${atLimit}`)
}

section('§2 the words')
{
  resetThinkingDropStates()
  const list = [DROP('messages.1.content.0')]
  classifyThinkingDrops('w', [], mark())
  const lawful = describeThinkingDrops(list, classifyThinkingDrops('w', list, mark({ firstRow: 'summary-row' }))) ?? ''
  check('a single lawful drop is the one-line receipt naming compaction', lawful.startsWith('Preserved thinking: the API dropped 1 thinking block after the compaction') && lawful.includes('messages.1.content.0') && lawful.includes('expected once'), lawful)
  check('…with no Mercury blame, no doctor pointer', !lawful.includes('Mercury') && !lawful.includes('doctor'), lawful)
  const { createThinkingNoteMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const note = createThinkingNoteMessage(lawful)
  check('the lawful note is a thinking_note system row at info level (dim), carrying the sentence', note.type === 'system' && note.subtype === 'thinking_note' && note.level === 'info' && note.content === lawful, j(note))

  resetThinkingDropStates()
  classifyThinkingDrops('w', [], mark())
  const first = describeThinkingDrops(list, classifyThinkingDrops('w', list, mark())) ?? ''
  check('a first drop keeps the client-side-edit sentence', first === binding.describeInputTransformations(list), first)

  const two = [DROP('messages.1.content.0'), DROP('messages.3.content.0')]
  const recurrentOutcome = classifyThinkingDrops('w', two, mark())
  check('consecutive unlawful drops are recurrent (run 2) and paint nothing new', recurrentOutcome.kind === 'recurrent' && recurrentOutcome.consecutive === 2 && recurrentOutcome.paint === false && describeThinkingDrops(two, recurrentOutcome) === null, j(recurrentOutcome))
  check('…the doctor row, not the transcript, names Mercury, the run and the road', (() => { const h = binding.preservedThinkingHealth({ last: { at: 't', kind: 'recurrent', lawful: null, reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', count: 2, consecutive: 2, model: 'claude-fable-5-1' }, longestRun: 2 }); return h.status === 'warn' && h.evidence.includes('Mercury rewrote sent history on 2 consecutive requests') && (h.fix ?? '').includes('/issues') && (h.detail ?? '').includes('the first exchange changed') })())

  classifyThinkingDrops('w-deep', [DROP('messages.7.content.0')], mark())
  const deepOutcome = classifyThinkingDrops('w-deep', [DROP('messages.7.content.0')], mark())
  check('a later recurrent drop paints nothing; the doctor row names the earlier turn class for its path', describeThinkingDrops([DROP('messages.7.content.0')], deepOutcome) === null && (binding.preservedThinkingHealth({ last: { at: 't', kind: 'recurrent', lawful: null, reason: 'prefix_binding_mismatch', path: 'messages.7.content.0', count: 1, consecutive: 2, model: 'claude-fable-5-1' }, longestRun: 2 }).detail ?? '').includes('a turn before messages.7 changed, or the system prompt or the tools array'), j(deepOutcome))

  resetThinkingDropStates()
  classifyThinkingDrops('w', [], mark())
  const switched = describeThinkingDrops(list, classifyThinkingDrops('w', list, mark({ model: 'claude-opus-5' }))) ?? ''
  check('a prefix drop after a deliberate model switch names the switch, once', switched.includes('after the model switch') && switched.includes('expected once'), switched)
  const bound = [DROP('messages.1.content.0', 'model_binding_mismatch')]
  const boundWords = describeThinkingDrops(bound, classifyThinkingDrops('w', bound, mark({ model: 'claude-opus-5' }))) ?? ''
  check('a model-binding drop keeps the original switched-models sentence', boundWords === binding.describeInputTransformations(bound) && boundWords.includes('switched models'), boundWords)
  check('nothing dropped ⇒ nothing said', describeThinkingDrops([], classifyThinkingDrops('w', [], mark())) === null)
}

section('§2b the model-switch receipt — the previous model\'s thinking leaves quietly, once')
{
  const { isSameModel, modelSwitchReceipt } = binding
  const { stripThinkingFromOtherModels, thinkingFromOtherModels } = await import('../../src/utils/messages/apiFilters.ts')
  check('an alias, a suffix and a dated spelling of one model are the same model', isSameModel('claude-fable-5-1', 'claude-fable-5-1[1m]') && isSameModel('claude-opus-4-8', 'claude-opus-4-6') && isSameModel('claude-opus-5', 'claude-opus-5'))
  check('two families are not', !isSameModel('claude-opus-4-8', 'claude-fable-5-1') && !isSameModel('claude-opus-5', 'claude-fable-5-1'))
  const withModel = (row: Record<string, unknown>, model: string): Record<string, unknown> => ({ ...row, message: { ...(row.message as Record<string, unknown>), model } })
  const history = [
    user('one'),
    withModel(assistant([THINK('opus one'), TEXT('a')]), 'claude-opus-4-8'),
    user('two'),
    withModel(assistant([THINK('opus two')]), 'claude-opus-4-8'),
    user('three'),
    withModel(assistant([THINK('fable one'), TEXT('c')]), 'claude-fable-5-1'),
    user('four'),
  ]
  const foreign = thinkingFromOtherModels(history as never, 'claude-fable-5-1', isSameModel)
  check('the count and the writers of the foreign thinking', foreign.count === 2 && j(foreign.models) === j(['claude-opus-4-8']), j(foreign))
  const stripped = stripThinkingFromOtherModels(history as never, 'claude-fable-5-1', isSameModel) as unknown as Record<string, unknown>[]
  check('the previous model\'s thinking is stripped; its text stays', j(blocksOf(stripped[1]).map(b => b.type)) === j(['text']) && j(blocksOf(stripped[1])) === j([TEXT('a')]), j(blocksOf(stripped[1])))
  check('a thinking-only message keeps a placeholder text block', blocksOf(stripped[3]).length === 1 && blocksOf(stripped[3])[0]!.type === 'text' && String(blocksOf(stripped[3])[0]!.text).includes('another model'), j(blocksOf(stripped[3])))
  check('the current model\'s thinking stays, by reference', stripped[5] === history[5] && hasThinking(stripped[5]))
  check('user rows pass by reference; the input is never mutated', stripped[0] === history[0] && hasThinking(history[1]))
  const opusOnly = [history[0], history[1], history[2], history[3]]
  check('identity when every block is the current model\'s', stripThinkingFromOtherModels(opusOnly as never, 'claude-opus-4-8', isSameModel) === (opusOnly as never))
  const receipt = modelSwitchReceipt('main', history as never, 'claude-fable-5-1')
  check('the receipt names the count, the writer and the new model, and the switch', receipt !== null && receipt.text.includes('2 thinking blocks written by') && receipt.text.includes('stay out of the requests to') && receipt.text.includes('switched models'), j(receipt))
  check('…keyed by the owner and the new model\'s family (once per switch)', receipt !== null && receipt.key === 'main|claude-fable-5-1')
  check('…and never as a drop, never pointing at switching models', receipt !== null && !receipt.text.includes('dropped') && !/switch (the )?model/i.test(receipt.text))
  check('no foreign thinking ⇒ no receipt', modelSwitchReceipt('main', [history[0], history[1]] as never, 'claude-opus-4-8') === null)
}

section('§3 the ledger and the doctor row')
{
  const { recordThinkingDropLedger, readThinkingDropLedger, preservedThinkingHealth, thinkingDropLedgerPath } = binding
  check('no ledger ⇒ null', readThinkingDropLedger() === null)
  const empty = preservedThinkingHealth(null)
  check('no ledger ⇒ the ok row', empty.status === 'ok' && empty.evidence.includes('no dropped thinking block recorded'), j(empty))
  check('the ledger lives under the config home', thinkingDropLedgerPath() === join(process.env.MERCURY_CONFIG_DIR!, 'preserved-thinking.json'), thinkingDropLedgerPath())

  resetThinkingDropStates()
  classifyThinkingDrops('l', [], mark())
  const lawful = classifyThinkingDrops('l', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row' }))
  recordThinkingDropLedger(lawful, 'claude-fable-5-1')
  const l1 = readThinkingDropLedger()
  check('a lawful drop is recorded with its cause and no run', l1?.last.kind === 'lawful' && l1.last.lawful === 'compaction' && l1.last.path === 'messages.1.content.0' && l1.longestRun === 0, j(l1))
  const r1 = preservedThinkingHealth(l1)
  check('…and reads as an info row naming the compaction', r1.status === 'info' && r1.evidence.includes('after a compaction') && r1.evidence.includes('expected once'), j(r1))

  const first = classifyThinkingDrops('l', [DROP('messages.1.content.0')], mark({ firstRow: 'summary-row' }))
  recordThinkingDropLedger(first, 'claude-fable-5-1')
  const second = classifyThinkingDrops('l', [DROP('messages.1.content.0'), DROP('messages.3.content.0'), DROP('messages.5.content.0')], mark({ firstRow: 'summary-row' }))
  recordThinkingDropLedger(second, 'claude-fable-5-1')
  const l2 = readThinkingDropLedger()
  check('a recurrent drop is recorded with the run and the count', l2?.last.kind === 'recurrent' && l2.last.consecutive === 2 && l2.last.count === 3 && l2.longestRun === 2, j(l2))
  const r2 = preservedThinkingHealth(l2)
  check('…and reads as a warn row naming Mercury and the run', r2.status === 'warn' && r2.evidence.includes('Mercury rewrote sent history on 2 consecutive requests') && r2.evidence.includes('3 blocks') && r2.evidence.includes('prefix_binding_mismatch at messages.1.content.0'), j(r2))
  check('…with the block class and the longest run in the detail', (r2.detail ?? '').includes('the first exchange changed') && (r2.detail ?? '').includes('Longest run on this machine: 2'), j(r2))
  check('…and a paste-ready fix pointing at the bug-report road', (r2.fix ?? '').includes('https://github.com/example/mercury/issues') && (r2.fix ?? '').includes('mercury doctor --json'), j(r2))
  check('…never at switching models', !/switch/i.test(`${r2.evidence} ${r2.detail ?? ''} ${r2.fix ?? ''}`), j(r2))

  classifyThinkingDrops('l', [], mark({ firstRow: 'summary-row' }))
  recordThinkingDropLedger(classifyThinkingDrops('l', [], mark({ firstRow: 'summary-row' })), 'claude-fable-5-1')
  check('a no-drop response writes nothing (the last drop stays)', readThinkingDropLedger()?.last.kind === 'recurrent')
  const single = classifyThinkingDrops('l', [DROP('messages.9.content.0')], mark({ firstRow: 'summary-row' }))
  recordThinkingDropLedger(single, 'claude-fable-5-1')
  const l3 = readThinkingDropLedger()
  const r3 = preservedThinkingHealth(l3)
  check('a later single drop keeps the longest run and reads as info', l3?.last.kind === 'first' && l3.longestRun === 2 && r3.status === 'info' && r3.evidence.includes('a single drop'), j(r3))

  classifyThinkingDrops('ls', [], mark())
  const setting = classifyThinkingDrops('ls', [DROP('messages.1.content.0')], mark({ settings: 'mode=apollo;profile=balanced' }))
  recordThinkingDropLedger(setting, 'claude-fable-5-1')
  const ls = readThinkingDropLedger()
  const rs = preservedThinkingHealth(ls)
  check('an operator-setting drop is recorded with its detail and reads as an info row naming the setting', ls?.last.lawful === 'operator-setting' && ls.last.detail === 'the permission mode (default → apollo)' && rs.status === 'info' && rs.evidence.includes('a setting change (the permission mode (default → apollo))'), j(rs))
  const { declareLawfulPrefixChange: declareForLedger, resetLawfulPrefixChanges: resetForLedger } = await import('../../src/services/providers/lawfulPrefixChange.ts')
  classifyThinkingDrops('ld', [], mark())
  declareForLedger('ld', 'sub-agents were turned on')
  const declaredForLedger = classifyThinkingDrops('ld', [DROP('messages.1.content.0')], mark())
  recordThinkingDropLedger(declaredForLedger, 'claude-fable-5-1')
  const ld = readThinkingDropLedger()
  const rd = preservedThinkingHealth(ld)
  check('a declared-change drop is recorded with its clause and reads as an info row naming it', ld?.last.lawful === 'declared' && ld.last.detail === 'sub-agents were turned on' && rd.status === 'info' && rd.evidence.includes('a change you asked for (sub-agents were turned on)'), j(rd))
  resetForLedger()

  writeFileSync(thinkingDropLedgerPath(), '{not json')
  check('a corrupt ledger reads as null (the ok row), never a throw', readThinkingDropLedger() === null)
}

section('§4 the real doctor — the built artifact carries the row')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const findRow = (value: unknown): Record<string, unknown> | null => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const hit = findRow(item)
          if (hit !== null) return hit
        }
        return null
      }
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (record.id === 'preserved-thinking') return record
        for (const inner of Object.values(record)) {
          const hit = findRow(inner)
          if (hit !== null) return hit
        }
      }
      return null
    }
    const doctor = (home: string): Record<string, unknown> | null => {
      const configDir = join(home, '.mercury')
      mkdirSync(configDir, { recursive: true })
      const out = spawnSync(nodeBin, [DIST, 'doctor', '--json', '--only', 'preserved-thinking'], {
        cwd: home,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: configDir,
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_API_KEY: 'fixture-key-000',
        },
        encoding: 'utf8',
        timeout: 60_000,
      })
      const text = out.stdout.trim()
      try {
        return findRow(JSON.parse(text))
      } catch {
        console.log(`    doctor stdout: ${text.slice(0, 300)} stderr: ${out.stderr.slice(0, 300)}`)
        return null
      }
    }
    const cleanHome = mkdtempSync(join(tmpdir(), 'drop-notice-doctor-clean-'))
    const clean = doctor(cleanHome)
    check('a clean machine: the row is present and ok', clean !== null && clean.status === 'ok' && String(clean.evidence).includes('no dropped thinking block recorded'), j(clean))

    const stagedHome = mkdtempSync(join(tmpdir(), 'drop-notice-doctor-staged-'))
    mkdirSync(join(stagedHome, '.mercury'), { recursive: true })
    writeFileSync(join(stagedHome, '.mercury', 'preserved-thinking.json'), j({
      last: { at: '2026-09-02T12:00:00.000Z', kind: 'recurrent', lawful: null, reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', count: 21, consecutive: 4, model: 'claude-fable-5-1' },
      longestRun: 4,
    }))
    const staged = doctor(stagedHome)
    check('a staged recurrent ledger: the row warns, names Mercury, the run, the count and the path', staged !== null && staged.status === 'warn' && String(staged.evidence).includes('Mercury rewrote sent history on 4 consecutive requests') && String(staged.evidence).includes('21 blocks') && String(staged.evidence).includes('messages.1.content.0'), j(staged))
    check('…with the bug-report road in the fix and the block class in the detail', staged !== null && String(staged.fix ?? '').includes('/issues') && String(staged.detail ?? '').includes('the first exchange changed'), j(staged))
    const label = staged !== null ? String(staged.label) : ''
    check('…under the label a tester can find', label === 'Preserved thinking', label)
    if (staged !== null && existsSync(join(stagedHome, '.mercury', 'preserved-thinking.json'))) {
      check('the doctor never rewrites the ledger', readFileSync(join(stagedHome, '.mercury', 'preserved-thinking.json'), 'utf8').includes('"consecutive":4'))
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ THINKING DROP NOTICE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} THINKING DROP NOTICE FAILURE(S) (${checks} checks)`)
process.exit(1)

#!/usr/bin/env bun
// ============================================================================
//  prove-brief-filters — the brief-mode transcript filters + the trailing-
//  recap detector (the REAL functions, via the bun-loadable leaf
//  src/utils/messages/briefFilters.ts).
//
//  The headline regression this locks:
//  in brief-only mode a turn whose model NEVER called
//  SendUserMessage rendering NOTHING — the operator's "reply with test 1"
//  vanishes. The renderer-side fallback keeps a briefless turn's plain text;
//  brief turns keep the clean single-surface look. Also locks the trailing-
//  recap detector the stop hook teaches from, and the once-per-session wiring.
// ============================================================================
import { readFileSync } from 'node:fs'
import {
  dropTextInBriefTurns,
  filterForBriefTool,
  hasTrailingTextAfterBrief,
} from '../../src/utils/messages/briefFilters.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const BRIEF = 'SendUserMessage'
const NAMES = [BRIEF, 'Brief']

type M = {
  id: string
  type: string
  subtype?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  message?: { content: Array<{ type: string; name?: string; tool_use_id?: string; text?: string; id?: string }> }
  attachment?: { type: string; isMeta?: boolean; origin?: unknown; commandMode?: string }
}
const user = (id: string, text: string, isMeta = false): M => ({
  id,
  type: 'user',
  isMeta,
  message: { content: [{ type: 'text', text }] },
})
const aText = (id: string, text: string): M => ({
  id,
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const aTool = (id: string, name: string, toolId = `tu_${id}`): M => ({
  id,
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, id: toolId }] },
})
const toolResult = (id: string, toolUseId: string): M => ({
  id,
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
})
const ids = (ms: M[]): string => ms.map(m => m.id).join(',')

console.log('— the swallowed-first-reply fallback (brief-only view) —')
// Turn 1: briefless plain-text reply (the swallowed-reply shape). Turn 2: a proper
// brief turn with interim narration + a work tool call.
const corpus: M[] = [
  user('u1', 'reply with test 1'),
  aText('a1', 'test 1'), // ← used to vanish
  user('u2', 'now do work'),
  aText('a2', 'working on it'), // interim narration in a brief turn — folds away
  aTool('a3', 'Bash'), // work noise — never shown in brief view
  toolResult('r3', 'tu_a3'),
  aTool('a4', BRIEF), // the reply surface
  toolResult('r4', 'tu_a4'),
  aText('a5', 'STATUS: done'), // trailing recap — hidden in brief view too
]
const brief = filterForBriefTool(corpus, NAMES)
t('briefless turn keeps its plain text (the fix)', brief.some(m => m.id === 'a1'), ids(brief))
t('brief turn folds interim narration away', !brief.some(m => m.id === 'a2'))
t('work tool calls stay hidden', !brief.some(m => m.id === 'a3') && !brief.some(m => m.id === 'r3'))
t('the Brief call + its result stay', brief.some(m => m.id === 'a4') && brief.some(m => m.id === 'r4'))
t('trailing recap text stays hidden in the brief view', !brief.some(m => m.id === 'a5'))
t('real user input stays', brief.some(m => m.id === 'u1') && brief.some(m => m.id === 'u2'))

console.log('— fallback boundaries —')
const metaNag = user('meta1', 'You ended the turn without calling SendUserMessage.', true)
const afterNag: M[] = [
  user('u1', 'reply with test 1'),
  aText('a1', 'test 1'),
  metaNag, // the enforce nag is META — must NOT open a new turn
  aTool('a2', BRIEF),
]
const healed = filterForBriefTool(afterNag, NAMES)
t('a meta nag is not a turn boundary — the late Brief call folds the interim text', !healed.some(m => m.id === 'a1') && healed.some(m => m.id === 'a2'))
const whitespaceOnly: M[] = [user('u1', 'hi'), aText('a1', '  \n ')]
t('whitespace-only text is not promoted', !filterForBriefTool(whitespaceOnly, NAMES).some(m => m.id === 'a1'))
const apiErr: M[] = [user('u1', 'hi'), { ...aText('a1', 'boom'), isApiErrorMessage: true }, aTool('a2', BRIEF)]
t('API errors stay visible even in brief turns', filterForBriefTool(apiErr, NAMES).some(m => m.id === 'a1'))
const sys: M[] = [
  { id: 's1', type: 'system', subtype: 'info' },
  { id: 's2', type: 'system', subtype: 'api_metrics' },
]
const sysOut = filterForBriefTool(sys, NAMES)
t('system stays, api_metrics drops', sysOut.some(m => m.id === 's1') && !sysOut.some(m => m.id === 's2'))

console.log('— dropTextInBriefTurns (default view) unchanged semantics —')
const dropped = dropTextInBriefTurns(corpus, NAMES)
t('briefless turn text kept', dropped.some(m => m.id === 'a1'))
t('brief-turn narration + trailing recap dropped', !dropped.some(m => m.id === 'a2') && !dropped.some(m => m.id === 'a5'))
t('tool calls/results kept', dropped.some(m => m.id === 'a3') && dropped.some(m => m.id === 'r3') && dropped.some(m => m.id === 'a4'))
t('no brief anywhere ⇒ identity', dropTextInBriefTurns([user('u1', 'x'), aText('a1', 'y')], NAMES).length === 2)

console.log('— the trailing-recap detector —')
t('detects text AFTER the Brief call', hasTrailingTextAfterBrief([aTool('a1', BRIEF), aText('a2', 'STATUS: done')], NAMES))
t('narration BEFORE the call is fine', !hasTrailingTextAfterBrief([aText('a1', 'working…'), aTool('a2', BRIEF)], NAMES))
t('no Brief call ⇒ false (scribe-bus-satisfied turns self-guard)', !hasTrailingTextAfterBrief([aText('a1', 'plain reply')], NAMES))
t('whitespace after the call is not a recap', !hasTrailingTextAfterBrief([aTool('a1', BRIEF), aText('a2', '  ')], NAMES))
t('LAST call wins (text between two calls is not trailing)', !hasTrailingTextAfterBrief([aTool('a1', BRIEF), aText('a2', 'mid'), aTool('a3', BRIEF)], NAMES))
// Mixed-block message: [tool_use, text] in ONE assistant message.
const mixed: M = {
  id: 'mx',
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: BRIEF, id: 'tu_mx' }, { type: 'text', text: 'recap' }] },
}
t('same-message trailing block detected', hasTrailingTextAfterBrief([mixed], NAMES))

console.log('— wiring —')
const messages = readFileSync('src/components/Messages.tsx', 'utf8')
t('Messages.tsx imports the leaf (no local copies)', messages.includes("from '../utils/messages/briefFilters.js'") && !messages.includes('export function filterForBriefTool'))
const stop = readFileSync('src/query/stopHooks.ts', 'utf8')
t('stop hook wires the recap sentinel', stop.includes('briefFilters.hasTrailingTextAfterBrief(window)'))
t('recap teaching is once-per-session (history-scan guard)', stop.includes('!hasMetaMessageContaining(history, briefPrompt.BRIEF_RECAP_SENTINEL)'))
const prompt = readFileSync('src/tools/BriefTool/prompt.ts', 'utf8')
t('recap sentinel + teaching authored in prompt.ts', prompt.includes('BRIEF_RECAP_SENTINEL') && prompt.includes('getBriefRecapText'))
t('enforce text no longer overclaims (fallback honesty)', !prompt.includes('plain assistant text is hidden from the user'))

console.log(failures ? '\n❌ BRIEF-FILTERS RED' : '\n✅ BRIEF-FILTERS GREEN')
process.exit(failures)
